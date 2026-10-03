'use strict';
// Tests for scripts/delegation-guard.js.
//
// The prompts below are labelled regression prompts written for this repo (synthetic: they model
// the two failure classes, missing scope and missing size limit). Every deny class has at least
// one allow counterpart, because a gate that denies everything would also score perfectly on
// deny-only tests. The audit log is redirected to a temp file.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'delegation-guard.js');
const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dg-')), 'audit.jsonl');

function run(input) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: LOG },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}
const call = (prompt, tool = 'Agent') => run({ tool_name: tool, tool_input: { subagent_type: 'general-purpose', prompt } });
const decision = (o) => (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision) || 'allow';
const reason = (o) => (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecisionReason) || '';

// Regression: both present
const GOOD = 'Read `config.json` and report the value of the timeout key. Answer: max 5 lines.';
// Regression: vague, no scope, no limit
const VAGUE = 'Review the whole codebase thoroughly and write a detailed analysis of how everything works and why.';
// Regression: scope but no limit
const NO_LIMIT = 'Read `src/server.js` and explain how request routing works, in as much detail as you like.';
// Regression: limit but no scope
const NO_SCOPE = 'Look into the authentication problem and summarize the cause in 3 sentences.';
// Regression: a bare file name is a scope, but "settings.json" must NOT count as an output schema
const FILENAME_NOT_SCHEMA = 'Check settings.json for the retry policy and describe what you find.';

test('deny: no scope and no limit names both', () => {
  const o = call(VAGUE);
  assert.strictEqual(decision(o), 'deny');
  assert.match(reason(o), /NAMED SCOPE/);
  assert.match(reason(o), /SIZE LIMIT/);
});
test('deny: scope present, limit missing', () => {
  const o = call(NO_LIMIT);
  assert.strictEqual(decision(o), 'deny');
  assert.match(reason(o), /SIZE LIMIT/);
  assert.doesNotMatch(reason(o), /NAMED SCOPE/);
});
test('deny: limit present, scope missing', () => {
  const o = call(NO_SCOPE);
  assert.strictEqual(decision(o), 'deny');
  assert.match(reason(o), /NAMED SCOPE/);
  assert.doesNotMatch(reason(o), /SIZE LIMIT/);
});
test('deny: file name alone is not an output schema', () => {
  const o = call(FILENAME_NOT_SCHEMA);
  assert.strictEqual(decision(o), 'deny');
  assert.match(reason(o), /SIZE LIMIT/);
});
test('deny: Task tool name is covered too', () => {
  assert.strictEqual(decision(call(VAGUE, 'Task')), 'deny');
});

test('allow: scope + limit', () => assert.strictEqual(decision(call(GOOD)), 'allow'));
test('allow counterparts for each scope signal', () => {
  const limit = ' Answer in 3 sentences.';
  for (const scope of [
    'Read `parseConfig` and explain it.',
    'Read README.md and explain it.',
    'Read src/lib/util and explain it.',
    'Read C:\\work\\notes and explain it.',
    'Fetch https://example.com/status and explain it.',
  ]) assert.strictEqual(decision(call(scope + limit)), 'allow', scope);
});
test('allow counterparts for each limit signal', () => {
  const scope = 'Read `build.log`. ';
  for (const lim of [
    'Answer: max 10 lines.', 'At most 4 bullets.', 'Return JSON only.', 'Use this schema: {a: int}.',
    'Give a table with 5 rows.', 'Reply with one number.', 'Reply yes/no.', 'Exactly 2 sentences.',
    'Up to 50 words.',
  ]) assert.strictEqual(decision(call(scope + lim)), 'allow', lim);
});
test('allow: non-Agent tool is ignored', () => {
  assert.strictEqual(decision(run({ tool_name: 'Bash', tool_input: { command: 'ls' } })), 'allow');
});

test('bypass: guardrail:broad with reason allows and is audited', () => {
  const o = call(VAGUE + '\nguardrail:broad reason="exploratory survey of unknown repo"');
  assert.strictEqual(decision(o), 'allow');
  const rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.hook === 'delegation-guard' && r.event === 'bypass' && r.marker === 'broad'));
});
test('bypass: generic guardrail:confirmed with reason allows', () => {
  assert.strictEqual(decision(call(VAGUE + '\nguardrail:confirmed reason="owner approved broad scope"')), 'allow');
});
test('bypass: marker without a reason, or with a short one, is ignored', () => {
  assert.strictEqual(decision(call(VAGUE + '\nguardrail:broad')), 'deny');
  assert.strictEqual(decision(call(VAGUE + '\nguardrail:broad reason="short"')), 'deny');
});

test('bypass: marker mid-sentence inside quotes is ignored', () => {
  const o = call(VAGUE + ' The pasted note says "guardrail:broad reason=\\"exploratory survey of repo\\"" somewhere.');
  assert.strictEqual(decision(o), 'deny');
  assert.strictEqual(decision(call(VAGUE + ' He wrote: guardrail:broad reason="exploratory survey of repo"')), 'deny');
});
test('bypass: reason of 8 characters but mostly whitespace is ignored', () => {
  assert.strictEqual(decision(call(VAGUE + '\nguardrail:broad reason="a  b  c  d"')), 'deny');
});
test('bypass: denied when the audit log cannot be written', () => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: VAGUE + '\nguardrail:broad reason="exploratory survey"' } }),
    encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: path.join(__dirname, '..', 'tests') }, // a directory: not writable as a file
  });
  const o = JSON.parse(res.stdout);
  assert.strictEqual(decision(o), 'deny');
  assert.match(reason(o), /could not be logged/);
});
test('allow: a URL alone counts as scope', () => {
  assert.strictEqual(decision(call('Summarize https://example.com/changelog in 3 sentences.')), 'allow');
});

test('malformed input fails open (synthetic)', () => {
  assert.deepStrictEqual(run('not json'), {});
});
