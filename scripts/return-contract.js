#!/usr/bin/env node
'use strict';
// return-contract.js - opt-in typed report for delegated work. PreToolUse (Agent|Task and
// SubagentHandback) + SubagentStop. Spec: docs/contracts/subagent-return-v1.md.
//
// Why: a subagent's free-text report cannot be checked mechanically; a fixed JSON block can. The
// caller opts in per delegation by putting the line  RETURN: contract-v1  in the prompt.
//
//  - PreToolUse Agent/Task:  prompt has the opt-in line -> append the INJECT block of the spec (once,
//    marked with a sentinel comment that only this hook writes, so a prompt that merely quotes the
//    spec is never enforced).
//  - PreToolUse SubagentHandback (subagent delivers its report through this tool, Claude Code
//    >= 2.1.271, message in tool_input.message): contract requested + report invalid + fewer than
//    2 earlier denials for this agent -> deny with the list of problems.
//  - SubagentStop: contract requested, no accepted SubagentHandback, report (last_assistant_message)
//    invalid, stop_hook_active false -> block once with the problems.
// A report that still fails after the retries is LET THROUGH and logged (event allow-after-retries /
// allow-after-retry): the caller decides, the hook never traps an agent in a loop.
//
// Escape hatch: a report carrying  guardrail:confirmed reason="<at least 8 chars>"  skips the check;
// honoured only if the bypass event was written to the audit log.
// Rows go to the shared audit log (GUARDRAIL_AUDIT_LOG) with hook:"return-contract"; delegation-log.js
// reads them to record the contract outcome per run.
// Errors are audited and answered with '{}' (never blocks, also under GUARDRAIL_FAIL_CLOSED).
// Env: GUARDRAIL_RETURN_CONTRACT_SPEC overrides the spec path.

const fs = require('fs');
const path = require('path');
const { audit, auditStrict, confirmedReason, runAdvisory } = require('./lib/common');
const { transcriptPath, auditRowsFor, CONTRACT_LINE_RE } = require('./lib/subagents');

const HOOK = 'return-contract';
const SPEC = process.env.GUARDRAIL_RETURN_CONTRACT_SPEC ||
  path.join(__dirname, '..', 'docs', 'contracts', 'subagent-return-v1.md');
const MAX_DENIES = 2;
const SENTINEL = '<!-- return-contract-v1:injected -->';
const STATUSES = ['DONE', 'PARTIAL', 'BLOCKED', 'FAILED'];
const BASES = ['read', 'measured', 'inferred'];

function readInject() {
  const t = fs.readFileSync(SPEC, 'utf8');
  const m = /<!-- INJECT-BEGIN -->\r?\n([\s\S]*?)\r?\n<!-- INJECT-END -->/.exec(t);
  if (!m) throw new Error('INJECT block not found in ' + SPEC);
  return m[1];
}

function lastJsonBlock(report) {
  const re = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
  let m;
  let last = null;
  while ((m = re.exec(String(report || ''))) !== null) last = m[1];
  return last;
}

const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

// Returns the list of problems; empty = valid.
function validate(report) {
  const block = lastJsonBlock(report);
  if (block === null) return ['no json fenced block found'];
  let o;
  try { o = JSON.parse(block); } catch (e) { return ['JSON block does not parse: ' + e.message]; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['JSON block is not an object'];
  const p = [];
  if (!('contract' in o)) p.push('missing key: contract');
  else if (o.contract !== 'v1') p.push('contract must be "v1"');
  if (!('status' in o)) p.push('missing key: status');
  else if (!STATUSES.includes(o.status)) p.push('status must be one of ' + STATUSES.join(', '));
  if (!('summary' in o)) p.push('missing key: summary');
  else if (!nonEmpty(o.summary)) p.push('summary must be a non-empty string');
  if (!('findings' in o)) p.push('missing key: findings');
  else if (!Array.isArray(o.findings)) p.push('findings must be an array');
  else {
    o.findings.forEach((f, i) => {
      if (!f || typeof f !== 'object') { p.push(`findings[${i}] must be an object`); return; }
      if (!nonEmpty(f.claim)) p.push(`findings[${i}].claim must be non-empty`);
      if (!BASES.includes(f.basis)) p.push(`findings[${i}].basis must be one of ${BASES.join(', ')}`);
      else if (f.basis !== 'inferred' && !nonEmpty(f.evidence)) p.push(`findings[${i}].evidence required unless basis is inferred`);
    });
  }
  // Domain rules: DONE needs at least one finding; any non-DONE status must say why.
  if (o.status === 'DONE' && Array.isArray(o.findings) && o.findings.length === 0) p.push('status DONE requires at least one finding');
  if (['PARTIAL', 'BLOCKED', 'FAILED'].includes(o.status)) {
    const filled = (k) => Array.isArray(o[k]) && o[k].some((x) => nonEmpty(x));
    if (!filled('not_measured') && !filled('deviations')) p.push('status ' + o.status + ' requires a non-empty not_measured or deviations (say why)');
  }
  if (!('not_measured' in o)) p.push('missing key: not_measured');
  else if (!Array.isArray(o.not_measured)) p.push('not_measured must be an array');
  for (const k of ['artifacts', 'checks', 'deviations']) {
    if (k in o && !Array.isArray(o[k])) p.push(k + ' must be an array when present');
  }
  return p;
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && x.type === 'text' ? x.text : '')).join('\n');
  return '';
}

