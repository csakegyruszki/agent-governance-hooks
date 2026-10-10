'use strict';
// Tests for scripts/return-contract.js.
//
// The spec is the real shipped file docs/contracts/subagent-return-v1.md (the INJECT block is read
// from it at runtime, and the validator is checked against the JSON example in it). Subagent
// transcripts are synthetic JSONL files shaped after the real format (one JSON object per line,
// message.role / message.content, tool_use blocks). The audit log is redirected to a temp file.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'return-contract.js');
const SPEC = path.join(__dirname, '..', 'docs', 'contracts', 'subagent-return-v1.md');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
const LOG = path.join(TMP, 'audit.jsonl');
process.env.GUARDRAIL_AUDIT_LOG = LOG;
const { validate, SENTINEL } = require(HOOK);

function run(input, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: LOG, ...env },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout || '{}');
}
const rows = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.hook === 'return-contract')
  : []);
const rowsFor = (id) => rows().filter((r) => r.agent_id === id);

const spec = fs.readFileSync(SPEC, 'utf8');
const inject = /<!-- INJECT-BEGIN -->\r?\n([\s\S]*?)\r?\n<!-- INJECT-END -->/.exec(spec)[1];
const FENCE = '`'.repeat(3);
const block = new RegExp(FENCE + 'json\\s*\\r?\\n([\\s\\S]*?)' + FENCE).exec(spec.slice(spec.indexOf('<!-- INJECT-BEGIN -->')))[1];
const EXAMPLE = JSON.parse(block.replace(/"(DONE \| PARTIAL \| BLOCKED \| FAILED)"/, '"DONE"').replace(/"read \| measured \| inferred"/, '"read"'));
const wrap = (o) => 'Short prose.\n' + FENCE + 'json\n' + JSON.stringify(o, null, 2) + '\n' + FENCE + '\n';

// A subagent transcript. requested=true puts the sentinel into the first user message (what the
// hook writes into the prompt); handback=true adds a SubagentHandback tool_use.
function transcript(name, { requested, handback = false, quoteOnly = false }) {
  const prompt = requested ? 'Do the task.\nRETURN: contract-v1\n\n' + SENTINEL + '\n' + inject
    : quoteOnly ? 'Explain this text:\nRETURN: contract-v1\n(' + inject.slice(0, 40) + ')' : 'Do the task.';
  const lines = [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }];
  lines.push({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } });
  if (handback) lines.push({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'SubagentHandback', input: {} }] } });
  const f = path.join(TMP, name + '.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const handbackEv = (id, file, message, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', session_id: 's1',
  agent_id: id, agent_type: 'general-purpose', agent_transcript_path: file, tool_input: { message }, ...extra });
const stopEv = (id, file, message, extra = {}) => ({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: id,
  agent_type: 'general-purpose', agent_transcript_path: file, last_assistant_message: message, stop_hook_active: false, ...extra });
const denied = (o) => (o.hookSpecificOutput || {}).permissionDecision === 'deny';

test('Agent/Task with the opt-in line: prompt = original + sentinel + INJECT block of the spec', () => {
  const input = { description: 'x', subagent_type: 'general-purpose', model: 'sonnet', prompt: 'Do the thing.\nRETURN: contract-v1\nbye' };
  for (const tool of ['Agent', 'Task']) {
    const out = run({ hook_event_name: 'PreToolUse', tool_name: tool, session_id: 's', tool_input: input }).hookSpecificOutput;
    assert.strictEqual(out.permissionDecision, 'allow');
    assert.strictEqual(out.hookEventName, 'PreToolUse');
    assert.strictEqual(out.updatedInput.prompt, input.prompt + '\n\n' + SENTINEL + '\n' + inject);
    assert.strictEqual(out.updatedInput.description, 'x');
    assert.strictEqual(out.updatedInput.model, 'sonnet');
    assert.strictEqual(out.updatedInput.subagent_type, 'general-purpose');
  }
});

test('Agent/Task without the line, with the line only mid-sentence, or already injected: untouched', () => {
  const pre = (prompt) => run({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt } });
  assert.deepStrictEqual(pre('no marker'), {});
  assert.deepStrictEqual(pre('Please add RETURN: contract-v1 somewhere maybe'), {});
  assert.deepStrictEqual(pre('x\nRETURN: contract-v1\n\n' + SENTINEL + '\n' + inject), {});
});

