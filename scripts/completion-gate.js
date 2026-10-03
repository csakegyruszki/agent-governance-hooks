#!/usr/bin/env node
'use strict';
// PreToolUse (Write|Edit|MultiEdit) - completion gate for ticket files.
//
// Also: nothing under tickets/evidence/ can be written with Write/Edit/MultiEdit.
// A ticket cannot be set to `status: done` unless a fresh (< 24 h), passing evidence file
// (tickets/evidence/T-XXXX.json, written by `tools/tickets.py --verify`) exists for it.
//
// Division of labour, on purpose: this hook NEVER runs a ticket's commands. It asks
// tools/tickets.py for a verdict (`--gate-verdict`, which only reads the evidence artifact).
// The verdict rule lives in one place (tickets.py evidence_verdict) so it cannot drift between
// two languages. A hook that executed commands read from a file would be an attack surface.
//
// Which files: Markdown files named T-NNNN*.md inside a directory called `tickets`, or inside
// the directory named by env GUARDRAIL_TICKETS_DIR (then only that directory).
//
// Python: env GUARDRAIL_PYTHON, else `python3` then `python` from PATH. If none works the gate
// fails OPEN with an audit event (a broken gate must not stop work); with GUARDRAIL_FAIL_CLOSED=1
// it denies instead.
//
// Escape hatch: put  guardrail:confirmed reason="<at least 8 chars>"  inside the ticket text. It
// is audit-logged and stays visible in the ticket forever. Without a reason it is ignored.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const common = require('./lib/common.js');

const HOOK = 'completion-gate';
const TICKETS_PY = path.join(__dirname, '..', 'tools', 'tickets.py');

// Frontmatter only (between the first two `---` lines). A `status: done` line in the body is
// neither a transition nor a status. No frontmatter -> empty (tickets.py ignores such files too).
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : '';
}

function indentOf(l) { return l.length - l.trimStart().length; }

// Lines of the continuation (indented deeper than line i) of a key, e.g. a YAML block scalar.
function continuation(lines, i) {
  const base = indentOf(lines[i]);
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() && indentOf(lines[j]) <= base) break;
    if (lines[j].trim()) out.push(lines[j].trim());
  }
  return out;
}

