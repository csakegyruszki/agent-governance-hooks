'use strict';
// Regression cases for scripts/completion-gate.js. Cases labelled (synthetic) are constructed
// inputs in temp directories; the shipped examples/tickets files are used where a realistic
// ticket is wanted. Check commands run with this Node binary, so nothing external is needed
// except a Python interpreter for tools/tickets.py (the suite is skipped if none is found).

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'completion-gate.js');
const TICKETS_PY = path.join(__dirname, '..', 'tools', 'tickets.py');
const EXAMPLES = path.join(__dirname, '..', 'examples', 'tickets');

function findPython() {
  for (const c of [process.env.GUARDRAIL_PYTHON, 'python3', 'python']) {
    if (!c) continue;
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return c;
  }
  return null;
}
const PY = findPython();
const skip = PY ? false : 'no Python 3 on PATH';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-'));
const AUDIT = path.join(TMP, 'audit.jsonl');
const NODE = `"${process.execPath}"`;
const GREEN = `${NODE} -e "process.exit(0)"`;
const RED = `${NODE} -e "process.exit(3)"`;

let n = 0;
function freshDir() { // <tmp>/caseN/tickets
  const d = path.join(TMP, `case${++n}`, 'tickets');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function ticketText(id, status, checks) {
  return `---\nid: ${id}\ntitle: t\nworkspace: w\nstatus: ${status}\ndate: 2026-10-01\n` +
    (checks ? `checks: ${checks}\n` : '') + `---\n\n**Where we left off:** x\n`;
}
function writeTicket(dir, id, status, checks) {
  const f = path.join(dir, `${id}-t.md`);
  fs.writeFileSync(f, ticketText(id, status, checks));
  return f;
}
function verify(dir, id) {
  const r = spawnSync(PY, [TICKETS_PY, '--tickets-dir', dir, '--verify', id], { encoding: 'utf8' });
  return r.status;
}
function gate(toolInput, env = {}, tool = 'Write') {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput }), encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: AUDIT, GUARDRAIL_FAIL_CLOSED: '',
      GUARDRAIL_TICKETS_DIR: '', GUARDRAIL_PYTHON: PY || '', ...env },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const o = JSON.parse(res.stdout);
  const h = o.hookSpecificOutput || {};
  return { decision: h.permissionDecision || 'allow', reason: h.permissionDecisionReason || '' };
}
function auditLines() {
  try { return fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (_) { return []; }
}

test('non-ticket files and non-done writes are allowed (synthetic)', { skip }, () => {
  const d = freshDir();
  assert.strictEqual(gate({ file_path: path.join(d, 'notes.md'), content: 'status: done\n' }).decision, 'allow');
  assert.strictEqual(gate({ file_path: path.join(TMP, 'T-0001-x.md'), content: 'status: done\n' }).decision, 'allow',
    'ticket-named file outside a tickets dir is not gated');
  const f = path.join(d, 'T-0001-t.md');
  assert.strictEqual(gate({ file_path: f, content: ticketText('T-0001', 'open', GREEN) }).decision, 'allow');
});

test('done without evidence is denied (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  const r = gate({ file_path: f, old_string: 'status: open', new_string: 'status: done' }, {}, 'Edit');
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /no evidence/);
});

test('done with fresh passing evidence is allowed (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  assert.strictEqual(verify(d, 'T-0001'), 0);
  assert.strictEqual(gate({ file_path: f, old_string: 'status: open', new_string: 'status: done' }, {}, 'Edit').decision, 'allow');
  assert.strictEqual(gate({ file_path: f, content: ticketText('T-0001', 'done', GREEN) }).decision, 'allow');
});

test('failing evidence is denied (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', RED);
  assert.strictEqual(verify(d, 'T-0001'), 1);
  const r = gate({ file_path: f, old_string: 'status: open', new_string: 'status: done' }, {}, 'Edit');
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /FAILED/);
});

test('stale evidence (> 24 h) is denied (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  verify(d, 'T-0001');
  const p = path.join(d, 'evidence', 'T-0001.json');
  const ev = JSON.parse(fs.readFileSync(p, 'utf8'));
  ev.verified_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  fs.writeFileSync(p, JSON.stringify(ev));
  const r = gate({ file_path: f, old_string: 'status: open', new_string: 'status: done' }, {}, 'Edit');
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /stale/);
});

test('a check added after the green run is denied (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  verify(d, 'T-0001');
  fs.writeFileSync(f, ticketText('T-0001', 'open', `${GREEN} ;; ${NODE} -e "0"`));
  const r = gate({ file_path: f, old_string: 'status: open', new_string: 'status: done' }, {}, 'Edit');
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /did NOT run/);
});

