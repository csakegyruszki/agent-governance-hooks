'use strict';
// Regression cases for scripts/sql-cli-guard.js (Bash matcher: psql, mysql, mariadb, duckdb,
// sqlite3). Concrete strings, not captured production data. No database is touched: the guard
// only reads the command string and, for `< f.sql` style references, small files created here.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'sql-cli-guard.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcli-'));
const AUDIT = path.join(TMP, 'audit.jsonl');

function runRaw(input, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input, encoding: 'utf8', cwd: TMP,
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: AUDIT, GUARDRAIL_FAIL_CLOSED: '', ...env },
  });
}
function decide(cmd, env) {
  const res = runRaw(JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }), env);
  assert.strictEqual(res.status, 0, res.stderr);
  return (JSON.parse(res.stdout).hookSpecificOutput || {}).permissionDecision || 'allow';
}

const DROP = 'DR' + 'OP';
const DEL = 'DEL' + 'ETE';
const UPD = 'UPD' + 'ATE';
const TRUNC = 'TRUN' + 'CATE';
const OK = '-- guardrail:confirmed reason="scratch db cleanup"';

fs.writeFileSync(path.join(TMP, 'bad.sql'), `SELECT 1;\n${DROP} TABLE items;\n`);
fs.writeFileSync(path.join(TMP, 'good.sql'), 'SELECT 1;\nSELECT 2;\n');
fs.writeFileSync(path.join(TMP, 'taut.sql'), `${DEL} FROM items WHERE 1=1;\n`);
fs.writeFileSync(path.join(TMP, 'big.sql'), `SELECT 1; ${DROP} TABLE x;\n` + '-- pad\n'.repeat(160000));

const CASES = [
  // deny: each client, each entry route
  ['deny', 'psql -c', `psql -h db -c "${DROP} TABLE items"`],
  ['deny', 'psql --command', `psql --command="${TRUNC} items"`],
  ['deny', 'mysql -e', `mysql -u root -e "${DEL} FROM items"`],
  ['deny', 'mariadb -e', `mariadb -e "${UPD} items SET x=1"`],
  ['deny', 'duckdb inline', `duckdb data.db "${DROP} TABLE items"`],
  ['deny', 'sqlite3 behind a flag', `sqlite3 data.db --readonly "${DROP} TABLE items"`],
  ['deny', 'heredoc body', `psql <<'EOF'\n${DROP} TABLE items;\nEOF`],
  ['deny', 'heredoc, tautological delete', `psql <<EOF\n${DEL} FROM items WHERE 1=1;\nEOF`],
  ['deny', 'ALTER TABLE DROP COLUMN', `psql -c "ALTER TABLE t ${DROP} COLUMN c"`],
  ['deny', 'WHERE only inside a comment', `sqlite3 d.db "${DEL} FROM items -- WHERE id=1"`],
  ['deny', 'SQL file via <', 'psql < bad.sql'],
  ['deny', 'SQL file via -f', 'psql -f bad.sql'],
  ['deny', 'SQL file via --file=', 'psql --file=bad.sql'],
  ['deny', 'SQL file via .read', 'sqlite3 d.db ".read bad.sql"'],
  ['deny', 'SQL file via mysql source', `mysql -e "source bad.sql"`],
  ['deny', 'tautological DELETE inside a file', 'psql -f taut.sql'],
  ['deny', '-- inside a string does not hide the next statement', `psql -c "SELECT '--'; ${DROP} TABLE t"`],
  // deny: A1 tautologies
  ['deny', 'WHERE 1=1', `psql -c "${DEL} FROM t WHERE 1=1"`],
  ['deny', 'WHERE 1 = 1', `psql -c "${DEL} FROM t WHERE 1 = 1"`],
  ['deny', 'WHERE true', `psql -c "${UPD} t SET a=1 WHERE true"`],
  ['deny', "WHERE 'a'='a'", `sqlite3 d.db "${DEL} FROM t WHERE 'a'='a'"`],
  ['deny', 'WHERE x=x', `psql -c "${DEL} FROM t WHERE id = id"`],
  ['deny', 'WHERE 1<>0', `psql -c "${DEL} FROM t WHERE 1<>0"`],
  ['deny', 'WHERE NOT false', `psql -c "${DEL} FROM t WHERE NOT false"`],
  ['deny', 'WHERE 0=0', `psql -c "${DEL} FROM t WHERE 0=0"`],
  ['deny', 'WHERE 2>1', `psql -c "${DEL} FROM t WHERE 2>1"`],
  ['deny', 'trailing OR 1=1', `psql -c "${DEL} FROM t WHERE id=5 OR 1=1"`],
  ['deny', 'leading 1=1 OR', `psql -c "${DEL} FROM t WHERE 1=1 OR id=5"`],
  ['deny', 'OR (SELECT 1)=1 (best effort)', `psql -c "${DEL} FROM t WHERE id=7 OR (SELECT 1)=1"`],
  // allow
  ['allow', 'psql --version', 'psql --version'],
  ['allow', 'SELECT via psql', 'psql -c "SELECT * FROM t WHERE 1=1"'],
  ['allow', 'SELECT via sqlite3', 'sqlite3 d.db "SELECT count(*) FROM items"'],
  ['allow', 'DELETE with WHERE id', `psql -c "${DEL} FROM t WHERE id = 1"`],
  ['allow', 'WHERE a = b (different identifiers)', `psql -c "${DEL} FROM t WHERE a = b"`],
  ['allow', 'UPDATE with real WHERE', `mysql -e "${UPD} t SET x=1 WHERE id=2"`],
  ['allow', '1=1 AND real condition', `psql -c "${DEL} FROM t WHERE 1=1 AND id=5"`],
  ['allow', '1<>1 is not a tautology', `psql -c "${DEL} FROM t WHERE 1<>1"`],
  ['allow', 'harmless SQL file', 'psql -f good.sql'],
  ['allow', 'non-SQL command mentioning nothing', 'ls -la'],
  ['allow', 'destructive text but no SQL client', `echo "${DROP} TABLE x"`],
  ['allow', 'string literal that contains WHERE 1=1 is not DML', `psql -c "SELECT 'WHERE 1=1'"`],
  // marker
  ['allow', 'marker with reason (shell comment)', `psql -c "${DROP} TABLE tmp_x" # guardrail:confirmed reason="scratch db cleanup"`],
  ['allow', 'marker with reason (SQL comment, heredoc)', `psql <<EOF\n${OK}\n${DROP} TABLE tmp_x;\nEOF`],
  ['deny', 'marker without a reason', `psql -c "${DROP} TABLE t" # guardrail:confirmed`],
  ['deny', 'marker with a short reason', `psql -c "${DROP} TABLE t" # guardrail:confirmed reason="short"`],
  ['deny', 'legacy marker no longer bypasses', `psql -c "${DROP} TABLE t" -- claude:confirmed`],
  ['deny', 'marker inside a string literal cannot authorise another statement',
    `psql <<EOF\nSELECT '-- guardrail:confirmed reason="xxxxxxxx"'; ${DROP} TABLE t;\nEOF`],
  // documented over-block: quotes are not stripped, so a quoted, never-executed command trips it
  ['deny', 'echo of a quoted psql command (known over-block)', `echo 'psql -c "${DROP} TABLE t"'`],
];
for (const [want, desc, cmd] of CASES) test(`[${want}] ${desc}`, () => assert.strictEqual(decide(cmd), want));

