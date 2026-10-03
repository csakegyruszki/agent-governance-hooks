'use strict';
// Regression cases for scripts/sql-guard.js and its hooks.json matcher. These are regression
// cases (inputs that once exposed a gap or pin intended behaviour), not captured production data.
//
// The matcher is tested too: an earlier version of such a guard named a tool that no longer
// existed, so the logic was fine but the hook never ran. A test that only feeds stdin would have
// passed the whole time, so the matcher is asserted against the live tool names.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const AUDIT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlguard-')), 'audit.jsonl');
const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'sql-guard.js');
const HOOKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));

const EXEC = ['mcp__claude_ai_Supabase__execute_sql', 'mcp__plugin_supabase_supabase__execute_sql'];
const MIGR = ['mcp__claude_ai_Supabase__apply_migration', 'mcp__plugin_supabase_supabase__apply_migration'];
const EDGE = ['mcp__claude_ai_Supabase__deploy_edge_function', 'mcp__plugin_supabase_supabase__deploy_edge_function'];

function runRaw(input, env = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input, encoding: 'utf8', env: { ...process.env, GUARDRAIL_AUDIT_LOG: AUDIT, GUARDRAIL_FAIL_CLOSED: '', ...env },
  });
}
// '{}' (allow) has no hookSpecificOutput: treat as allow.
function runPayload(payload, env) {
  const res = runRaw(JSON.stringify(payload), env);
  assert.strictEqual(res.status, 0, res.stderr);
  return (JSON.parse(res.stdout || '{}').hookSpecificOutput || {}).permissionDecision || 'allow';
}
const sqlDecision = (tool, query) => runPayload({ tool_name: tool, tool_input: { query } });
const edgeDecision = (tool, contents) =>
  runPayload({ tool_name: tool, tool_input: { files: contents.map((c, i) => ({ name: `f${i}.ts`, content: c })) } });

// Keyword fragments avoid tripping similar guards while editing this file.
const DROP = 'DR' + 'OP';
const TRUNC = 'TRUN' + 'CATE';
const DEL = 'DEL' + 'ETE';
const UPD = 'UPD' + 'ATE';
const OK = 'guardrail:confirmed reason="scratch table cleanup"';

test('hooks.json: sql-guard matcher covers every guarded tool name', () => {
  const entry = HOOKS.hooks.PreToolUse.find((e) =>
    e.hooks.some((h) => h.command.includes('sql-guard.js')));
  assert.ok(entry, 'no PreToolUse entry for sql-guard.js');
  const re = new RegExp(entry.matcher);
  for (const tool of [...EXEC, ...MIGR, ...EDGE]) assert.ok(re.test(tool), `matcher misses ${tool}`);
  assert.ok(!re.test('mcp__claude_ai_Exa__web_search_exa'));
});

test('hooks.json: every referenced script exists and uses CLAUDE_PLUGIN_ROOT', () => {
  for (const e of HOOKS.hooks.PreToolUse) {
    for (const h of e.hooks) {
      assert.match(h.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w-]+\.js/);
      const rel = h.command.match(/scripts\/[\w-]+\.js/)[0];
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} missing`);
    }
  }
});

for (const tool of EXEC) {
  test(`deny destructive SQL via ${tool}`, () => {
    assert.strictEqual(sqlDecision(tool, `${DROP} TABLE users;`), 'deny');
    assert.strictEqual(sqlDecision(tool, `${TRUNC} orders;`), 'deny');
    assert.strictEqual(sqlDecision(tool, `${DEL} FROM users;`), 'deny');
    assert.strictEqual(sqlDecision(tool, `${UPD} users SET active = false;`), 'deny');
  });
  test(`allow safe SQL via ${tool}`, () => {
    assert.strictEqual(sqlDecision(tool, 'SELECT id, email FROM users LIMIT 10;'), 'allow');
    assert.strictEqual(sqlDecision(tool, `${UPD} users SET active = false WHERE id = 42;`), 'allow');
    assert.strictEqual(sqlDecision(tool, `${DEL} FROM users WHERE id = 42;`), 'allow');
  });
}

test('SQL-like prose on non-SQL tools is not scanned', () => {
  assert.strictEqual(sqlDecision('mcp__claude_ai_Exa__web_search_exa', `how do I ${DROP} TABLE safely`), 'allow');
  assert.strictEqual(sqlDecision('mcp__example__search', `${TRUNC} semantics in sqlite`), 'allow');
  assert.strictEqual(sqlDecision('Bash', ''), 'allow');
});

test('unknown namespace with a guarded tool suffix fails closed', () => {
  assert.strictEqual(sqlDecision('mcp__future_ns__execute_sql', `${DROP} TABLE users;`), 'deny');
  assert.strictEqual(sqlDecision('mcp__future_ns__execute_sql', 'SELECT 1;'), 'allow');
  assert.strictEqual(sqlDecision('', `${DROP} TABLE users;`), 'deny');
  assert.strictEqual(sqlDecision('mcp__future_ns__apply_migration', `${DROP} TABLE users;`), 'deny');
  assert.strictEqual(edgeDecision('mcp__future_ns__deploy_edge_function', [`await sql\`${DROP} TABLE users\`;`]), 'deny');
});

