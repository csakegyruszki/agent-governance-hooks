'use strict';
// Regression cases for gaps found by an adversarial test run against v0.2.0 (2026-10-03).
// Each case is a concrete input that exposed the gap; they are labelled regression cases, not
// captured production data. Fake secrets are built at runtime.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = (name) => path.join(__dirname, '..', 'scripts', `${name}.js`);
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-adv-'));

function runHook(name, payload, env = {}) {
  const r = spawnSync(process.execPath, [S(name)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000, // the original gap was a hang; a timeout here fails the test instead of stalling
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: path.join(SANDBOX, 'audit.jsonl'), ...env },
  });
  assert.strictEqual(r.error, undefined, `hook ${name} did not finish: ${r.error}`);
  return r.stdout;
}
const denied = (out) => /"permissionDecision":"deny"/.test(out);
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('audit log with an uncreatable parent: hook still decides (no hang) and refuses the bypass', () => {
  const missing = path.join(SANDBOX, 'no', 'such', 'parent', 'audit.jsonl');
  const out = runHook('secret-guard',
    bash('git add .env  # guardrail:confirmed reason="tracking a dummy env file"'),
    { GUARDRAIL_AUDIT_LOG: missing });
  assert.ok(denied(out), out);
  assert.match(out, /could not be logged/);
  assert.ok(!fs.existsSync(path.dirname(missing)), 'must not create the missing parent chain');
});

test('audit log with an uncreatable parent: a normal allow still returns promptly', () => {
  const missing = path.join(SANDBOX, 'no', 'such', 'parent2', 'audit.jsonl');
  const out = runHook('no-nested-agent', { tool_name: 'Agent', tool_input: { prompt: 'x' } },
    { GUARDRAIL_AUDIT_LOG: missing });
  assert.strictEqual(out, '{}');
});

test('secret-guard: prefixed env files count as secret files', () => {
  for (const c of ['git add prod.env', 'git add docs/a.env', 'git add config/app.env.local']) {
    assert.ok(denied(runHook('secret-guard', bash(c))), c);
  }
  for (const c of ['git add .env.example', 'git add app.env.sample', 'git add docs/env.md']) {
    assert.ok(!denied(runHook('secret-guard', bash(c))), c);
  }
});

test('sql-guard and sql-cli-guard write a deny audit record', () => {
  const log = path.join(SANDBOX, 'deny-audit.jsonl');
  runHook('sql-guard', { tool_name: 'mcp__x__execute_sql', tool_input: { query: 'DELETE FROM t' } },
    { GUARDRAIL_AUDIT_LOG: log });
  runHook('sql-cli-guard', bash('sqlite3 app.db "DELETE FROM t"'), { GUARDRAIL_AUDIT_LOG: log });
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.hook === 'sql-guard' && r.event === 'deny'));
  assert.ok(rows.some((r) => r.hook === 'sql-cli-guard' && r.event === 'deny'));
});

test('no-nested-agent: agent_id inside tool_input also counts as subagent origin (synthetic shape)', () => {
  const out = runHook('no-nested-agent',
    { tool_name: 'Agent', tool_input: { prompt: 'x', agent_id: 'placeholder-agent-id' } });
  assert.ok(denied(out), out);
});
