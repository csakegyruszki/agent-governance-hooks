#!/usr/bin/env node
'use strict';
// turn-budget.js - PreToolUse hook (any tool), acts INSIDE subagents only. Advisory: never denies.
//
// Why: a subagent that reaches its maxTurns cap ends without a report, and the work is lost. The
// agent cannot see its own turn counter, so this hook counts for it and says "write your report
// now" two times shortly before the cap.
//
// Mechanism: hook payloads fired inside a subagent carry agent_id and agent_type (documented
// common fields, https://code.claude.com/docs/en/hooks). The hook counts PreToolUse calls per
// agent_id, looks up maxTurns in the agent file's frontmatter (<agent_type>.md, see
// scripts/lib/subagents.js for where it looks), and at 4 and at 2 calls before the cap injects
// additionalContext telling the agent to stop investigating and report.
//
// Turns are not tool calls: one assistant turn can issue several parallel tool calls, so calls >=
// turns used and the warning fires EARLIER than the true turn count. That is the conservative side.
// Agent types without a maxTurns line (built-in agents, ad-hoc types, no agent file) -> does nothing.
//
// State: <state dir>/turn-budget/<session>/<agent_id>.count, append-only, one byte per call; the
// count is the file size. (Appending is safe when several hook processes run in parallel; a
// read-modify-write file would lose counts.) State dir: GUARDRAIL_STATE_DIR, default
// ~/.agent-governance-hooks/state.
//
// Any error is audited and answered with '{}' (never blocks, also under GUARDRAIL_FAIL_CLOSED).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAdvisory } = require('./lib/common');
const { maxTurnsFor } = require('./lib/subagents');

const HOOK = 'turn-budget';
const WARN_AT = [4, 2]; // calls remaining before the cap at which to warn
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

function stateDir() {
  const base = process.env.GUARDRAIL_STATE_DIR || path.join(os.homedir(), '.agent-governance-hooks', 'state');
  return path.join(base, 'turn-budget');
}

function handler(p) {
  if (p.hook_event_name !== 'PreToolUse') return null;
  if (!p.agent_id || !p.agent_type || !p.session_id) return null; // main context or incomplete payload
  const cap = maxTurnsFor(p.agent_type, p.cwd);
  if (!cap || cap < 1) return null;
  const dir = path.join(stateDir(), safe(p.session_id));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, safe(p.agent_id) + '.count');
  fs.appendFileSync(f, '.');
  const left = cap - fs.statSync(f).size;
  if (!WARN_AT.includes(left)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `TURN BUDGET: ~${left} turns left before your hard cap. Stop investigating now; ` +
        'write your report in the next turn. Mark anything you did not check as NOT MEASURED.',
    },
  };
}

if (require.main === module) runAdvisory(HOOK, handler);
module.exports = { handler, WARN_AT };