test('Write that changes `checks:` and sets done at once is denied (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN); // disk has real checks and no evidence
  for (const checks of ['none - docs only change', 'none', `${GREEN} ;; ${NODE} -e "0"`]) {
    const r = gate({ file_path: f, content: ticketText('T-0001', 'done', checks) });
    assert.strictEqual(r.decision, 'deny', checks);
    assert.match(r.reason, /separate edit/);
  }
});

test('a new ticket file written directly as done is judged on its own content (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = path.join(d, 'T-0005-new.md');
  assert.strictEqual(gate({ file_path: f, content: ticketText('T-0005', 'done', 'none - docs only change') }).decision, 'allow');
  assert.strictEqual(gate({ file_path: f, content: ticketText('T-0005', 'done', GREEN) }).decision, 'deny');
});

test('Edit that changes checks and sets done together is denied (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  const r = gate({ file_path: f, old_string: 'status: open', new_string: 'checks: none - sneaky\nstatus: done' }, {}, 'Edit');
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /separate edit/);
});

test('bypass: Edit of just the word open -> done is judged on the reconstructed file (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  const r = gate({ file_path: f, old_string: 'open', new_string: 'done' }, {}, 'Edit');
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /no evidence/);
  // replace_all and MultiEdit take the same route
  assert.strictEqual(gate({ file_path: f, old_string: 'open', new_string: 'done', replace_all: true }, {}, 'Edit').decision, 'deny');
  assert.strictEqual(gate({ file_path: f, edits: [{ old_string: 'op', new_string: 'x' }, { old_string: 'xen', new_string: 'done' }] },
    {}, 'MultiEdit').decision, 'deny');
});

test('status spellings: no space, quotes, case, block scalar are all treated as done (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  for (const line of ['status:done', 'status: "done"', "status: 'done'", 'Status: Done', 'STATUS: DONE # closed',
    'status: >-\n  done', 'status: |\n  done\n', '  status: done']) {
    const content = ticketText('T-0001', 'open', GREEN).replace('status: open', line);
    const r = gate({ file_path: f, content });
    assert.strictEqual(r.decision, 'deny', JSON.stringify(line));
    assert.match(r.reason, /no evidence/);
  }
});

test('only the frontmatter counts: a body `status: done` is neither a trigger nor a status (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  // Write adding only a body line: still open -> allowed
  const body = ticketText('T-0001', 'open', GREEN) + '\nstatus: done\n';
  assert.strictEqual(gate({ file_path: f, content: body }).decision, 'allow');
  // Edit that adds a body line
  assert.strictEqual(gate({ file_path: f, old_string: 'x', new_string: 'x\nstatus: done' }, {}, 'Edit').decision, 'allow');
  // a body line on disk does not make the ticket "already done"
  fs.writeFileSync(f, ticketText('T-0001', 'open', GREEN) + '\nstatus: done\n');
  assert.strictEqual(gate({ file_path: f, old_string: 'status: open', new_string: 'status: done' }, {}, 'Edit').decision, 'deny');
});

test('an Edit/MultiEdit that removes `checks:` while closing is denied (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', 'true');
  const r1 = gate({ file_path: f, old_string: 'checks: true\n', new_string: '' }, {}, 'Edit');
  assert.strictEqual(r1.decision, 'allow', 'removing checks alone does not close anything');
  const r2 = gate({ file_path: f, edits: [{ old_string: 'status: open', new_string: 'status: done' },
    { old_string: 'checks: true\n', new_string: '' }] }, {}, 'MultiEdit');
  assert.strictEqual(r2.decision, 'deny');
  assert.match(r2.reason, /separate edit/);
});

test('evidence copied from another ticket is rejected (synthetic)', { skip }, () => {
  const d = freshDir();
  writeTicket(d, 'T-0001', 'open', GREEN);
  const f2 = writeTicket(d, 'T-0002', 'open', GREEN);
  assert.strictEqual(verify(d, 'T-0001'), 0);
  fs.copyFileSync(path.join(d, 'evidence', 'T-0001.json'), path.join(d, 'evidence', 'T-0002.json'));
  const r = gate({ file_path: f2, old_string: 'status: open', new_string: 'status: done' }, {}, 'Edit');
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /belongs to ticket/);
});

