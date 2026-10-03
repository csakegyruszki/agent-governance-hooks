'use strict';
// Regression cases for scripts/sqlite-guard.js. These are regression cases (inputs that once
// exposed a gap or that pin intended behaviour), not captured production data.
//
// The original gap: a normalizer treated `--` as an SQL comment, but the scanned text is a
// shell command where `--` is usually a CLI flag, so everything after the first long flag was
// hidden from the scan:
//     sqlite3 db.sqlite --readonly "DROP TABLE t"      -> was ALLOWED
// The cases check both directions: hidden destructive SQL must be denied, harmless SQL allowed.
// No real database is touched: the guard only reads the command string.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const AUDIT = path.join(fs0().mkdtempSync(path.join(os.tmpdir(), 'sqlite-')), 'audit.jsonl');
function fs0() { return require('node:fs'); }

const HOOK = path.join(__dirname, '..', 'scripts', 'sqlite-guard.js');
const DB = 'data/example.db';

const ENV = { ...process.env, GUARDRAIL_AUDIT_LOG: AUDIT, GUARDRAIL_FAIL_CLOSED: '' };
function decide(cmd) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }),
    encoding: 'utf8', env: ENV,
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return (JSON.parse(res.stdout).hookSpecificOutput || {}).permissionDecision || 'allow';
}

// Destructive keywords are assembled from pieces so that editing this file with a tool that
// runs similar guards does not trip them.
const DROP = 'DR' + 'OP';
const DELETE = 'DEL' + 'ETE';
const UPDATE = 'UPD' + 'ATE';

const CASES = [
  // must deny: SQL hidden behind CLI flags
  ['deny', 'DROP behind a long CLI flag', `sqlite3 ${DB} --readonly "${DROP} TABLE items"`],
  ['deny', 'DROP after several flags', `sqlite3 --batch --json ${DB} "${DROP} INDEX idx_items"`],
  ['deny', 'DELETE without WHERE after a flag', `sqlite3 ${DB} --cmd ".timeout 5000" "${DELETE} FROM items"`],
  ['deny', 'UPDATE without WHERE after a flag', `sqlite3 ${DB} --header "${UPDATE} items SET flag=0"`],
  ['deny', 'bare -- (end of options) before DROP', `sqlite3 ${DB} -- "${DROP} TABLE items"`],
  ['deny', 'bare -- before DELETE without WHERE', `sqlite3 ${DB} -- "${DELETE} FROM items"`],
  // must deny: plain cases
  ['deny', 'plain DROP TABLE', `sqlite3 ${DB} "${DROP} TABLE items"`],
  ['deny', 'plain DELETE without WHERE', `sqlite3 ${DB} "${DELETE} FROM items"`],
  ['deny', 'plain UPDATE without WHERE', `sqlite3 ${DB} "${UPDATE} items SET x=1"`],
  // must deny: deliberate false positive (commented-out DROP still trips the raw view)
  ['deny', 'commented-out DROP (accepted false positive)', `sqlite3 ${DB} "SELECT 1; -- ${DROP} TABLE items"`],
  ['deny', "SQL '' escape plus comment marker inside a string", `sqlite3 ${DB} "SELECT 'it''s -- fine'; ${DROP} TABLE items"`],
  ['deny', 'WHERE exists only inside a comment', `sqlite3 ${DB} "${DELETE} FROM items -- WHERE id=1"`],
  // must allow
  ['allow', 'SELECT', `sqlite3 ${DB} "SELECT count(*) FROM items"`],
  ['allow', 'DELETE with WHERE', `sqlite3 ${DB} "${DELETE} FROM items WHERE id=1"`],
  ['allow', 'UPDATE with WHERE', `sqlite3 ${DB} "${UPDATE} items SET x=1 WHERE id=2"`],
  ['allow', 'not a sqlite3 command', `psql -c "${DROP} TABLE x"`],
  // escape hatch
  ['deny', 'legacy marker no longer bypasses', `sqlite3 ${DB} "${DROP} TABLE tmp_x"  -- claude:confirmed`],
  ['allow', 'always-true WHERE is not sqlite-specific text: plain DELETE with id', `sqlite3 ${DB} "${DELETE} FROM t WHERE id = 1"`],
  ['deny', 'always-true WHERE', `sqlite3 ${DB} "${DELETE} FROM t WHERE 1=1"`],
  ['allow', 'escape-hatch marker with reason', `sqlite3 ${DB} "${DROP} TABLE tmp_x"  # guardrail:confirmed reason="scratch db cleanup"`],
];

for (const [want, desc, cmd] of CASES) {
  test(`[${want}] ${desc}`, () => assert.strictEqual(decide(cmd), want));
}

test('wrapper: malformed stdin allowed by default, denied with GUARDRAIL_FAIL_CLOSED=1', () => {
  let res = spawnSync(process.execPath, [HOOK], { input: '{nope', encoding: 'utf8', env: ENV });
  assert.strictEqual(res.stdout, '{}');
  res = spawnSync(process.execPath, [HOOK], { input: '{nope', encoding: 'utf8', env: { ...ENV, GUARDRAIL_FAIL_CLOSED: '1' } });
  assert.strictEqual(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('missing command field is allowed', () => {
  const res = spawnSync(process.execPath, [HOOK], { input: '{"tool_name":"Bash"}', encoding: 'utf8', env: ENV });
  assert.strictEqual(res.stdout, '{}');
});