test('missing spec file: {} and an error row', () => {
  const o = run({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'a\nRETURN: contract-v1' } },
    { GUARDRAIL_RETURN_CONTRACT_SPEC: path.join(TMP, 'no-such-spec.md') });
  assert.deepStrictEqual(o, {});
  assert.ok(rows().some((r) => r.event === 'error' && /INJECT|no-such-spec/.test(r.error)));
});

test('validator: the spec example with valid enums is valid; each required key is reported', () => {
  assert.strictEqual(EXAMPLE.status, 'DONE');
  assert.deepStrictEqual(validate(wrap(EXAMPLE)), []);
  for (const k of ['contract', 'status', 'summary', 'findings', 'not_measured']) {
    const o = { ...EXAMPLE }; delete o[k];
    const p = validate(wrap(o));
    assert.strictEqual(p.length, 1, k);
    assert.ok(p[0].includes(k), p[0]);
  }
  for (const k of ['artifacts', 'checks', 'deviations']) {
    const o = { ...EXAMPLE }; delete o[k];
    assert.deepStrictEqual(validate(wrap(o)), [], k);
  }
});

test('validator: evidence rule, last block wins, no block, bad JSON, wrong types', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE)); delete bad.findings[0].evidence;
  assert.ok(validate(wrap(bad)).some((x) => x.includes('evidence')));
  bad.findings[0].basis = 'inferred';
  assert.deepStrictEqual(validate(wrap(bad)), []);
  assert.strictEqual(validate('no block').length, 1);
  assert.ok(validate(wrap(EXAMPLE) + wrap({ contract: 'v2' })).length > 0, 'the LAST block is the one checked');
  assert.deepStrictEqual(validate(wrap({ contract: 'v2' }) + wrap(EXAMPLE)), []);
  assert.match(validate(FENCE + 'json\n{nope\n' + FENCE)[0], /does not parse/);
  assert.ok(validate(wrap({ ...EXAMPLE, status: 'MAYBE' })).some((x) => x.includes('status must be')));
  assert.ok(validate(wrap({ ...EXAMPLE, findings: 'x' })).some((x) => x.includes('findings must be an array')));
  assert.ok(validate(wrap({ ...EXAMPLE, checks: 'x' })).some((x) => x.includes('checks must be an array')));
});

test('validator: domain rules for DONE and non-DONE statuses', () => {
  const ex = { ...EXAMPLE, not_measured: [], deviations: [] };
  assert.deepStrictEqual(validate(wrap(ex)), []);
  const noF = validate(wrap({ ...ex, findings: [] }));
  assert.strictEqual(noF.length, 1);
  assert.match(noF[0], /DONE requires at least one finding/);
  for (const st of ['PARTIAL', 'BLOCKED', 'FAILED']) {
    const bare = validate(wrap({ ...ex, status: st }));
    assert.strictEqual(bare.length, 1, st);
    assert.match(bare[0], /not_measured or deviations/);
    assert.deepStrictEqual(validate(wrap({ ...ex, status: st, not_measured: ['why not'] })), []);
    assert.deepStrictEqual(validate(wrap({ ...ex, status: st, deviations: ['why'] })), []);
    assert.deepStrictEqual(validate(wrap({ ...ex, status: st, findings: [], not_measured: ['x'] })), [], st + ' needs no finding');
    assert.strictEqual(validate(wrap({ ...ex, status: st, not_measured: ['  '], deviations: [''] })).length, 1, 'blank-only strings');
  }
});

test('SubagentHandback: invalid report is denied twice, the third attempt is let through and logged', () => {
  const f = transcript('hb-retry', { requested: true });
  const bad = 'I am done, no block.';
  for (let i = 0; i < 2; i++) {
    const o = run(handbackEv('hb1', f, bad));
    assert.ok(denied(o), 'attempt ' + (i + 1));
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /no json fenced block found/);
  }
  assert.deepStrictEqual(run(handbackEv('hb1', f, bad)), {});
  assert.deepStrictEqual(rowsFor('hb1').map((r) => r.event), ['deny', 'deny', 'allow-after-retries']);
});

test('SubagentHandback: valid report is allowed; deny then valid is allowed', () => {
  const f = transcript('hb-ok', { requested: true });
  assert.deepStrictEqual(run(handbackEv('hb2', f, wrap(EXAMPLE))), {});
  assert.deepStrictEqual(rowsFor('hb2').map((r) => r.event), ['allow']);
  assert.ok(denied(run(handbackEv('hb3', f, 'nothing'))));
  assert.deepStrictEqual(run(handbackEv('hb3', f, wrap(EXAMPLE))), {});
  assert.deepStrictEqual(rowsFor('hb3').map((r) => r.event), ['deny', 'allow']);
});

