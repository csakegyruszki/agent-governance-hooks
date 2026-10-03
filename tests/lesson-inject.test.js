'use strict';
// Tests for scripts/lesson-inject.js.
//
// Lessons come from examples/lessons/ (the public sample shipped in this repo): two critical
// lessons (one with top-level applies_to, one under metadata:) and one severity-normal lesson.
// Hook payloads are synthetic, shaped after the documented fields (hook_event_name, agent_id,
// agent_type, last_assistant_message). The audit log is redirected to a temp file.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'lesson-inject.js');
const LESSONS = path.join(__dirname, '..', 'examples', 'lessons');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'li-'));
const LOG = path.join(TMP, 'audit.jsonl');

function run(input, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: LOG, GUARDRAIL_LESSONS_DIR: LESSONS, ...env },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}
const start = (agent_type, agent_id = 'a1') =>
  run({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id, agent_type });
const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('inject: critical + exact agent_type (top-level and metadata applies_to)', () => {
  const o = start('general-purpose', 'a-inject');
  const ctx = o.hookSpecificOutput.additionalContext;
  assert.strictEqual(o.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(ctx, /empty-result-tool-down/);
  assert.match(ctx, /test-on-real-data/);
  assert.doesNotMatch(ctx, /prefer-short-reports/); // severity normal
  assert.match(ctx, /INFORMATION:/);
  assert.ok(ctx.length <= 900, `length ${ctx.length}`);
  assert.ok(rows().some((r) => r.event === 'inject' && r.agent_id === 'a-inject'));
});
test('inject: only the lesson that matches the agent type', () => {
  const ctx = start('Explore').hookSpecificOutput.additionalContext;
  assert.match(ctx, /empty-result-tool-down/);
  assert.doesNotMatch(ctx, /test-on-real-data/);
});
test('no inject: agent type without lessons, case mismatch, missing type', () => {
  assert.deepStrictEqual(start('researcher'), {});
  assert.deepStrictEqual(start('explore'), {});
  assert.deepStrictEqual(run({ hook_event_name: 'SubagentStart', agent_id: 'x' }), {});
});
test('no lessons dir configured: does nothing', () => {
  assert.deepStrictEqual(
    run({ hook_event_name: 'SubagentStart', agent_id: 'x', agent_type: 'general-purpose' }, { GUARDRAIL_LESSONS_DIR: '' }), {});
});
test('limits: max 3 lessons and 900 chars with long descriptions (synthetic lessons dir)', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'many-'));
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(dir, `l${i}.md`),
      `---\nname: lesson-${i}\ndescription: ${'long description '.repeat(40)}\nseverity: critical\napplies_to: [worker]\n---\nbody\n`);
  }
  const ctx = start_with(dir).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= 900, `length ${ctx.length}`);
  assert.strictEqual((ctx.match(/^- lesson-/gm) || []).length, 3);
  function start_with(d) {
    return run({ hook_event_name: 'SubagentStart', agent_id: 'a-many', agent_type: 'worker' }, { GUARDRAIL_LESSONS_DIR: d });
  }
});

