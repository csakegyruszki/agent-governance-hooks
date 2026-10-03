'use strict';
// Shared plumbing for every hook in this plugin. Node builtins only.
//
// Contract (all hooks):
// - Input: Claude Code hook JSON on stdin. Output: '{}' to allow, a PreToolUse deny object to block,
//   or (for non-PreToolUse events) whatever hookSpecificOutput that event accepts.
// - Errors: fail OPEN by default (a broken hook never blocks the session). With
//   GUARDRAIL_FAIL_CLOSED=1 a PreToolUse hook denies instead, so a broken guard cannot silently
//   stop protecting you.
// - Escape hatch: a statement/command that carries  guardrail:confirmed reason="<at least 8 chars>"
//   is let through, and every use is appended to the audit log. A marker without a reason is
//   ignored (the call is still denied). The model can type the marker too; the log is there so a
//   human can review every bypass.
// - Audit log: JSONL at GUARDRAIL_AUDIT_LOG, default ~/.agent-governance-hooks/audit.jsonl. Logging never
//   throws and never blocks.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_RE = /guardrail:confirmed\s+reason\s*=\s*"([^"\n]*)"/i;
const MIN_REASON = 8; // non-whitespace characters

function allow() {
  process.stdout.write('{}');
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

function failClosed() {
  return process.env.GUARDRAIL_FAIL_CLOSED === '1';
}

// Called when input is malformed or the hook itself throws.
function onError(hook, err) {
  audit(hook, { event: 'error', error: String((err && err.message) || err).slice(0, 200) });
  if (failClosed()) {
    deny(`${hook}: internal error and GUARDRAIL_FAIL_CLOSED=1, so the call is blocked. ` +
      'Fix the hook or unset the variable.');
  } else {
    allow();
  }
}

// Returns the reason string if a valid escape-hatch marker is present, else null.
// A reason needs >= MIN_REASON non-whitespace characters; reason="        " does not count.
function confirmedReason(text) {
  const m = MARKER_RE.exec(String(text || ''));
  if (!m) return null;
  const reason = m[1].trim();
  return reason.replace(/\s/g, '').length >= MIN_REASON ? reason : null;
}

// Use this, not audit(), before honouring an escape hatch: the bypass is allowed only if its
// audit record was actually written, so no bypass goes unlogged.
function auditStrict(hook, fields) {
  try {
    const p = auditPath();
    ensureLogDir(p);
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), hook, ...fields }) + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

// Creates only the leaf directory; the parent must already exist. A recursive mkdir hung forever on an
// uncreatable parent during adversarial testing, which stalled the hook (neither allow nor deny).
function ensureLogDir(p) {
  const dir = path.dirname(p);
  if (fs.existsSync(dir)) return;
  if (!fs.existsSync(path.dirname(dir))) throw new Error('audit log parent directory does not exist');
  fs.mkdirSync(dir);
}

function auditPath() {
  return process.env.GUARDRAIL_AUDIT_LOG ||
    path.join(os.homedir(), '.agent-governance-hooks', 'audit.jsonl');
}

function audit(hook, fields) {
  try {
    const p = auditPath();
    ensureLogDir(p);
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), hook, ...fields }) + '\n');
  } catch (_) { /* logging must never block */ }
}

// Reads all of stdin, parses JSON, calls handler(payload). Any parse error or thrown error goes
// through onError (fail-open unless GUARDRAIL_FAIL_CLOSED=1).
function run(hook, handler) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('hook input is not a JSON object');
      }
    } catch (e) {
      return onError(hook, e);
    }
    try {
      handler(payload);
    } catch (e) {
      onError(hook, e);
    }
  });
}

module.exports = { allow, deny, failClosed, onError, confirmedReason, audit, auditStrict, auditPath, ensureLogDir, run, MARKER_RE };