test('escape-hatch marker allows destructive SQL', () => {
  assert.strictEqual(sqlDecision(EXEC[0], `-- ${OK}\n${DROP} TABLE scratch_tmp;`), 'allow');
});

for (const tool of MIGR) {
  test(`apply_migration via ${tool}`, () => {
    assert.strictEqual(sqlDecision(tool, `${DROP} TABLE users;`), 'deny');
    assert.strictEqual(sqlDecision(tool, `${TRUNC} orders;`), 'deny');
    assert.strictEqual(sqlDecision(tool, 'CREATE TABLE t (id int primary key);'), 'allow');
    assert.strictEqual(sqlDecision(tool, 'ALTER TABLE t ADD COLUMN note text;'), 'allow');
    assert.strictEqual(sqlDecision(tool, `-- ${OK}\n${DROP} TABLE scratch_tmp;`), 'allow');
  });
}

for (const tool of EDGE) {
  test(`deploy_edge_function via ${tool}`, () => {
    assert.strictEqual(edgeDecision(tool, [`Deno.serve(async () => { await sql\`${DROP} TABLE audit_log\`; });`]), 'deny');
    assert.strictEqual(edgeDecision(tool, [`const q = "${TRUNC} events";`]), 'deny');
    assert.strictEqual(edgeDecision(tool, ['Deno.serve(() => new Response("ok"));']), 'allow');
    assert.strictEqual(edgeDecision(tool, [`// -- ${OK}\nawait sql\`${DROP} TABLE scratch_tmp\`;`]), 'allow');
  });
}

test('edge deploy: destructive SQL in a second file is caught', () => {
  assert.strictEqual(
    edgeDecision(EDGE[0], ['Deno.serve(() => new Response("ok"));', `export const t = "${DROP} TABLE users";`]),
    'deny');
});

test('edge deploy: no files field does not crash or block', () => {
  assert.strictEqual(runPayload({ tool_name: EDGE[0], tool_input: {} }), 'allow');
});

test('edge deploy: `--` is a decrement operator, not a SQL comment', () => {
  assert.strictEqual(edgeDecision(EDGE[0], [`let y = x--; await sql\`${DROP} TABLE users\`;`]), 'deny');
  assert.strictEqual(edgeDecision(EDGE[0], [`for (let i=n; i>0; i--) {} await sql\`${TRUNC} audit_log\`;`]), 'deny');
});

test('edge deploy: embedded DELETE/UPDATE need a WHERE', () => {
  assert.strictEqual(edgeDecision(EDGE[0], [`await sql\`${DEL} FROM users\`;`]), 'deny');
  assert.strictEqual(edgeDecision(EDGE[0], [`await sql\`${UPD} users SET active=false\`;`]), 'deny');
  assert.strictEqual(edgeDecision(EDGE[0], [`await sql\`${DEL} FROM users WHERE id = 42\`;`]), 'allow');
  assert.strictEqual(edgeDecision(EDGE[0], [`await sql\`${UPD} users SET active = false WHERE id = 42\`;`]), 'allow');
  assert.strictEqual(edgeDecision(EDGE[0], [`// -- ${OK}\nawait sql\`${DEL} FROM scratch_tmp\`;`]), 'allow');
});

test('fail-open: malformed JSON on stdin is allowed', () => {
  const res = runRaw('{nope');
  assert.strictEqual(res.stdout, '{}');
});

