'use strict';
// Tests for scripts/delegation-log.js.
//
// Subagent transcripts are synthetic JSONL shaped after the real format: assistant rows repeat
// the same message.id while streaming (the LAST row of an id carries the final usage), tool_use
// blocks carry an id, rows carry timestamps. Expected values are computed independently in this
// file. Payloads follow the documented fields (PostToolUse: tool_input, tool_response with
// status/agentId/resolvedModel, tool_use_id; SubagentStop: agent_id, agent_type,
// agent_transcript_path). Contract outcomes are produced by running return-contract.js itself.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'delegation-log.js');
const RC_HOOK = path.join(__dirname, '..', 'scripts', 'return-contract.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
const LOG = path.join(TMP, 'audit.jsonl');
const AGENTS = path.join(TMP, 'agents');
fs.mkdirSync(AGENTS);
fs.writeFileSync(path.join(AGENTS, 'capped.md'), '---\nname: capped\nmaxTurns: 3\n---\nBody.\n');
fs.writeFileSync(path.join(AGENTS, 'roomy.md'), '---\nname: roomy\nmaxTurns: 40\n---\nBody.\n');
fs.writeFileSync(path.join(AGENTS, 'nocap.md'), '---\nname: nocap\nmodel: sonnet\n---\nBody.\n');

function run(input, env = {}, raw = false, hook = HOOK) {
  const res = spawnSync(process.execPath, [hook], {
    input: raw ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, GUARDRAIL_AUDIT_LOG: LOG, GUARDRAIL_AGENTS_DIR: AGENTS, ...env },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout || '{}');
}
const rows = (hook = 'delegation-log') => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.hook === hook)
  : []);
const lastStop = (id) => rows().filter((r) => r.event === 'stop' && r.agent_id === id).pop() || {};