// Reads the subagent transcript. Returns null when it cannot be read (the caller logs that; it is
// never treated as "contract not requested"). requested = the first user message carries the
// sentinel; handback = the agent has called SubagentHandback.
function transcriptInfo(file) {
  let text;
  try { if (!file || !fs.existsSync(file)) return null; text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  let requested = false;
  let handback = false;
  let first = true;
  for (const l of text.split('\n')) {
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch (_) { continue; }
    const msg = r.message;
    if (!msg) continue;
    if (first && msg.role === 'user') {
      requested = contentText(msg.content).includes(SENTINEL);
      first = false;
      if (!requested) return { requested, handback };
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && c.type === 'tool_use' && c.name === 'SubagentHandback') handback = true;
      }
    }
  }
  return { requested, handback };
}

// A handback counts as delivered only if this hook let it through (a denied call is not a delivery).
function handbackAccepted(rows) {
  return rows.some((r) => r.phase === 'PreToolUse:SubagentHandback' && String(r.event || '').startsWith('allow'));
}

function log(base, event, extra) {
  audit(HOOK, { ...base, event, ...extra });
}

// Valid-or-bypassed check shared by both paths. Returns {problems, bypassed}.
function check(report, base) {
  const reason = confirmedReason(report);
  if (reason && auditStrict(HOOK, { ...base, event: 'bypass', requested: true, reason })) {
    return { problems: [], bypassed: true };
  }
  return { problems: validate(report), bypassed: false };
}

function handler(p) {
  const ev = p.hook_event_name;
  const tool = p.tool_name;
  const base = {
    phase: ev + (tool ? ':' + tool : ''),
    session_id: p.session_id || null, agent_id: p.agent_id || null, agent_type: p.agent_type || null,
  };

  if (ev === 'PreToolUse' && (tool === 'Agent' || tool === 'Task')) {
    const input = (p.tool_input && typeof p.tool_input === 'object') ? p.tool_input : {};
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!CONTRACT_LINE_RE.test(prompt) || prompt.includes(SENTINEL)) return null;
    const updated = { ...input, prompt: prompt + '\n\n' + SENTINEL + '\n' + readInject() };
    log(base, 'inject', { requested: true });
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: updated } };
  }

  if (ev === 'PreToolUse' && tool === 'SubagentHandback') {
    if (!p.agent_id) return null;
    const info = transcriptInfo(transcriptPath(p));
    if (!info) { log(base, 'transcript-unreadable', { requested: null }); return null; }
    if (!info.requested) return null;
    const report = (p.tool_input || {}).message;
    const { problems, bypassed } = check(report, base);
    if (bypassed) return null;
    const valid = problems.length === 0;
    const denies = auditRowsFor(HOOK, p.agent_id).filter((r) => r.event === 'deny').length;
    if (!valid && denies < MAX_DENIES) {
      log(base, 'deny', { requested: true, valid, problems });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Return contract v1 not satisfied: ' + problems.join('; ') +
          '. Fix the JSON block and call SubagentHandback again.' } };
    }
    log(base, valid ? 'allow' : 'allow-after-retries', { requested: true, valid, problems });
    return null;
  }

  if (ev === 'SubagentStop') {
    const info = transcriptInfo(transcriptPath(p));
    if (!info) { log(base, 'transcript-unreadable', { requested: null }); return null; }
    if (!info.requested) return null;
    if (info.handback && handbackAccepted(auditRowsFor(HOOK, p.agent_id))) {
      log(base, 'skip-handback', { requested: true });
      return null;
    }
    const { problems, bypassed } = check(p.last_assistant_message, base);
    if (bypassed) return null;
    const valid = problems.length === 0;
    if (!valid && !p.stop_hook_active) {
      log(base, 'block', { requested: true, valid, problems });
      return { decision: 'block', reason: 'Return contract v1 not satisfied: ' + problems.join('; ') +
        '. Fix the JSON block and report again.' };
    }
    log(base, valid ? 'allow' : 'allow-after-retry', { requested: true, valid, problems });
  }
  return null;
}

if (require.main === module) runAdvisory(HOOK, handler);
module.exports = { validate, readInject, lastJsonBlock, SENTINEL, handler };
