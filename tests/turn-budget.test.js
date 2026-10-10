'use strict';
// Tests for scripts/turn-budget.js.
//
// Payloads are synthetic, shaped after the documented PreToolUse fields (hook_event_name,
// session_id, tool_name, cwd, agent_id and agent_type inside a subagent). Agent files are written
// to a temp directory: one with maxTurns 25, one with 60, one without maxTurns. State and audit
// log are redirected to temp paths.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'turn-budget.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
const AGENTS = path.join(TMP, 'agents');
const STATE = path.join(TMP, 'state');
const LOG = path.join(TMP, 'audit.jsonl');
fs.mkdirSync(AGENTS);
const agentFile = (dir, name, fm) => fs.writeFileSync(path.join(dir, name + '.md'), `---\nname: ${name}\n${fm}---\nBody.\n`);
agentFile(AGENTS, 'fast-worker', 'description: small tasks\nmaxTurns: 25\n');
agentFile(AGENTS, 'deep-worker', 'description: long tasks\nmaxTurns: 60\n');
agentFile(AGENTS, 'uncapped-worker', 'description: no cap\nmodel: sonnet\n');

function run(input, env = {}, raw = false) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: raw ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AGENTS_DIR: AGENTS, GUARDRAIL_STATE_DIR: STATE, GUARDRAIL_AUDIT_LOG: LOG, ...env },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout || '{}');
}
const ctx = (o) => (o.hookSpecificOutput || {}).additionalContext || '';
const ev = (extra) => ({ hook_event_name: 'PreToolUse', session_id: 'sessA', tool_name: 'Read', cwd: TMP, ...extra });
const calls = (n, extra, env) => Array.from({ length: n }, () => run(ev(extra), env));

test('warns at 4 and 2 calls before the cap, silent otherwise', () => {
  const outs = calls(25, { agent_id: 'ag1', agent_type: 'fast-worker' }).map(ctx);
  outs.forEach((o, i) => {
    const call = i + 1;
    if (call === 21) { assert.match(o, /^TURN BUDGET: ~4 turns left/); assert.match(o, /NOT MEASURED/); }
    else if (call === 23) assert.match(o, /^TURN BUDGET: ~2 turns left/);
    else assert.strictEqual(o, '', `call ${call} must be silent`);
  });
});

test('output shape: PreToolUse additionalContext, never a permission decision', () => {
  const outs = calls(56, { agent_id: 'ag2', agent_type: 'deep-worker' });
  assert.strictEqual(outs[0].hookSpecificOutput, undefined);
  const o = outs[55];
  assert.match(ctx(o), /~4 turns/);
  assert.strictEqual(o.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(!('permissionDecision' in o.hookSpecificOutput));
});

test('counts are per agent_id: a fresh agent starts at 1', () => {
  calls(24, { agent_id: 'ag3', agent_type: 'fast-worker' });
  assert.strictEqual(ctx(run(ev({ agent_id: 'ag3b', agent_type: 'fast-worker' }))), '');
});

test('main context (no agent_id), or missing agent_type / session_id: ignored, no state written', () => {
  const before = fs.readdirSync(path.join(STATE, 'turn-budget'));
  assert.strictEqual(ctx(run(ev({}))), '');
  assert.strictEqual(ctx(run(ev({ agent_id: 'x1' }))), '');
  assert.strictEqual(ctx(run({ ...ev({ agent_id: 'x2', agent_type: 'fast-worker' }), session_id: undefined })), '');
  assert.deepStrictEqual(fs.readdirSync(path.join(STATE, 'turn-budget')), before);
});

test('agent types without maxTurns, built-ins, unknown and path-like names: nothing', () => {
  for (const t of ['uncapped-worker', 'general-purpose', 'no-such-agent', '../../etc/x']) {
    for (const o of calls(30, { agent_id: 'ag4-' + t.length, agent_type: t })) assert.strictEqual(ctx(o), '', t);
  }
});

test('other events are ignored', () => {
  assert.strictEqual(ctx(run({ ...ev({ agent_id: 'ag5', agent_type: 'fast-worker' }), hook_event_name: 'PostToolUse' })), '');
});

test('agent file lookup: project .claude/agents via cwd, then CLAUDE_CONFIG_DIR/agents', () => {
  const proj = path.join(TMP, 'proj');
  const cfg = path.join(TMP, 'cfg');
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  agentFile(path.join(proj, '.claude', 'agents'), 'proj-worker', 'maxTurns: 6\n');
  agentFile(path.join(cfg, 'agents'), 'cfg-worker', 'maxTurns: 6\n');
  const env = { GUARDRAIL_AGENTS_DIR: '', CLAUDE_CONFIG_DIR: cfg };
  const a = calls(2, { agent_id: 'ag6', agent_type: 'proj-worker', cwd: proj }, env);
  assert.match(ctx(a[1]), /~4 turns/);            // cap 6, call 2 -> 4 left (project dir found via cwd)
  const b = calls(2, { agent_id: 'ag7', agent_type: 'cfg-worker', cwd: proj }, env);
  assert.match(ctx(b[1]), /~4 turns/);            // found in the config dir
  const c = calls(2, { agent_id: 'ag8', agent_type: 'cfg-worker', cwd: TMP }, env);
  assert.match(ctx(c[1]), /~4 turns/);
  const d = calls(2, { agent_id: 'ag9', agent_type: 'proj-worker', cwd: TMP }, env); // not visible from another cwd
  assert.strictEqual(ctx(d[1]), '');
});

test('malformed input: {} exit 0, audited, also under GUARDRAIL_FAIL_CLOSED=1', () => {
  assert.deepStrictEqual(run('not json', { GUARDRAIL_FAIL_CLOSED: '1' }, true), {});
  assert.deepStrictEqual(run('[]', {}, true), {});
  const rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.hook === 'turn-budget' && r.event === 'error'));
});

test('unwritable state dir: fails open and audits', () => {
  const blocker = path.join(TMP, 'blocker');
  fs.writeFileSync(blocker, 'a file, not a directory');
  const o = run(ev({ agent_id: 'ag10', agent_type: 'fast-worker' }), { GUARDRAIL_STATE_DIR: path.join(blocker, 'x') });
  assert.deepStrictEqual(o, {});
});