test('Write/Edit/MultiEdit of files under tickets/evidence/ is denied; escape hatch does not apply (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  assert.strictEqual(verify(d, 'T-0001'), 0);
  const ev = path.join(d, 'evidence', 'T-0001.json');
  const forged = JSON.stringify({ ticket: 'T-0001', verified_at: new Date().toISOString(), checks: [{ command: GREEN, exit_code: 0 }] });
  assert.strictEqual(gate({ file_path: ev, content: forged }).decision, 'deny');
  assert.strictEqual(gate({ file_path: ev, old_string: '"exit_code": 0', new_string: '"exit_code": 0' }, {}, 'Edit').decision, 'deny');
  assert.strictEqual(gate({ file_path: ev, edits: [{ old_string: 'a', new_string: 'b' }] }, {}, 'MultiEdit').decision, 'deny');
  assert.strictEqual(gate({ file_path: path.join(d, 'evidence', 'new.json'),
    content: 'guardrail:confirmed reason="trust me, really"' }).decision, 'deny');
  assert.strictEqual(gate({ file_path: path.join(d, 'evidence', 'sub', 'x.json'), content: '{}' }).decision, 'deny');
  assert.strictEqual(gate({ file_path: path.join(TMP, 'other', 'evidence', 'x.json'), content: '{}' }).decision, 'allow',
    'an evidence folder that is not under a tickets dir is not ours');
  assert.ok(f);
});

test('escape hatch: marker with a reason allows and is audit-logged; short reason does not (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  const before = auditLines().length;
  const body = ticketText('T-0001', 'done', GREEN) + '\nguardrail:confirmed reason="closed by hand, CI covers it"\n';
  assert.strictEqual(gate({ file_path: f, content: body }).decision, 'allow');
  const added = auditLines().slice(before);
  assert.ok(added.some((e) => e.hook === 'completion-gate' && e.event === 'bypass' && e.ticket === 'T-0001'));
  const weak = ticketText('T-0001', 'done', GREEN) + '\nguardrail:confirmed reason="ok"\n';
  assert.strictEqual(gate({ file_path: f, content: weak }).decision, 'deny');
});

test('a ticket that is already done is not re-gated (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'done', GREEN);
  assert.strictEqual(gate({ file_path: f, old_string: 'x', new_string: 'y\nstatus: done' }, {}, 'Edit').decision, 'allow');
});

test('Python missing: fail-open with audit event; denied under GUARDRAIL_FAIL_CLOSED=1 (synthetic)', { skip }, () => {
  const d = freshDir();
  const f = writeTicket(d, 'T-0001', 'open', GREEN);
  const input = { file_path: f, old_string: 'status: open', new_string: 'status: done' };
  const before = auditLines().length;
  assert.strictEqual(gate(input, { GUARDRAIL_PYTHON: path.join(TMP, 'no-such-python') }, 'Edit').decision, 'allow');
  assert.ok(auditLines().slice(before).some((e) => e.event === 'no-verdict'));
  const r = gate(input, { GUARDRAIL_PYTHON: path.join(TMP, 'no-such-python'), GUARDRAIL_FAIL_CLOSED: '1' }, 'Edit');
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /GUARDRAIL_FAIL_CLOSED=1, so closing is blocked/, 'a real verdict-less deny, not an internal-error deny');
  assert.ok(!auditLines().slice(before).some((e) => e.hook === 'completion-gate' && e.event === 'error'));
});

test('GUARDRAIL_TICKETS_DIR selects the gated directory (synthetic)', { skip }, () => {
  const custom = path.join(TMP, 'work-items');
  fs.mkdirSync(custom, { recursive: true });
  const f = writeTicket(custom, 'T-0001', 'open', GREEN);
  const input = { file_path: f, old_string: 'status: open', new_string: 'status: done' };
  assert.strictEqual(gate(input, {}, 'Edit').decision, 'allow', 'dir not named tickets: not gated by default');
  assert.strictEqual(gate(input, { GUARDRAIL_TICKETS_DIR: custom }, 'Edit').decision, 'deny');
  const other = freshDir();
  const g = writeTicket(other, 'T-0002', 'open', GREEN);
  assert.strictEqual(gate({ file_path: g, old_string: 'status: open', new_string: 'status: done' },
    { GUARDRAIL_TICKETS_DIR: custom }, 'Edit').decision, 'allow', 'other dirs are not gated when the env is set');
});

test('shipped example ticket: denied before --verify, allowed after (example)', { skip }, () => {
  const d = freshDir();
  for (const f of fs.readdirSync(EXAMPLES)) fs.copyFileSync(path.join(EXAMPLES, f), path.join(d, f));
  const f = path.join(d, 'T-0001-add-retry-to-importer.md');
  const input = { file_path: f, old_string: 'status: open', new_string: 'status: done' };
  assert.strictEqual(gate(input, {}, 'Edit').decision, 'deny');
  assert.strictEqual(verify(d, 'T-0001'), 0);
  assert.strictEqual(gate(input, {}, 'Edit').decision, 'allow');
});

test('malformed hook input fails open (synthetic)', () => {
  const res = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: AUDIT, GUARDRAIL_FAIL_CLOSED: '' } });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '{}');
});