test('fail-closed: malformed JSON on stdin is denied with GUARDRAIL_FAIL_CLOSED=1', () => {
  const res = runRaw('{nope', { GUARDRAIL_FAIL_CLOSED: '1' });
  assert.strictEqual(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('fail-closed: empty stdin is denied with GUARDRAIL_FAIL_CLOSED=1', () => {
  assert.strictEqual(JSON.parse(runRaw('', { GUARDRAIL_FAIL_CLOSED: '1' }).stdout).hookSpecificOutput.permissionDecision, 'deny');
});

// regression cases: always-true WHERE clauses (A1)
const TAUT = [
  `${DEL} FROM users WHERE 1=1`,
  `${DEL} FROM users WHERE 1 = 1;`,
  `${DEL} FROM users WHERE true`,
  `${DEL} FROM users WHERE 'a'='a'`,
  `${UPD} users SET active=false WHERE id=id`,
  `${DEL} FROM users WHERE 1<>0`,
  `${DEL} FROM users WHERE NOT false`,
  `${DEL} FROM users WHERE 0=0`,
  `${DEL} FROM users WHERE (1=1)`,
  `${DEL} FROM users WHERE id = 5 OR 1=1`,
  `${UPD} users SET a=1 WHERE id = 5 or TRUE;`,
  `${DEL} FROM users WHERE 1=1 OR id = 5`,
  `${DEL} FROM users WHERE u.id = u.id`,
];
for (const q of TAUT) test(`deny always-true WHERE: ${q}`, () => assert.strictEqual(sqlDecision(EXEC[0], q), 'deny'));

const NOT_TAUT = [
  `${DEL} FROM users WHERE id = 1`,
  `${DEL} FROM users WHERE a = b`,
  `${UPD} users SET x=1 WHERE a.id = b.id`,
  `${DEL} FROM users WHERE 1=1 AND id = 5`,
  `${DEL} FROM users WHERE id = 5 OR id = 6`,
  `${DEL} FROM users WHERE 1<>1`,
  `${DEL} FROM users WHERE id = 10`,
  `${DEL} FROM users WHERE flag = true`,
  'SELECT * FROM users WHERE 1=1',
];
for (const q of NOT_TAUT) test(`allow non-tautological: ${q}`, () => assert.strictEqual(sqlDecision(EXEC[0], q), 'allow'));

test('normalisation only adds: `--` inside a string literal does not hide a later statement', () => {
  assert.strictEqual(sqlDecision(EXEC[0], `SELECT '--'; ${DROP} TABLE users;`), 'deny');
});

test('marker without a reason does NOT bypass; short reason does not either', () => {
  assert.strictEqual(sqlDecision(EXEC[0], `-- guardrail:confirmed
${DROP} TABLE t;`), 'deny');
  assert.strictEqual(sqlDecision(EXEC[0], `-- guardrail:confirmed reason="ok"
${DROP} TABLE t;`), 'deny');
  assert.strictEqual(sqlDecision(EXEC[0], `-- claude:confirmed
${DROP} TABLE t;`), 'deny');
});

test('marker inside a string literal cannot authorise a destructive statement', () => {
  assert.strictEqual(sqlDecision(EXEC[0], `SELECT '-- guardrail:confirmed reason="xxxxxxxx"'; ${DROP} TABLE t`), 'deny');
});

test('marker with whitespace-only padding in the reason does not bypass', () => {
  assert.strictEqual(sqlDecision(EXEC[0], `-- guardrail:confirmed reason="a b  c"\n${DROP} TABLE t;`), 'deny');
});

test('bypass is written to the audit log with its reason', () => {
  fs.rmSync(AUDIT, { force: true });
  assert.strictEqual(sqlDecision(EXEC[0], `-- ${OK}\n${DROP} TABLE scratch_tmp;`), 'allow');
  const rec = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.event === 'bypass');
  assert.ok(rec, 'no bypass record');
  assert.strictEqual(rec.hook, 'sql-guard');
  assert.strictEqual(rec.reason, 'scratch table cleanup');
  assert.strictEqual(rec.tool, EXEC[0]);
});

test('bypass is refused when the audit log cannot be written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlguard-bad-'));
  // a directory path as the log file: appendFileSync fails
  const res = runRaw(JSON.stringify({ tool_name: EXEC[0], tool_input: { query: `-- ${OK}\n${DROP} TABLE t;` } }),
    { GUARDRAIL_AUDIT_LOG: dir });
  assert.strictEqual(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.stdout, /could not be logged/);
});

test('invalid payload shapes: null, array, non-string query -> fail mode', () => {
  for (const bad of ['null', '[]', JSON.stringify({ tool_name: EXEC[0], tool_input: { query: {} } })]) {
    assert.strictEqual(runRaw(bad).stdout, '{}', bad);
    assert.strictEqual(JSON.parse(runRaw(bad, { GUARDRAIL_FAIL_CLOSED: '1' }).stdout).hookSpecificOutput.permissionDecision, 'deny', bad);
  }
});

test('extra always-true cases: 2>1 denied, scalar subquery caught, string literal is not DML', () => {
  assert.strictEqual(sqlDecision(EXEC[0], `${DEL} FROM users WHERE 2>1`), 'deny');
  assert.strictEqual(sqlDecision(EXEC[0], `${DEL} FROM users WHERE id=7 OR (SELECT 1)=1`), 'deny');
  assert.strictEqual(sqlDecision(EXEC[0], `SELECT 'WHERE 1=1'`), 'allow');
  assert.strictEqual(sqlDecision(EXEC[0], `${DEL} FROM users WHERE 1>2`), 'allow');
});
