'use strict';
// Tests for scripts/doc-touch-gate.js.
//
// Synthetic cases (labelled): every project tree is created under a temp directory the test makes;
// hook payloads are shaped after the documented PostToolUse / Stop fields (hook_event_name, tool_name,
// tool_input.file_path, session_id, stop_hook_active). State and audit log are redirected to the temp dir.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'doc-touch-gate.js');
const gate = require(HOOK);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')).replace(/\\/g, '/');
const WORK = TMP + '/work';
const LOG = TMP + '/audit.jsonl';
const STATE = TMP + '/state';
const IGNORED = TMP + '/dotclaude';
const GLOBS = [
  WORK + '/research/*',
  WORK + '/cases/*/*',
  WORK + '/code/*',
  WORK + '/projects/*',
  '!' + WORK + '/cases/tools',
].join(path.delimiter);
const ENV = {
  ...process.env,
  GUARDRAIL_AUDIT_LOG: LOG,
  GUARDRAIL_DOC_STATE_DIR: STATE,
  GUARDRAIL_DOC_IGNORE_DIRS: IGNORED,
  GUARDRAIL_DOC_PROJECT_GLOBS: GLOBS,
};
delete ENV.GUARDRAIL_DOC_MEMORY_FILE;
delete ENV.GUARDRAIL_DOC_LOG_FILE;
delete ENV.GUARDRAIL_DOC_MIN_FILES;

function run(input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...ENV, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}
const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
let sess = 0;
const newSession = () => 'sess-' + (++sess);
const post = (s, file, tool = 'Edit', env) => run({ hook_event_name: 'PostToolUse', tool_name: tool, session_id: s, tool_input: { file_path: file } }, env);
const stop = (s, active = false, env) => run({ hook_event_name: 'Stop', session_id: s, stop_hook_active: active }, env);
const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, 'x'); };

const P = {
  research: WORK + '/research/alpha',
  cases: WORK + '/cases/group-1/case-9',
  projects: WORK + '/projects/beta',
  code: WORK + '/code/gamma',
};
const SUB = ['README.md', 'scripts/make_queue.py', 'logs/run1.txt', 'manifest/m.json'];
const files = (root, names) => names.map((f) => root + '/' + f);
const cfg = gate.loadConfig(ENV);
const root = (p) => { const m = gate.mapProject(p, undefined, cfg); return m && m.root; };