test('unreadable file: allowed + audited by default, denied under GUARDRAIL_FAIL_CLOSED=1', () => {
  fs.rmSync(AUDIT, { force: true });
  assert.strictEqual(decide('psql -f missing.sql'), 'allow');
  assert.ok(fs.readFileSync(AUDIT, 'utf8').includes('file-unreadable'));
  assert.strictEqual(decide('psql -f missing.sql', { GUARDRAIL_FAIL_CLOSED: '1' }), 'deny');
});

test('file over 1 MB is a known limit: allowed by default, denied under fail-closed', () => {
  assert.strictEqual(decide('psql -f big.sql'), 'allow');
  assert.strictEqual(decide('psql -f big.sql', { GUARDRAIL_FAIL_CLOSED: '1' }), 'deny');
});

test('shell variable indirection is a known limit (not seen)', () => {
  assert.strictEqual(decide(`q=$(printf '%s %s' ${'DR' + 'OP'} 'TABLE t'); sqlite3 d.db "$q"`), 'allow');
});

test('bypass is audited with reason and tool', () => {
  fs.rmSync(AUDIT, { force: true });
  decide(`psql -c "${DROP} TABLE tmp_x" # guardrail:confirmed reason="scratch db cleanup"`);
  const rec = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.event === 'bypass');
  assert.ok(rec);
  assert.strictEqual(rec.hook, 'sql-cli-guard');
  assert.strictEqual(rec.reason, 'scratch db cleanup');
  assert.strictEqual(rec.tool, 'Bash');
});

test('bypass is refused when the audit log cannot be written', () => {
  const res = runRaw(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `psql -c "${DROP} TABLE t" # guardrail:confirmed reason="scratch db cleanup"` } }),
    { GUARDRAIL_AUDIT_LOG: TMP });
  assert.strictEqual(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('missing command field is allowed (not a Bash SQL call)', () => {
  assert.strictEqual(runRaw('{"tool_name":"Bash"}').stdout, '{}');
});

test('malformed payloads: allow by default, deny under GUARDRAIL_FAIL_CLOSED=1', () => {
  const bad = ['{nope', '', 'null', '[]', JSON.stringify({ tool_input: { command: {} } })];
  for (const b of bad) {
    assert.strictEqual(runRaw(b).stdout, '{}', `default: ${b}`);
    const out = JSON.parse(runRaw(b, { GUARDRAIL_FAIL_CLOSED: '1' }).stdout);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny', `fail-closed: ${b}`);
  }
});