test('transcripts that never requested the contract (or only quote it) are not enforced and not logged', () => {
  for (const [name, opts] of [['plain', { requested: false }], ['quote', { requested: false, quoteOnly: true }]]) {
    const f = transcript('nr-' + name, opts);
    const id = 'nr-' + name;
    assert.deepStrictEqual(run(handbackEv(id, f, 'garbage')), {});
    assert.deepStrictEqual(run(stopEv(id, f, 'garbage')), {});
    assert.deepStrictEqual(rowsFor(id), []);
  }
});

test('transcript path derived from transcript_path + session_id + agent_id', () => {
  const sub = path.join(TMP, 'sess-9', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.copyFileSync(transcript('tmp-derived', { requested: true }), path.join(sub, 'agent-dv1.jsonl'));
  const o = run({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', session_id: 'sess-9', agent_id: 'dv1',
    transcript_path: path.join(TMP, 'sess-9.jsonl'), tool_input: { message: 'garbage' } });
  assert.ok(denied(o));
});

test('unreadable transcript is logged separately from "not requested", never enforced', () => {
  const missing = path.join(TMP, 'does-not-exist.jsonl');
  assert.deepStrictEqual(run(stopEv('un1', missing, 'garbage')), {});
  assert.deepStrictEqual(run(handbackEv('un2', missing, 'garbage')), {});
  assert.strictEqual(rowsFor('un1')[0].event, 'transcript-unreadable');
  assert.strictEqual(rowsFor('un2')[0].event, 'transcript-unreadable');
});

test('SubagentStop without a handback: block once, then let through on stop_hook_active', () => {
  const f = transcript('st-1', { requested: true });
  const o = run(stopEv('st1', f, 'plain prose only'));
  assert.strictEqual(o.decision, 'block');
  assert.match(o.reason, /Return contract v1 not satisfied/);
  assert.deepStrictEqual(run(stopEv('st1', f, 'plain prose only', { stop_hook_active: true })), {});
  assert.deepStrictEqual(run(stopEv('st2', f, wrap(EXAMPLE))), {});
  assert.deepStrictEqual(rowsFor('st1').map((r) => r.event), ['block', 'allow-after-retry']);
  assert.deepStrictEqual(rowsFor('st2').map((r) => r.event), ['allow']);
});

test('SubagentStop after an accepted handback is skipped; after a DENIED handback it is still checked', () => {
  const f = transcript('st-hb', { requested: true, handback: true });
  assert.deepStrictEqual(run(handbackEv('sk1', f, wrap(EXAMPLE))), {});
  assert.deepStrictEqual(run(stopEv('sk1', f, 'ack')), {});
  assert.deepStrictEqual(rowsFor('sk1').map((r) => r.event), ['allow', 'skip-handback']);
  assert.ok(denied(run(handbackEv('sk2', f, 'bad'))));
  assert.strictEqual(run(stopEv('sk2', f, 'ack')).decision, 'block');
});

test('escape hatch: guardrail:confirmed with a reason skips the check and is audited; without one it does not', () => {
  const f = transcript('esc', { requested: true });
  const msg = 'Could not produce the block.\nguardrail:confirmed reason="caller accepts free text here"';
  assert.deepStrictEqual(run(handbackEv('es1', f, msg)), {});
  const r = rowsFor('es1');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].event, 'bypass');
  assert.match(r[0].reason, /caller accepts/);
  assert.ok(denied(run(handbackEv('es2', f, 'x\nguardrail:confirmed reason="short"'))));
  assert.ok(denied(run(handbackEv('es3', f, 'x\nguardrail:confirmed'))));
});

test('escape hatch is not honoured when the audit log is not writable', () => {
  const f = transcript('esc2', { requested: true });
  const msg = 'free text\nguardrail:confirmed reason="caller accepts free text here"';
  const o = run(handbackEv('es4', f, msg), { GUARDRAIL_AUDIT_LOG: TMP }); // a directory
  assert.ok(denied(o));
});

test('malformed stdin and unrelated events: {} exit 0, also under GUARDRAIL_FAIL_CLOSED=1', () => {
  const res = spawnSync(process.execPath, [HOOK], { input: '{not json', encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: LOG, GUARDRAIL_FAIL_CLOSED: '1' } });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '{}');
  assert.deepStrictEqual(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), {});
  assert.deepStrictEqual(run({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message: 'x' } }), {}); // no agent_id
});