test('mapping: all four patterns, backslashes, case-insensitive', () => {
  assert.strictEqual(root(P.research.replace(/\//g, '\\') + '\\README.md'), P.research.replace(/\//g, '\\').replace(/\\/g, '/'));
  assert.strictEqual(root(P.cases.toUpperCase() + '/x.md'), P.cases.toUpperCase());
  assert.strictEqual(root(P.projects + '/.claude/settings.json'), P.projects);
  assert.strictEqual(root(P.code + '/PROJECT_MEMORY.md'), P.code);
});
test('mapping: a file directly in a pattern parent is not a project; unmatched and excluded dirs are not projects', () => {
  assert.strictEqual(root(WORK + '/cases/group-1/CLAUDE.md'), null);
  assert.strictEqual(root(WORK + '/research/INDEX.md'), null);
  assert.strictEqual(root(WORK + '/archive/foo/a.md'), null);
  assert.strictEqual(root(WORK + '/cases/tools/x/a.md'), null);
  assert.strictEqual(root(WORK + '/research/.cache/a.md'), null);
  assert.strictEqual(root(WORK + '/research/_tmp/a.md'), null);
});
test('mapping: ignore dir wins, also for a project-lookalike path below it', () => {
  assert.strictEqual(root(IGNORED + '/docs/a.md'), null);
  assert.strictEqual(root(IGNORED + '/projects/x' + WORK + '/code/y/a.md'), null);
});
test('substantive rules follow the configured file names', () => {
  const c = gate.loadConfig({ GUARDRAIL_DOC_MEMORY_FILE: 'STATE.md', GUARDRAIL_DOC_LOG_FILE: 'CHANGES.md' });
  assert.ok(gate.isSubstantive('a/b.md', c));
  assert.ok(!gate.isSubstantive('STATE.md', c) && !gate.isSubstantive('x/CHANGES.md', c));
  assert.ok(!gate.isSubstantive('archive/old.md', c) && !gate.isSubstantive('Archive/Old.md', c));
  assert.ok(gate.isSubstantive('PROJECT_MEMORY.md', c)); // not the configured memory file here
});

test('below threshold: 3 edits but 2 distinct files -> no block, logged', () => {
  const s = newSession();
  for (const f of files(P.research, ['README.md', 'README.md', 'scripts/make_queue.py'])) post(s, f);
  assert.strictEqual(stop(s), '{}');
  assert.ok(rows().some((r) => r.session_id === s && r.action === 'allow-below-threshold'));
});

test('3 distinct files -> block once naming project, count, memory and log file; later Stops pass', () => {
  const s = newSession();
  for (const f of files(P.research, SUB.slice(0, 3))) post(s, f);
  const r = JSON.parse(stop(s));
  assert.strictEqual(r.decision, 'block');
  for (const part of [P.research, '3 files', 'PROJECT_MEMORY.md', '_LOG.md']) assert.ok(r.reason.includes(part), part);
  assert.strictEqual(stop(s, true), '{}');
  assert.strictEqual(stop(s, false), '{}');
  assert.ok(rows().some((x) => x.session_id === s && x.action === 'block'));
  assert.ok(rows().some((x) => x.session_id === s && x.action === 'allow-already-blocked'));
});

test('stop_hook_active already true on first sight -> pass, logged, not block', () => {
  const s = newSession();
  for (const f of files(P.cases, SUB.slice(0, 3))) post(s, f);
  assert.strictEqual(stop(s, true), '{}');
  assert.ok(rows().some((x) => x.session_id === s && x.action === 'allow-stop-hook-active'));
});

test('memory file edited AFTER the last substantive edit -> pass; BEFORE it -> block', () => {
  let s = newSession();
  for (const f of files(P.research, SUB.slice(0, 3))) post(s, f);
  post(s, P.research + '/PROJECT_MEMORY.md', 'Write');
  assert.strictEqual(stop(s), '{}');
  assert.ok(rows().some((x) => x.session_id === s && x.action === 'allow-memory-updated'));

  s = newSession();
  post(s, P.projects + '/PROJECT_MEMORY.md', 'Edit');
  for (const f of files(P.projects, SUB.slice(0, 3))) post(s, f);
  assert.strictEqual(JSON.parse(stop(s)).decision, 'block');

  s = newSession();
  for (const f of files(P.projects, SUB.slice(0, 3))) post(s, f);
  post(s, P.projects + '/PROJECT_MEMORY.md', 'MultiEdit');
  post(s, P.projects + '/' + SUB[3]);
  assert.strictEqual(JSON.parse(stop(s)).decision, 'block');
});

test('memory file, log file and archive/ do not count toward the threshold', () => {
  const s = newSession();
  for (const f of [P.code + '/README.md', P.code + '/_LOG.md', P.code + '/archive/old.md', P.code + '/Archive/older.md']) post(s, f);
  assert.strictEqual(stop(s), '{}');
});

test('configured memory file name and threshold are honoured', () => {
  const env = { GUARDRAIL_DOC_MEMORY_FILE: 'STATE.md', GUARDRAIL_DOC_LOG_FILE: 'CHANGES.md', GUARDRAIL_DOC_MIN_FILES: '2' };
  let s = newSession();
  for (const f of files(P.code, ['a.md', 'b.md'])) post(s, f, 'Edit', env);
  const r = JSON.parse(stop(s, false, env));
  assert.strictEqual(r.decision, 'block');
  assert.ok(r.reason.includes('STATE.md') && r.reason.includes('CHANGES.md'));
  assert.ok(!r.reason.includes('PROJECT_MEMORY.md'));
  s = newSession();
  for (const f of files(P.code, ['a.md', 'b.md'])) post(s, f, 'Edit', env);
  post(s, P.code + '/STATE.md', 'Write', env);
  assert.strictEqual(stop(s, false, env), '{}');
});

test('non-edit tools, non-project paths and ignored dirs record nothing', () => {
  const s = newSession();
  post(s, P.research + '/a.md', 'Read');
  post(s, TMP + '/elsewhere/a.md');
  post(s, IGNORED + '/docs/a.md');
  assert.ok(!fs.existsSync(STATE + '/' + s + '.json'));
  assert.strictEqual(stop(s), '{}');
});

test('missing skeleton -> the reason names the scaffolder; complete skeleton -> no hint', () => {
  let s = newSession();
  for (const f of files(P.research, SUB.slice(0, 3))) post(s, f);
  let r = JSON.parse(stop(s));
  assert.ok(r.reason.includes('project_init.py') && r.reason.includes('skeleton missing'));
  s = newSession();
  touch(P.cases + '/PROJECT_MEMORY.md'); touch(P.cases + '/_LOG.md'); touch(P.cases + '/.claude/settings.json');
  for (const f of files(P.cases, SUB.slice(0, 3))) post(s, f);
  r = JSON.parse(stop(s));
  assert.strictEqual(r.decision, 'block');
  assert.ok(!r.reason.includes('project_init.py'));
});

test('two projects in one session: one combined block, each blocked only once', () => {
  const s = newSession();
  for (const f of files(P.research, SUB.slice(0, 3))) post(s, f);
  for (const f of files(P.code, SUB.slice(0, 3))) post(s, f);
  const r = JSON.parse(stop(s));
  assert.ok(r.reason.includes(P.research) && r.reason.includes(P.code));
  assert.strictEqual(stop(s), '{}');
});

test('no globs configured: project root is the nearest ancestor with .git or the memory file', () => {
  const env = { GUARDRAIL_DOC_PROJECT_GLOBS: '' };
  const repo = TMP + '/auto/repo-a';
  fs.mkdirSync(repo + '/.git', { recursive: true });
  const memProj = TMP + '/auto/mem-b';
  touch(memProj + '/PROJECT_MEMORY.md');
  const s = newSession();
  for (const f of files(repo, ['src/a.js', 'src/b.js', 'c.md'])) post(s, f, 'Edit', env);
  const r = JSON.parse(stop(s, false, env));
  assert.strictEqual(r.decision, 'block');
  assert.ok(r.reason.includes(repo));
  const s2 = newSession();
  for (const f of files(memProj, ['a.md', 'b.md', 'c.md'])) post(s2, f, 'Edit', env);
  assert.ok(JSON.parse(stop(s2, false, env)).reason.includes(memProj));
  const s3 = newSession();
  post(s3, TMP + '/auto/loose/a.md', 'Edit', env);
  assert.ok(!fs.existsSync(STATE + '/' + s3 + '.json'));
});

test('advisory fail-open: garbage stdin, unrelated event, unusable state dir, even with GUARDRAIL_FAIL_CLOSED=1', () => {
  const closed = { GUARDRAIL_FAIL_CLOSED: '1' };
  assert.strictEqual(run('not json', closed), '{}');
  assert.strictEqual(run({ hook_event_name: 'SessionStart' }), '{}');
  const blocker = TMP + '/a-file';
  fs.writeFileSync(blocker, 'x');
  const env = { GUARDRAIL_DOC_STATE_DIR: blocker + '/nope', ...closed };
  assert.strictEqual(post('bad-state', P.code + '/a.md', 'Edit', env), '{}');
  assert.ok(rows().some((r) => r.hook === 'doc-touch-gate' && r.event === 'error'));
});
