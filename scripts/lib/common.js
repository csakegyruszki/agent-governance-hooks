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
// - Approval mode: GUARDRAIL_APPROVAL=deny (default) blocks destructive/secret actions;
//   GUARDRAIL_APPROVAL=ask returns permissionDecision "ask" instead, so Claude Code prompts the
//   human. The escape hatch above keeps working in both modes (for unattended runs).
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

function ask(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `${reason} Approve only if you intended this.`,
    },
  }));
}

// GUARDRAIL_APPROVAL=ask turns a guard's destructive/secret block into a permission prompt for the
// human. Anything else (including unset) keeps the default: deny.
function approvalMode() {
  return process.env.GUARDRAIL_APPROVAL === 'ask' ? 'ask' : 'deny';
}

// Used by the four blocking guards for the "destructive or secret action" case ONLY. Not for
// malformed input, fail-closed errors, un-loggable bypasses, the evidence-dir block or completion-gate.
// Audits event 'ask' or 'deny', then emits the matching decision.
function blockOrAsk(hook, fields, reason) {
  if (approvalMode() === 'ask') {
    audit(hook, { event: 'ask', ...fields });
    return ask(reason);
  }
  audit(hook, { event: 'deny', ...fields });
  return deny(reason);
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

// Creates a state directory (and missing parents) without handing a recursive mkdir an uncreatable
// parent: below a regular file such a mkdir can stall instead of failing. Walk up to the first
// existing ancestor, require it to be a directory, then create.
function ensureDir(dir) {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  if (!fs.statSync(probe).isDirectory()) throw new Error('state directory parent is not a directory');
  fs.mkdirSync(dir, { recursive: true });
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

// For advisory/observability hooks (turn-budget, delegation-log, return-contract): reads stdin, calls
// handler(payload), and writes whatever it returns ('{}' if nothing). Malformed input or a thrown
// error is audited as an 'error' event and answered with '{}' ALWAYS, also under
// GUARDRAIL_FAIL_CLOSED=1: these hooks are not safety guards, and a broken advisory hook must never
// block the session. (Same stance as lesson-inject.)
function runAdvisory(hook, handler) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let out = null;
    try {
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('hook input is not a JSON object');
      }
      out = handler(payload);
    } catch (e) {
      audit(hook, { event: 'error', error: String((e && e.message) || e).slice(0, 200) });
    }
    process.stdout.write(out == null ? '{}' : (typeof out === 'string' ? out : JSON.stringify(out)));
  });
}

module.exports = { allow, deny, ask, approvalMode, blockOrAsk, failClosed, onError, confirmedReason, audit, auditStrict, auditPath, ensureLogDir, ensureDir, run, runAdvisory, MARKER_RE };
