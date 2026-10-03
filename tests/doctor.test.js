'use strict';
// Tests for scripts/doctor.js. The audit logs here are synthetic regression fixtures.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DOCTOR = path.join(__dirname, '..', 'scripts', 'doctor.js');

function doctor(logLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  const log = path.join(dir, 'audit.jsonl');
  if (logLines) fs.writeFileSync(log, logLines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const res = spawnSync(process.execPath, [DOCTOR], { encoding: 'utf8', env: { ...process.env, GUARDRAIL_AUDIT_LOG: log } });
  return { res, log };
}

test('exit code is 0 and the report covers Node, hooks.json and the audit log', () => {
  const { res } = doctor(null);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /\[ok\] Node /);
  assert.match(res.stdout, /hooks\.json/);
  assert.match(res.stdout, /audit log writable/);
});

test('no Agent/Task event logged: agent_id reported UNKNOWN, never "absent"', () => {
  const { res } = doctor(null);
  assert.match(res.stdout, /UNKNOWN/);
  assert.match(res.stdout, /unverified/);
  assert.doesNotMatch(res.stdout, /absent(?!\))/);
});

test('only has_agent_id:false events: still unverified', () => {
  const { res } = doctor([{ hook: 'no-nested-agent', event: 'seen', has_agent_id: false }]);
  assert.match(res.stdout, /1 Agent\/Task call\(s\) seen/);
  assert.match(res.stdout, /unverified/);
});

test('a has_agent_id:true event is reported as observed; corrupt lines are skipped', () => {
  const { res } = doctor(['{corrupt', { hook: 'no-nested-agent', event: 'seen', has_agent_id: true }]);
  assert.match(res.stdout, /\[ok\] agent_id observed 1 time/);
});

test('unwritable audit path is a WARN, still exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-dir-'));
  const res = spawnSync(process.execPath, [DOCTOR], { encoding: 'utf8', env: { ...process.env, GUARDRAIL_AUDIT_LOG: dir } });
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /\[WARN\] audit log NOT writable/);
});