// Transcript: 3 assistant messages (m1 streamed in two rows), 4 tool_use blocks, a user row.
const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const asst = (id, model, usage, content, s) => ({ type: 'assistant', timestamp: iso(s), message: { id, role: 'assistant', model, usage, content } });
const ROWS = [
  { type: 'user', timestamp: iso(0), message: { role: 'user', content: 'Do the task.' } },
  asst('m1', 'model-a', { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 }, [{ type: 'text', text: 'partial' }], 1),
  asst('m1', 'model-a', { input_tokens: 10, output_tokens: 30, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }, { type: 'tool_use', id: 'tu2', name: 'Read', input: {} }], 2),
  asst('m2', 'model-a', { input_tokens: 5, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 110 },
    [{ type: 'tool_use', id: 'tu3', name: 'Grep', input: {} }], 5),
  asst('m3', 'model-b', { input_tokens: 2, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 120 },
    [{ type: 'tool_use', id: 'tu4', name: 'SubagentHandback', input: {} }], 9),
  'garbage line that is not JSON',
];
const TRANSCRIPT = path.join(TMP, 'agent-a1.jsonl');
fs.writeFileSync(TRANSCRIPT, ROWS.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
const stop = (id, type, extra = {}) => ({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: id, agent_type: type,
  agent_transcript_path: TRANSCRIPT, ...extra });

test('stop row: usage deduplicated by message.id (last row wins), turns, tool uses, models, timing', () => {
  assert.deepStrictEqual(run(stop('a1', 'nocap')), {});
  const r = lastStop('a1');
  assert.strictEqual(r.turns, 3);
  assert.strictEqual(r.input_tokens, 10 + 5 + 2);            // m1 counted once, not twice
  assert.strictEqual(r.output_tokens, 30 + 20 + 7);          // the final m1 row (30), not the partial (1)
  assert.strictEqual(r.cache_creation_input_tokens, 100);
  assert.strictEqual(r.cache_read_input_tokens, 110 + 120);
  assert.strictEqual(r.tool_uses, 4);
  assert.deepStrictEqual([...r.models].sort(), ['model-a', 'model-b']);
  assert.strictEqual(r.first_ts, iso(0));
  assert.strictEqual(r.last_ts, iso(9));
  assert.strictEqual(r.duration_ms, 9000);
});

test('transcript path derived from transcript_path + session_id + agent_id', () => {
  const sub = path.join(TMP, 'sess-7', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.copyFileSync(TRANSCRIPT, path.join(sub, 'agent-d1.jsonl'));
  run({ hook_event_name: 'SubagentStop', session_id: 'sess-7', agent_id: 'd1', agent_type: 'nocap', transcript_path: path.join(TMP, 'sess-7.jsonl') });
  assert.strictEqual(lastStop('d1').turns, 3);
});

test('max_turns / cap_hit from the agent file frontmatter', () => {
  run(stop('c1', 'capped'));   // 3 turns, cap 3
  assert.deepStrictEqual([lastStop('c1').max_turns, lastStop('c1').cap_hit], [3, true]);
  run(stop('c2', 'roomy'));
  assert.deepStrictEqual([lastStop('c2').max_turns, lastStop('c2').cap_hit], [40, false]);
  for (const [id, type] of [['c3', 'nocap'], ['c4', 'general-purpose'], ['c5', 'Explore']]) {
    run(stop(id, type));
    assert.deepStrictEqual([lastStop(id).max_turns, lastStop(id).cap_hit], [null, false], type);
  }
});

test('launch row from a PostToolUse payload (object and JSON-string tool_response)', () => {
  const input = { description: 'audit rules', subagent_type: 'capped', model: 'sonnet', prompt: 'Read `a.md`.\nRETURN: contract-v1' };
  const resp = { status: 'async_launched', agentId: 'ag-77', description: 'audit rules', resolvedModel: 'model-a' };
  for (const [i, tr] of [resp, JSON.stringify(resp)].entries()) {
    const tool = i === 0 ? 'Agent' : 'Task';
    assert.deepStrictEqual(run({ hook_event_name: 'PostToolUse', tool_name: tool, session_id: 's1', tool_use_id: 'toolu_' + i, tool_input: input, tool_response: tr }), {});
    const r = rows().filter((x) => x.event === 'launch').pop();
    assert.deepStrictEqual(
      [r.agent_id, r.tool_use_id, r.agent_type, r.requested_model, r.resolved_model, r.description, r.contract_requested, r.is_async],
      ['ag-77', 'toolu_' + i, 'capped', 'sonnet', 'model-a', 'audit rules', true, true]);
  }
});

test('launch row: absent tool_response -> nulls, no throw; prompt without the line -> contract_requested false', () => {
  run({ hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 's1', tool_input: { prompt: 'p' } });
  const r = rows().filter((x) => x.event === 'launch').pop();
  assert.deepStrictEqual([r.agent_id, r.resolved_model, r.is_async, r.agent_type, r.contract_requested], [null, null, null, 'general-purpose', false]);
});

test('edge cases: empty agent_type -> no row; missing transcript -> stop row with error; unrelated event -> {}', () => {
  const before = rows().length;
  assert.deepStrictEqual(run(stop('e1', '')), {});
  assert.strictEqual(rows().length, before);
  run(stop('e2', 'nocap', { agent_transcript_path: path.join(TMP, 'nope.jsonl') }));
  const r = lastStop('e2');
  assert.strictEqual(r.error, 'transcript-unreadable');
  assert.deepStrictEqual(run({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} }), {});
});

test('malformed stdin: {} exit 0 + error row, also under GUARDRAIL_FAIL_CLOSED=1', () => {
  assert.deepStrictEqual(run('{not json', { GUARDRAIL_FAIL_CLOSED: '1' }, true), {});
  assert.ok(rows().some((r) => r.event === 'error'));
});

// Contract outcome: drive the real return-contract.js so the rows are the ones it writes.
const SPEC_INJECT_PROMPT = 'Do the task.\nRETURN: contract-v1';
function rcTranscript(name, requested) {
  const SENT = '<!-- return-contract-v1:injected -->';
  const text = requested ? SPEC_INJECT_PROMPT + '\n\n' + SENT : 'Do the task.';
  const f = path.join(TMP, name + '.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n' +
    JSON.stringify({ type: 'assistant', timestamp: iso(1), message: { id: 'x1', role: 'assistant', content: [{ type: 'tool_use', id: 'q', name: 'SubagentHandback', input: {} }] } }) + '\n');
  return f;
}
const FENCE = '`'.repeat(3);
const GOOD = 'ok\n' + FENCE + 'json\n' + JSON.stringify({ contract: 'v1', status: 'DONE', summary: 's',
  findings: [{ claim: 'c', evidence: 'e', basis: 'read' }], not_measured: [] }) + '\n' + FENCE;
const hb = (id, f, m) => run({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', session_id: 's1', agent_id: id, agent_type: 'nocap',
  agent_transcript_path: f, tool_input: { message: m } }, {}, false, RC_HOOK);
const outcome = (id, f) => { run(stop(id, 'nocap', { agent_transcript_path: f })); return lastStop(id).contract; };

test('contract outcome: pass, pass-after-retry, failed-let-through, none', () => {
  const f = rcTranscript('rc-req', true);
  hb('k1', f, GOOD);
  assert.deepStrictEqual(outcome('k1', f), { requested: true, denies: 0, final: 'pass' });
  hb('k2', f, 'bad'); hb('k2', f, GOOD);
  assert.deepStrictEqual(outcome('k2', f), { requested: true, denies: 1, final: 'pass-after-retry' });
  hb('k3', f, 'bad'); hb('k3', f, 'bad'); hb('k3', f, 'bad');
  assert.deepStrictEqual(outcome('k3', f), { requested: true, denies: 2, final: 'failed-let-through' });
  hb('k4', f, 'bad');
  assert.deepStrictEqual(outcome('k4', f), { requested: true, denies: 1, final: 'blocked-once' });
  hb('k5', f, 'x\nguardrail:confirmed reason="caller accepts free text"');
  assert.deepStrictEqual(outcome('k5', f), { requested: true, denies: 0, final: 'bypassed' });
  const g = rcTranscript('rc-not', false);
  hb('k6', g, 'bad');
  assert.deepStrictEqual(outcome('k6', g), { requested: false, denies: 0, final: 'none' });
});

test('contract outcome: unreadable/corrupt audit log -> none (fail open); a late stop-path row is invisible', () => {
  const { contractOutcome } = require(HOOK);
  assert.deepStrictEqual(contractOutcome(undefined), { requested: false, denies: 0, final: 'none' });
  assert.deepStrictEqual(contractOutcome('x', []), { requested: false, denies: 0, final: 'none' });
  // requested but only non-verdict rows -> stays "none" (unknown does not collapse into pass)
  assert.deepStrictEqual(contractOutcome('x', [{ event: 'inject', requested: true }, { event: 'skip-handback', requested: true }]),
    { requested: true, denies: 0, final: 'none' });
  assert.deepStrictEqual(contractOutcome('x', [{ event: 'block', requested: true }, { event: 'allow-after-retry', requested: true }]),
    { requested: true, denies: 0, final: 'failed-let-through' });
  assert.deepStrictEqual(contractOutcome('x', [{ event: 'block', requested: true }, { event: 'allow', requested: true }]),
    { requested: true, denies: 0, final: 'pass-after-retry' });
  const corrupt = path.join(TMP, 'corrupt.jsonl');
  fs.writeFileSync(corrupt, 'not json\n{"hook":"return-contract","agent_id":"z"\n');
  run(stop('z', 'nocap'), { GUARDRAIL_AUDIT_LOG: corrupt });
  const r = fs.readFileSync(corrupt, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter((x) => x && x.event === 'stop').pop();
  assert.strictEqual(r.contract.final, 'none');
});
