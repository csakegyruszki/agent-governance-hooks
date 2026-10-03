'use strict';
// Tests for scripts/instruction-budget-lint.js and scripts/instruction-budget-baseline.js.
// All files live in temp dirs; HOME/USERPROFILE point at a temp home. No network.
// Two-directional on purpose: the hook must speak on growth AND stay silent on unchanged/shrunk
// files - a positive-only test would not notice a gate that complains about everything.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const HOOK = path.join(SCRIPTS, 'instruction-budget-lint.js');
const BASELINE = path.join(SCRIPTS, 'instruction-budget-baseline.js');
const lint = require(HOOK);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ibl-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const LOG = path.join(TMP, 'audit.jsonl');

let seq = 0;
function project() {
  const d = path.join(TMP, 'proj' + (seq++));
  fs.mkdirSync(path.join(d, '.claude', 'rules'), { recursive: true });
  return d;
}
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const baseEnv = (extra = {}) => ({
  ...process.env, HOME, USERPROFILE: HOME, GUARDRAIL_AUDIT_LOG: LOG,
  GUARDRAIL_INSTRUCTION_FILES: '', GUARDRAIL_INSTRUCTION_BUDGET: '', CLAUDE_PROJECT_DIR: '', ...extra,
});

function hook(dir, payload, extra = {}, rawInput) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: rawInput !== undefined ? rawInput : JSON.stringify({ cwd: dir, ...payload }),
    encoding: 'utf8', env: baseEnv({ CLAUDE_PROJECT_DIR: dir, ...extra }),
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const o = JSON.parse(res.stdout);
  assert.ok(!(o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision), 'must never deny');
  return o;
}
const edit = (file, tool = 'Edit') => ({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: file } });
const writeBudget = (dir, files, loc) => write(loc || path.join(dir, '.claude', 'instruction-budget.json'),
  JSON.stringify({ files }));
