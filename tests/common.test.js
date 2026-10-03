'use strict';
// Tests for scripts/lib/common.js (shared by every hook). Regression cases, synthetic strings.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const common = require('../scripts/lib/common');

test('confirmedReason: valid marker returns the reason', () => {
  assert.strictEqual(common.confirmedReason('x guardrail:confirmed reason="cleanup of scratch"'), 'cleanup of scratch');
  assert.strictEqual(common.confirmedReason('GUARDRAIL:CONFIRMED  reason = "cleanup of scratch"'), 'cleanup of scratch');
});

test('confirmedReason: missing, empty, short or whitespace-padded reason is rejected', () => {
  for (const t of [
    'guardrail:confirmed', 'guardrail:confirmed reason=""', 'guardrail:confirmed reason="short"',
    'guardrail:confirmed reason="a b  c  "', 'guardrail:confirmed reason=cleanup-no-quotes',
    '-- claude:confirmed', '', null, undefined,
  ]) assert.strictEqual(common.confirmedReason(t), null, String(t));
});

test('audit writes JSONL to GUARDRAIL_AUDIT_LOG; auditStrict reports failure instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'common-'));
  const log = path.join(dir, 'sub', 'audit.jsonl');
  const prev = process.env.GUARDRAIL_AUDIT_LOG;
  try {
    process.env.GUARDRAIL_AUDIT_LOG = log;
    common.audit('t', { event: 'x', n: 1 });
    assert.strictEqual(common.auditStrict('t', { event: 'y' }), true);
    const recs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(recs.map((r) => r.event), ['x', 'y']);
    assert.ok(recs[0].ts && recs[0].hook === 't');
    process.env.GUARDRAIL_AUDIT_LOG = dir; // a directory: cannot be appended to
    assert.strictEqual(common.auditStrict('t', { event: 'z' }), false);
    assert.doesNotThrow(() => common.audit('t', { event: 'z' }));
  } finally {
    if (prev === undefined) delete process.env.GUARDRAIL_AUDIT_LOG; else process.env.GUARDRAIL_AUDIT_LOG = prev;
  }
});
