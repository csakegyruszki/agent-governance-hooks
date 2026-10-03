'use strict';
// Tests for scripts/no-nested-agent.js.
//
// Provenance of the payload shapes: derived from a local audit log of real Claude Code
// PreToolUse Agent/Task events (one raised inside a subagent, carrying an agent id and type; one
// raised from the main context, carrying neither). The log stores those two payload fields as
// caller id/type; raw payloads were not retained.
// Values are redacted: the agent id is a fixed placeholder. Only the fields the hook reads are
// kept. These are shape fixtures, not a claim of full-payload fidelity: real payloads carry
// more fields (session id, cwd, tool_input, ...) that the hook ignores. The malformed-input
// cases below are synthetic and are labelled as such.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const AUDIT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nna-')), 'audit.jsonl');

const HOOK = path.join(__dirname, '..', 'scripts', 'no-nested-agent.js');

function runEnv(input, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: AUDIT, GUARDRAIL_FAIL_CLOSED: '', ...env },
  });
}
function run(input) {
  const res = runEnv(input);
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}
const decision = (out) => out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision;

// Captured shape, values redacted.
const FROM_SUBAGENT = { tool_name: 'Agent', agent_id: 'AGENT-ID-REDACTED', agent_type: 'general-purpose' };
const FROM_MAIN = { tool_name: 'Agent' };

test('real shape: spawn from inside a subagent is denied', () => {
  const out = run(FROM_SUBAGENT);
  assert.strictEqual(decision(out), 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /general-purpose/);
});

test('real shape: spawn from the main context (no agent_id) is not touched', () => {
  assert.deepStrictEqual(run(FROM_MAIN), {});
});

test('Task tool name (older alias) is treated like Agent', () => {
  assert.strictEqual(decision(run({ ...FROM_SUBAGENT, tool_name: 'Task' })), 'deny');
});

test('non-spawn tool called from a subagent is not touched', () => {
  assert.deepStrictEqual(run({ ...FROM_SUBAGENT, tool_name: 'Bash' }), {});
});

test('synthetic: empty-string agent_id counts as main context', () => {
  assert.deepStrictEqual(run({ ...FROM_SUBAGENT, agent_id: '' }), {});
});

test('synthetic: malformed JSON fails open', () => {
  assert.deepStrictEqual(run('{not json'), {});
});

test('synthetic: empty stdin fails open', () => {
  assert.deepStrictEqual(run(''), {});
});

test('fail-closed: malformed stdin, null, array and empty stdin are denied with GUARDRAIL_FAIL_CLOSED=1', () => {
  for (const bad of ['{not json', '', 'null', '[]']) {
    const out = JSON.parse(runEnv(bad, { GUARDRAIL_FAIL_CLOSED: '1' }).stdout);
    assert.strictEqual(decision(out), 'deny', JSON.stringify(bad));
  }
});

test('fail-open default: null and array payloads are allowed', () => {
  assert.deepStrictEqual(run('null'), {});
  assert.deepStrictEqual(run('[]'), {});
});

test('Agent/Task calls append a "seen" audit event with has_agent_id; other tools do not', () => {
  fs.rmSync(AUDIT, { force: true });
  run(FROM_MAIN);
  run(FROM_SUBAGENT);
  run({ tool_name: 'Bash' });
  const recs = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(recs.length, 2);
  assert.deepStrictEqual(recs.map((r) => r.has_agent_id), [false, true]);
  assert.ok(recs.every((r) => r.hook === 'no-nested-agent' && r.event === 'seen'));
});