const E = (chars, ceiling, extra = {}) => ({ chars, ceiling, baseline_date: '2026-01-01', layer: 'ALWAYS_LOADED', ...extra });
const ctx = (o) => (o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '';

// ---- assess ----------------------------------------------------------------
test('assess: unchanged -> OK', () => assert.strictEqual(lint.assess(E(1000, 1100), 1000).verdict, 'OK'));
test('assess: shrunk -> OK, negative delta', () => {
  const r = lint.assess(E(1000, 1100), 800);
  assert.strictEqual(r.verdict, 'OK');
  assert.strictEqual(r.delta, -200);
});
test('assess: grew below ceiling -> GREW', () => assert.strictEqual(lint.assess(E(1000, 1100), 1050).verdict, 'GREW'));
test('assess: exactly at ceiling is still GREW; one above is OVER_CEILING', () => {
  assert.strictEqual(lint.assess(E(1000, 1100), 1100).verdict, 'GREW');
  assert.strictEqual(lint.assess(E(1000, 1100), 1101).verdict, 'OVER_CEILING');
});
test('assess: missing entry does not throw', () => assert.strictEqual(lint.assess(null, 5).verdict, 'GREW'));

// ---- isPathScoped ------------------------------------------------------------
test('isPathScoped: paths: in frontmatter -> true', () =>
  assert.strictEqual(lint.isPathScoped('---\npaths:\n  - "**/*.py"\n---\n# X'), true));
test('isPathScoped: no frontmatter -> false', () => assert.strictEqual(lint.isPathScoped('# T\n\ntext'), false));
test('isPathScoped: frontmatter without paths -> false', () =>
  assert.strictEqual(lint.isPathScoped('---\nname: x\n---\n# X'), false));
test('REGRESSION: `paths:` mentioned in the body is not path-scoping', () =>
  assert.strictEqual(lint.isPathScoped('# T\n\nThe `paths:` key matters.'), false));
test('REGRESSION: `paths:` in the body after unrelated frontmatter is not path-scoping', () =>
  assert.strictEqual(lint.isPathScoped('---\nname: x\n---\npaths: a\n'), false));
test('isPathScoped: CRLF frontmatter works', () =>
  assert.strictEqual(lint.isPathScoped('---\r\npaths:\r\n  - a\r\n---\r\nbody'), true));

// ---- countChars: the unit traps ----------------------------------------------
test('REGRESSION: counts code points, not UTF-16 code units (emoji)', () => {
  const s = 'ab\u{1F534}cd';
  assert.strictEqual(s.length, 6);
  assert.strictEqual(lint.countChars(s), 5);
});
test('REGRESSION: CRLF counts as one newline', () => {
  assert.strictEqual(lint.countChars('a\r\nb'), 3);
  assert.strictEqual(lint.countChars('a\nb'), 3);
});
test('countChars: emoji and CRLF together; empty/null -> 0', () => {
  assert.strictEqual(lint.countChars('\u{1F534}\r\n\u{1F534}'), 3);
  assert.strictEqual(lint.countChars(''), 0);
  assert.strictEqual(lint.countChars(null), 0);
});

// ---- glob matching -----------------------------------------------------------
test('globToRegExp: ** crosses directories, * does not', () => {
  const re = lint.globToRegExp('/p/.claude/rules/**/*.md');
  assert.ok(re.test('/p/.claude/rules/a.md'));
  assert.ok(re.test('/p/.claude/rules/x/y/a.md'));
  assert.ok(!re.test('/p/.claude/rules/a.txt'));
  assert.ok(!lint.globToRegExp('/p/*.md').test('/p/x/a.md'));
});
test('globToRegExp: regex metacharacters in a path are literal', () => {
  assert.ok(lint.globToRegExp('/p/a+b(1).md').test('/p/a+b(1).md'));
  assert.ok(!lint.globToRegExp('/p/a.md').test('/p/aXmd'));
});
test('matchesAny: relative globs resolve against the project dir', () => {
  const d = project();
  assert.ok(lint.matchesAny(path.join(d, 'CLAUDE.md'), ['CLAUDE.md'], d));
  assert.ok(!lint.matchesAny(path.join(d, 'sub', 'CLAUDE.md'), ['CLAUDE.md'], d));
});

// ---- hook end to end ---------------------------------------------------------
test('hook: file that grew -> warns via additionalContext AND systemMessage', () => {
  const d = project();
  const f = write(path.join(d, 'CLAUDE.md'), 'x'.repeat(1050));
  writeBudget(d, { 'CLAUDE.md': E(1000, 1100) });
  const o = hook(d, edit(f));
  assert.strictEqual(o.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(ctx(o), /GREW/);
  assert.match(ctx(o), /\+50/);
  assert.strictEqual(o.systemMessage, ctx(o));
});
test('hook: over ceiling -> OVER ITS CEILING', () => {
  const d = project();
  const f = write(path.join(d, 'CLAUDE.md'), 'x'.repeat(1200));
  writeBudget(d, { 'CLAUDE.md': E(1000, 1100) });
  assert.match(ctx(hook(d, edit(f))), /OVER ITS CEILING/);
});
test('hook: unchanged and shrunk files stay silent', () => {
  const d = project();
  writeBudget(d, { 'CLAUDE.md': E(1000, 1100) });
  const f = write(path.join(d, 'CLAUDE.md'), 'x'.repeat(1000));
  assert.deepStrictEqual(hook(d, edit(f)), {});
  write(f, 'x'.repeat(500));
  assert.deepStrictEqual(hook(d, edit(f)), {});
});
test('REGRESSION: emoji + CRLF file at its baseline does not report growth', () => {
  const d = project();
  const body = 'a\u{1F534}\r\nb\u{1F534}\r\n';
  const f = write(path.join(d, 'CLAUDE.md'), body);
  writeBudget(d, { 'CLAUDE.md': E(lint.countChars(body), 100) });
  assert.deepStrictEqual(hook(d, edit(f)), {});
});
test('hook: new global rule (no paths:, no budget entry) -> warns', () => {
  const d = project();
  const f = write(path.join(d, '.claude', 'rules', 'new-rule.md'), '# Rule\n\nAlways do X.\n');
  const o = hook(d, edit(f, 'Write'));
  assert.match(ctx(o), /GLOBAL RULE WITHOUT A BUDGET ENTRY/);
  assert.match(ctx(o), /new-rule\.md/);
});
test('hook: rule with paths: frontmatter -> silent', () => {
  const d = project();
  const f = write(path.join(d, '.claude', 'rules', 'scoped.md'), '---\npaths:\n  - "**/*.py"\n---\n# Rule\n');
  assert.deepStrictEqual(hook(d, edit(f, 'Write')), {});
});
test('hook: budgeted rule is judged by size, not by the new-rule message', () => {
  const d = project();
  const f = write(path.join(d, '.claude', 'rules', 'known.md'), 'r'.repeat(300));
  writeBudget(d, { '.claude/rules/known.md': E(300, 330) });
  assert.deepStrictEqual(hook(d, edit(f)), {});
});
test('hook: MultiEdit is covered; Read/Bash tool names are ignored', () => {
  const d = project();
  const f = write(path.join(d, 'CLAUDE.md'), 'x'.repeat(1050));
  writeBudget(d, { 'CLAUDE.md': E(1000, 1100) });
  assert.match(ctx(hook(d, edit(f, 'MultiEdit'))), /GREW/);
  assert.deepStrictEqual(hook(d, edit(f, 'Read')), {});
  assert.deepStrictEqual(hook(d, { tool_name: 'Bash', tool_input: { command: 'echo' } }), {});
});
test('hook: file outside the always-loaded set -> silent', () => {
  const d = project();
  const f = write(path.join(d, 'docs', 'big.md'), 'x'.repeat(5000));
  writeBudget(d, { 'docs/big.md': E(10, 11) });
  assert.deepStrictEqual(hook(d, edit(f)), {});
});
test('hook: GUARDRAIL_INSTRUCTION_FILES overrides the default set', () => {
  const d = project();
  const f = write(path.join(d, 'AGENTS.md'), 'x'.repeat(1050));
  writeBudget(d, { 'AGENTS.md': E(1000, 1100) });
  assert.deepStrictEqual(hook(d, edit(f)), {}, 'AGENTS.md is not in the default set');
  assert.match(ctx(hook(d, edit(f), { GUARDRAIL_INSTRUCTION_FILES: 'AGENTS.md, docs/*.md' })), /GREW/);
});
test('hook: GUARDRAIL_INSTRUCTION_BUDGET relocates the budget file', () => {
  const d = project();
  const f = write(path.join(d, 'CLAUDE.md'), 'x'.repeat(1050));
  const alt = path.join(TMP, 'elsewhere', 'b.json');
  writeBudget(d, { 'CLAUDE.md': E(1000, 1100) }, alt);
  assert.deepStrictEqual(hook(d, edit(f)), {}, 'no budget at the default location -> nothing to compare');
  assert.match(ctx(hook(d, edit(f), { GUARDRAIL_INSTRUCTION_BUDGET: alt })), /GREW/);
});
test('hook: home-relative file is matched through a ~/ key', () => {
  const d = project();
  const f = write(path.join(HOME, '.claude', 'CLAUDE.md'), 'x'.repeat(1050));
  writeBudget(d, { '~/.claude/CLAUDE.md': E(1000, 1100) });
  assert.match(ctx(hook(d, edit(f))), /GREW/);
  fs.rmSync(f); // keep the shared temp home clean for the baseline tests
});
test('hook: PATH_SCOPED or non-ALWAYS_LOADED budget layer -> silent', () => {
  const d = project();
  const f = write(path.join(d, 'CLAUDE.md'), 'x'.repeat(2000));
  writeBudget(d, { 'CLAUDE.md': E(1000, 1100, { layer: 'PATH_SCOPED' }) });
  assert.deepStrictEqual(hook(d, edit(f)), {});
});
test('hook: missing budget file / missing edited file -> silent', () => {
  const d = project();
  const f = write(path.join(d, 'CLAUDE.md'), 'x'.repeat(50));
  assert.deepStrictEqual(hook(d, edit(f)), {});
  assert.deepStrictEqual(hook(d, edit(path.join(d, 'gone', 'CLAUDE.md'))), {});
});
test('REGRESSION: never denies on malformed input, even with GUARDRAIL_FAIL_CLOSED=1', () => {
  const d = project();
  for (const raw of ['not json', '[]', '']) {
    const o = hook(d, null, { GUARDRAIL_FAIL_CLOSED: '1' }, raw);
    assert.deepStrictEqual(o, {});
  }
});

// ---- baseline generator ------------------------------------------------------
function baseline(dir, args, extra = {}) {
  return spawnSync(process.execPath, [BASELINE, ...args], {
    cwd: dir, encoding: 'utf8', env: baseEnv(extra),
  });
}
test('baseline: dry run writes nothing; --write records ALWAYS_LOADED only, ceiling = baseline*1.1', () => {
  const d = project();
  write(path.join(d, 'CLAUDE.md'), 'x'.repeat(1000));
  write(path.join(d, '.claude', 'rules', 'glob.md'), '# global\n');
  write(path.join(d, '.claude', 'rules', 'sub', 'scoped.md'), '---\npaths:\n  - "*.py"\n---\nbody');
  const budget = path.join(d, '.claude', 'instruction-budget.json');

  const dry = baseline(d, []);
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.ok(!fs.existsSync(budget));

  const w = baseline(d, ['--write']);
  assert.strictEqual(w.status, 0, w.stderr);
  const doc = JSON.parse(fs.readFileSync(budget, 'utf8'));
  assert.deepStrictEqual(Object.keys(doc.files).sort(), ['.claude/rules/glob.md', 'CLAUDE.md']);
  assert.strictEqual(doc.files['CLAUDE.md'].chars, 1000);
  assert.strictEqual(doc.files['CLAUDE.md'].ceiling, 1100);
  assert.match(doc.files['CLAUDE.md'].baseline_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(doc.always_loaded_total_chars,
    doc.files['CLAUDE.md'].chars + doc.files['.claude/rules/glob.md'].chars);
});
test('baseline and hook measure the same: emoji + CRLF file is silent right after --write', () => {
  const d = project();
  const f = write(path.join(d, 'CLAUDE.md'), 'h\u{1F534}\r\n'.repeat(40));
  assert.strictEqual(baseline(d, ['--write']).status, 0);
  assert.deepStrictEqual(hook(d, edit(f)), {});
  write(f, fs.readFileSync(f, 'utf8') + 'more\n');
  assert.match(ctx(hook(d, edit(f))), /GREW/);
});
test('baseline --check: exit 0 within ceiling, 1 over ceiling, 1 on unbudgeted file, 2 without budget', () => {
  const d = project();
  const f = write(path.join(d, 'CLAUDE.md'), 'x'.repeat(1000));
  assert.strictEqual(baseline(d, ['--check']).status, 2);
  baseline(d, ['--write']);
  assert.strictEqual(baseline(d, ['--check']).status, 0);
  write(f, 'x'.repeat(1200));
  assert.strictEqual(baseline(d, ['--check']).status, 1);
  write(f, 'x'.repeat(1000));
  write(path.join(d, '.claude', 'rules', 'late.md'), '# late\n');
  const r = baseline(d, ['--check']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /NO ENTRY/);
});
test('baseline: rejects headroom below 1', () => {
  const d = project();
  assert.strictEqual(baseline(d, ['--headroom=0.5']).status, 2);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
