#!/usr/bin/env node
'use strict';
// delegation-log.js - PostToolUse (Agent|Task) + SubagentStop logger. Never blocks, never rewrites.
//
// Why: without a record of what each delegation cost and how it ended, nobody can tell which
// agent types burn tokens, which runs hit their turn cap, or whether typed reports are adopted.
//
//  - PostToolUse Agent/Task -> {event:"launch"} row: requested vs resolved model, whether the
//    return contract was requested.
//  - SubagentStop           -> {event:"stop"} row: token usage and turns summed from the subagent
//    transcript, deduplicated by message.id (one assistant message spans several transcript rows;
//    the LAST row of an id carries the final usage, earlier rows are streaming partials), plus
//    max_turns / cap_hit (agent file frontmatter maxTurns vs observed turns) and `contract` (the
//    outcome recorded by return-contract.js for this agent).
//
// Rows go to the shared audit log (GUARDRAIL_AUDIT_LOG, default
// ~/.agent-governance-hooks/audit.jsonl) with hook:"delegation-log".
// Any error is audited and answered with '{}' (never blocks, also under GUARDRAIL_FAIL_CLOSED).

const fs = require('fs');
const { audit, runAdvisory } = require('./lib/common');
const { maxTurnsFor, transcriptPath, auditRowsFor, CONTRACT_LINE_RE } = require('./lib/subagents');

const HOOK = 'delegation-log';

function asObject(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } }
  return {};
}

const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);

function transcriptStats(file) {
  let text;
  try { if (!file || !fs.existsSync(file)) return null; text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const msgs = new Map(); // message.id -> { model, usage }
  const toolIds = new Set();
  let first = null;
  let last = null;
  for (const l of text.split('\n')) {
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch (_) { continue; }
    if (r.timestamp) {
      const t = Date.parse(r.timestamp);
      if (!isNaN(t)) { if (first === null || t < first) first = t; if (last === null || t > last) last = t; }
    }
    const m = r.message;
    if (!m || m.role !== 'assistant' || !m.id) continue;
    msgs.set(m.id, { model: m.model, usage: m.usage || {} });
    if (Array.isArray(m.content)) {
      for (const c of m.content) if (c && c.type === 'tool_use' && c.id) toolIds.add(c.id);
    }
  }
  const s = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const models = new Set();
  for (const { model, usage } of msgs.values()) {
    if (model) models.add(model);
    for (const k of Object.keys(s)) s[k] += num(usage[k]);
  }
  return {
    models: [...models], turns: msgs.size, ...s, tool_uses: toolIds.size,
    first_ts: first === null ? null : new Date(first).toISOString(),
    last_ts: last === null ? null : new Date(last).toISOString(),
    duration_ms: first === null ? null : last - first,
  };
}

// Contract outcome for one agent, from the rows return-contract.js wrote. Unknown stays the
// unfavourable state: requested but no verdict recorded -> final "none".
//   pass | pass-after-retry | failed-let-through | blocked-once | bypassed | none
// SubagentStop hooks run in parallel, so a verdict row written by return-contract's SubagentStop
// path may land AFTER this row; handback-path rows always precede it. A late row is invisible here.
function contractOutcome(agentId, rowsOverride) {
  const none = { requested: false, denies: 0, final: 'none' };
  const rows = rowsOverride || auditRowsFor('return-contract', agentId);
  if (!rows.some((r) => r.requested === true)) return none;
  const denies = rows.filter((r) => r.event === 'deny').length;
  const retried = denies > 0 || rows.some((r) => r.event === 'block');
  // skip-handback / inject / transcript-unreadable are not verdicts; the handback rows carry it.
  const verdicts = rows.filter((r) => ['allow', 'allow-after-retries', 'allow-after-retry', 'block', 'deny', 'bypass'].includes(r.event));
  const lastV = verdicts.length ? verdicts[verdicts.length - 1].event : null;
  let final = 'none';
  if (lastV === 'allow') final = retried ? 'pass-after-retry' : 'pass';
  else if (lastV === 'allow-after-retries' || lastV === 'allow-after-retry') final = 'failed-let-through';
  else if (lastV === 'block' || lastV === 'deny') final = 'blocked-once';
  else if (lastV === 'bypass') final = 'bypassed';
  return { requested: true, denies, final };
}

function handler(p) {
  const ev = p.hook_event_name;
  if (ev === 'PostToolUse' && (p.tool_name === 'Agent' || p.tool_name === 'Task')) {
    const input = asObject(p.tool_input);
    const resp = asObject(p.tool_response);
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    audit(HOOK, {
      event: 'launch', session_id: p.session_id || null,
      agent_id: resp.agentId || null,
      tool_use_id: p.tool_use_id || null,
      agent_type: input.subagent_type || 'general-purpose',
      requested_model: input.model || null,
      resolved_model: resp.resolvedModel || null,
      description: input.description || null,
      contract_requested: CONTRACT_LINE_RE.test(prompt),
      is_async: typeof resp.status === 'string' ? resp.status === 'async_launched' : null,
    });
    return null;
  }
  if (ev === 'SubagentStop') {
    if (!p.agent_type) return null;
    const base = { event: 'stop', session_id: p.session_id || null, agent_id: p.agent_id || null, agent_type: p.agent_type };
    const st = transcriptStats(transcriptPath(p));
    if (!st) { audit(HOOK, { ...base, error: 'transcript-unreadable' }); return null; }
    const maxTurns = maxTurnsFor(p.agent_type, p.cwd);
    audit(HOOK, { ...base, ...st, max_turns: maxTurns, cap_hit: maxTurns != null && st.turns >= maxTurns,
      contract: contractOutcome(p.agent_id) });
  }
  return null;
}

if (require.main === module) runAdvisory(HOOK, handler);
module.exports = { transcriptStats, contractOutcome, handler };