// Is `status` done? Tolerates `status:done`, quotes, any case, trailing comments, indentation
// (tickets.py strips keys, so an indented key counts) and block scalars (`status: >-` + `done`).
function isDone(text) {
  const lines = frontmatter(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*["']?status["']?\s*:\s*(.*?)\s*$/i.exec(lines[i]);
    if (!m) continue;
    let v = m[1];
    if (/^[|>][+-]?\s*(#.*)?$/.test(v)) v = continuation(lines, i).join(' ');
    v = v.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    if (/^done$/i.test(v)) return true;
  }
  return false;
}

// The fields the evidence has to cover (`checks`, `changed_files`), with continuation lines, for
// comparing the on-disk ticket with the post-edit one.
function evidenceFields(text) {
  const lines = frontmatter(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*["']?(checks|changed_files)["']?\s*:/i.test(lines[i])) continue;
    out.push([lines[i].trim()].concat(continuation(lines, i)).join('\n'));
  }
  return JSON.stringify(out);
}

function replaceOnce(text, oldS, newS, all) {
  if (typeof oldS !== 'string' || oldS === '' || !text.includes(oldS)) return null;
  return all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
}

// The file as it will be after the tool call; null if the edit cannot be applied (the tool would
// fail itself then - the caller falls back to a conservative approximation).
function postEditText(ti, existing) {
  if (typeof ti.content === 'string') return ti.content;
  if (Array.isArray(ti.edits)) {
    let t = existing;
    for (const e of ti.edits) {
      if (!e) continue;
      t = replaceOnce(t, e.old_string, String(e.new_string === undefined ? '' : e.new_string), !!e.replace_all);
      if (t === null) return null;
    }
    return t;
  }
  if (typeof ti.new_string === 'string') return replaceOnce(existing, ti.old_string, ti.new_string, !!ti.replace_all);
  return null;
}

function ticketsDirMatches(dir) {
  const env = (process.env.GUARDRAIL_TICKETS_DIR || '').trim();
  if (env) return path.resolve(dir) === path.resolve(env);
  return path.basename(dir).toLowerCase() === 'tickets';
}

// Is `file` inside <tickets dir>/evidence/ (any depth)?
function inEvidenceDir(file) {
  let d = path.dirname(file);
  for (let i = 0; i < 32; i++) {
    const parent = path.dirname(d);
    if (path.basename(d).toLowerCase() === 'evidence' && ticketsDirMatches(parent)) return true;
    if (parent === d) break;
    d = parent;
  }
  return false;
}

function pythonCandidates() {
  const env = (process.env.GUARDRAIL_PYTHON || '').trim();
  return env ? [env] : ['python3', 'python'];
}

// Returns the parsed verdict {ok, reason}, or null if no Python could produce one. The ticket
// text judged is always the POST-edit text (stdin), never the file on disk.
function getVerdict(tid, dir, stdinText) {
  const args = [TICKETS_PY, '--tickets-dir', dir, '--gate-verdict', tid, '--from-stdin'];
  for (const py of pythonCandidates()) {
    try {
      const out = execFileSync(py, args, {
        encoding: 'utf8', timeout: 8000, input: stdinText,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const v = JSON.parse(out);
      if (v && typeof v.ok === 'boolean') return v;
    } catch (_) { /* try the next candidate */ }
  }
  return null;
}

function readOrEmpty(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

common.run(HOOK, (p) => {
  const ti = p.tool_input || {};
  const file = String(ti.file_path || ti.path || '');
  const base = path.basename(file.replace(/\\/g, '/'));
  const dir = path.dirname(file);
  const writes = typeof ti.content === 'string' || typeof ti.new_string === 'string' || Array.isArray(ti.edits);

  // Evidence files are written only by `tools/tickets.py --verify`, never by the agent's own tools.
  if (file && writes && inEvidenceDir(file.replace(/\\/g, '/'))) {
    return common.deny(`${HOOK} BLOCKED: \`${base}\` is under tickets/evidence/. Evidence is produced ` +
      'only by `tools/tickets.py --verify T-XXXX`, not written by hand (there is no escape hatch for this).');
  }
  if (!/^T-\d{4}[^/\\]*\.md$/i.test(base) || !ticketsDirMatches(dir)) return common.allow();

  // Judge the file as it will be AFTER the edit, not the replacement text in isolation.
  const existing = readOrEmpty(file);
  const isWrite = typeof ti.content === 'string';
  const chunks = [ti.content, ti.new_string];
  if (Array.isArray(ti.edits)) for (const e of ti.edits) chunks.push(e && e.new_string);
  const incoming = chunks.filter((c) => typeof c === 'string').join('\n');
  let post = postEditText(ti, existing);
  if (post === null) post = existing + '\n' + incoming; // the edit would fail anyway; stay conservative
  if (!isDone(post)) return common.allow();
  if (isDone(existing)) return common.allow(); // already done: not a transition

  const tid = (base.match(/^(T-\d{4})/i) || [])[1];
  if (!tid) return common.allow();

  // Escape hatch: marker in the new text, or already in the ticket on disk.
  const reason = common.confirmedReason(incoming) || common.confirmedReason(existing);
  if (reason) {
    if (!common.auditStrict(HOOK, { event: 'bypass', ticket: tid, reason })) {
      return common.deny(`${HOOK}: the bypass for ${tid} could not be audit-logged, so it is not honoured.`);
    }
    return common.allow();
  }

  // Changing `checks:` / `changed_files:` in the same call as `done` is not judged (any tool): the
  // evidence cannot cover fields that changed after the run. Split the change. (A brand-new file
  // has nothing on disk to compare with and is judged on its own content.)
  if (existing !== '' && evidenceFields(post) !== evidenceFields(existing)) {
    return common.deny(`${HOOK} BLOCKED closing ${tid}: this ${isWrite ? 'write' : 'edit'} changes ` +
      '`checks:`/`changed_files:` and sets `status: done` at once. Change them first, run ' +
      '`tools/tickets.py --verify ' + tid + '`, then set `status: done` in a separate edit.');
  }

  const verdict = getVerdict(tid, dir, post);
  if (verdict === null) {
    common.audit(HOOK, { event: 'no-verdict', ticket: tid, note: 'python not found or tickets.py failed' });
    if (common.failClosed()) {
      return common.deny(`${HOOK}: could not obtain a verdict for ${tid} (no working Python; set ` +
        'GUARDRAIL_PYTHON) and GUARDRAIL_FAIL_CLOSED=1, so closing is blocked.');
    }
    return common.allow();
  }
  if (verdict.ok) return common.allow();
  common.deny(`${HOOK} BLOCKED closing ${tid}: ${verdict.reason}\n\n` +
    'If it truly must be closed without evidence, put guardrail:confirmed reason="<why, 8+ chars>" ' +
    'in the ticket and retry. That is allowed, logged, and stays visible in the ticket.');
});
