#!/usr/bin/env node
'use strict';
// no-nested-agent.js - PreToolUse gate on Agent/Task: a subagent may NOT spawn another subagent.
//
// Why: nested delegation multiplies cost and hides who is doing the work; only the main
// context should delegate.
//
// Mechanism: Claude Code puts `agent_id` / `agent_type` into the hook payload when the tool
// call originates inside a subagent. Main-context calls carry no agent_id -> allowed.
// Every Agent/Task call appends an audit event {event:'seen', has_agent_id} so that
// `scripts/doctor.js` can tell whether agent_id was ever observed on this install (if never,
// nested-spawn detection is unverified there).
// Malformed input: fail open, or deny under GUARDRAIL_FAIL_CLOSED=1 (via lib/common run()).

const { run, allow, deny, audit } = require('./lib/common');

run('no-nested-agent', (p) => {
  const tool = String(p.tool_name || '');
  if (!/^(Agent|Task)$/i.test(tool)) return allow();
  const ti = (p.tool_input && typeof p.tool_input === 'object') ? p.tool_input : {};
  const has = (v) => v != null && v !== '';
  const nested = has(p.agent_id) || has(ti.agent_id);
  audit('no-nested-agent', { event: 'seen', has_agent_id: nested, tool });
  if (!nested) return allow();
  const caller = p.agent_type ? ` (${p.agent_type})` : '';
  deny(`Nested delegation is disabled: this subagent${caller} may not start another subagent. ` +
    'Do the work yourself with your own tools, or finish and report back so the main ' +
    'context can decide on further delegation.');
});