test('attest: true when final message has an INFORMATION: line', () => {
  start('general-purpose', 'a-attest-yes');
  const o = run({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a-attest-yes', agent_type: 'general-purpose',
    last_assistant_message: 'Done.\nINFORMATION: empty-result-tool-down = applied' });
  assert.deepStrictEqual(o, {});
  const r = rows().filter((x) => x.event === 'attest' && x.agent_id === 'a-attest-yes');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].attested, true);
});
test('attest: reads the INFORMATION line from a SubagentHandback call when last_assistant_message is empty', () => {
  // Regression: subagents that return their report via a SubagentHandback tool call were logged as
  // not attested. The transcript line below follows the shape of a real Claude Code subagent
  // transcript entry (assistant message with a tool_use block); its text is synthetic.
  start('general-purpose', 'a-handback');
  const transcript = path.join(TMP, 'agent-a-handback.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'task' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SubagentHandback',
      input: { message: 'Findings ...\nINFORMATION: test-on-real-data = applied' } }] } }),
  ].join('\n') + '\n');
  run({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a-handback', agent_type: 'general-purpose',
    last_assistant_message: '', agent_transcript_path: transcript });
  const r = rows().filter((x) => x.event === 'attest' && x.agent_id === 'a-handback').pop();
  assert.strictEqual(r.attested, true);
  assert.strictEqual(r.source, 'handback');
});
test('attest: false with reason when the line names no injected lesson', () => {
  start('general-purpose', 'a-attest-wrong');
  run({ hook_event_name: 'SubagentStop', agent_id: 'a-attest-wrong', agent_type: 'general-purpose',
    last_assistant_message: 'INFORMATION: applied' });
  const r = rows().filter((x) => x.event === 'attest' && x.agent_id === 'a-attest-wrong');
  assert.strictEqual(r[0].attested, false);
  assert.strictEqual(r[0].reason, 'no matching lesson name');
});
test('attest: lesson name match is case-insensitive', () => {
  start('Explore', 'a-attest-case');
  run({ hook_event_name: 'SubagentStop', agent_id: 'a-attest-case', agent_type: 'Explore',
    last_assistant_message: 'INFORMATION: EMPTY-RESULT-TOOL-DOWN = applied' });
  assert.strictEqual(rows().filter((x) => x.agent_id === 'a-attest-case' && x.event === 'attest')[0].attested, true);
});
test('malformed lesson frontmatter is skipped and audited (synthetic lessons dir)', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'bad-'));
  fs.writeFileSync(path.join(dir, 'nofm.md'), 'no frontmatter here\n');
  fs.writeFileSync(path.join(dir, 'nosev.md'), '---\nname: x\ndescription: d\napplies_to: [worker]\n---\n');
  const o = run({ hook_event_name: 'SubagentStart', agent_id: 'a-bad', agent_type: 'worker' }, { GUARDRAIL_LESSONS_DIR: dir });
  assert.deepStrictEqual(o, {});
  const r = rows().filter((x) => x.event === 'lesson_skipped');
  assert.ok(r.some((x) => x.file === 'nofm.md' && x.reason === 'no frontmatter'));
  assert.ok(r.some((x) => x.file === 'nosev.md' && x.reason === 'missing severity'));
});
test('attest: false when the line is missing', () => {
  start('general-purpose', 'a-attest-no');
  run({ hook_event_name: 'SubagentStop', agent_id: 'a-attest-no', agent_type: 'general-purpose', last_assistant_message: 'Done.' });
  const r = rows().filter((x) => x.event === 'attest' && x.agent_id === 'a-attest-no');
  assert.strictEqual(r[0].attested, false);
});
test('attest: nothing logged for an agent that was never injected', () => {
  run({ hook_event_name: 'SubagentStop', agent_id: 'a-never', agent_type: 'general-purpose', last_assistant_message: 'INFORMATION: x' });
  assert.strictEqual(rows().filter((x) => x.agent_id === 'a-never').length, 0);
});
test('malformed input fails open (synthetic)', () => {
  const res = spawnSync(process.execPath, [HOOK], { input: 'nope', encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: LOG, GUARDRAIL_LESSONS_DIR: LESSONS } });
  assert.strictEqual(res.stdout, '{}');
});
test('malformed input under GUARDRAIL_FAIL_CLOSED=1 still outputs {} (never denies) and audits an error', () => {
  const log = path.join(TMP, 'fc.jsonl');
  const res = spawnSync(process.execPath, [HOOK], { input: 'nope', encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: log, GUARDRAIL_LESSONS_DIR: LESSONS, GUARDRAIL_FAIL_CLOSED: '1' } });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, '{}');
  assert.ok(fs.readFileSync(log, 'utf8').includes('"event":"error"'));
});
