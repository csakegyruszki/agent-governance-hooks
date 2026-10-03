#!/usr/bin/env node
'use strict';
// instruction-budget-lint.js - PostToolUse hook (Write|Edit|MultiEdit). WARN-ONLY: it never denies.
//
// Why: every character of an always-loaded instruction file (CLAUDE.md, a rule without `paths:`)
// is paid in EVERY session, whether or not the topic comes up. Such files grow one reasonable
// addition at a time and a one-off cleanup does not stay done. This hook notices the growth at
// the moment it happens.
//
// Event: PostToolUse, not PreToolUse. The warning needs the size of the file AFTER the edit, and
// that only exists once the tool has run. PostToolUse supports hookSpecificOutput.additionalContext
// ("Claude sees it", delivered next to the tool result) and a top-level systemMessage (shown to the
// user) - https://code.claude.com/docs/en/hooks (PostToolUse decision control, "Add context for
// Claude"). PreToolUse has no way to see the result, so it is the wrong event for this check.
//
// Checks, for a Write/Edit/MultiEdit target that is in the always-loaded set:
//   1. file above its recorded baseline (GREW) or above its ceiling (OVER_CEILING)
//   2. a `.claude/rules/**/*.md` file with no `paths:` frontmatter and no budget entry: it is
//      global the moment it exists
//
// Always-loaded set: GUARDRAIL_INSTRUCTION_FILES (comma or newline separated globs; relative globs
// resolve against the project dir, `~/` against the home dir). Default:
//   CLAUDE.md, .claude/CLAUDE.md, ~/.claude/CLAUDE.md, .claude/rules/**/*.md, ~/.claude/rules/**/*.md
// A file in the set that has `paths:` frontmatter is path-scoped, so it is NOT always-loaded.
// Budget file: GUARDRAIL_INSTRUCTION_BUDGET, default <project>/.claude/instruction-budget.json
// (produced by scripts/instruction-budget-baseline.js).
//
// Unit: Unicode code points after CRLF -> LF. Not bytes, not UTF-16 code units, not tokens.
// Known blind spot: edits made through a shell command (Bash) fire no Write/Edit event. Re-measure
// periodically with `node scripts/instruction-budget-baseline.js --check`.
// Errors: never block, also under GUARDRAIL_FAIL_CLOSED=1 (a size warning is not worth a deny).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { allow, audit } = require('./lib/common');

const HOOK = 'instruction-budget-lint';
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const DEFAULT_GLOBS = [
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '~/.claude/CLAUDE.md',
  '.claude/rules/**/*.md',
  '~/.claude/rules/**/*.md',
];
const CI = process.platform === 'win32'; // case-insensitive path comparison

const fwd = (p) => String(p || '').replace(/\\/g, '/');

// Unicode code points, CRLF counted as one newline.
function countChars(text) {
  return Array.from(String(text || '').replace(/\r\n/g, '\n')).length;
}

// True when the file has a `paths:` key INSIDE its frontmatter. The word in the body does not count.
function isPathScoped(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  return !!(m && /^paths[ \t]*:/m.test(m[1]));
}

// Pure decision. Boundary: exactly at the ceiling is still GREW, one above is OVER_CEILING.
function assess(entry, actual) {
  const base = Number(entry && entry.chars) || 0;
  const ceiling = Number(entry && entry.ceiling) || 0;
  const delta = actual - base;
  if (ceiling && actual > ceiling) return { verdict: 'OVER_CEILING', delta };
  if (delta > 0) return { verdict: 'GREW', delta };
  return { verdict: 'OK', delta };
}

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function home() { return fwd(os.homedir()).replace(/\/$/, ''); }

// Resolve a glob (or key) to an absolute forward-slash path pattern.
function resolvePattern(pat, projectDir) {
  let p = fwd(pat.trim());
  if (p === '~' || p.startsWith('~/')) p = home() + p.slice(1);
  else if (!(p.startsWith('/') || /^[A-Za-z]:\//.test(p))) p = fwd(projectDir).replace(/\/$/, '') + '/' + p;
  return path.posix.normalize(p);
}

// Glob -> RegExp over forward-slash absolute paths: `**` any depth, `*` within a segment, `?` one char.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', CI ? 'i' : '');
}

function configuredGlobs(env) {
  const raw = env.GUARDRAIL_INSTRUCTION_FILES;
  if (!raw || !raw.trim()) return DEFAULT_GLOBS.slice();
  return raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function matchesAny(absPath, globs, projectDir) {
  const p = fwd(absPath);
  return globs.some((g) => globToRegExp(resolvePattern(g, projectDir)).test(p));
}

// Budget key for a file: project-relative, else ~/-relative, else absolute. Always forward slashes.
function budgetKey(absPath, projectDir) {
  const p = fwd(absPath);
  const cmp = (a, b) => (CI ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b));
  const proj = fwd(projectDir).replace(/\/$/, '') + '/';
  if (cmp(p, proj)) return p.slice(proj.length);
  const h = home() + '/';
  if (cmp(p, h)) return '~/' + p.slice(h.length);
  return p;
}

function budgetPath(env, projectDir) {
  const raw = env.GUARDRAIL_INSTRUCTION_BUDGET;
  if (raw && raw.trim()) return resolvePattern(raw, projectDir);
  return path.posix.join(fwd(projectDir), '.claude', 'instruction-budget.json');
}

function loadBudget(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d.files === 'object' && d.files ? d : null;
  } catch (_) { return null; }
}

function findEntry(files, key, absPath, projectDir) {
  if (files[key]) return { key, entry: files[key] };
  const want = resolvePattern(fwd(absPath), projectDir);
  for (const k of Object.keys(files)) {
    const got = resolvePattern(k, projectDir);
    if (CI ? got.toLowerCase() === want.toLowerCase() : got === want) return { key: k, entry: files[k] };
  }
  return null;
}

// Returns a warning string, or null. Pure apart from reading the edited file and the budget file.
function evaluate({ filePath, projectDir, env }) {
  const globs = configuredGlobs(env);
  if (!matchesAny(filePath, globs, projectDir)) return null;
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  if (isPathScoped(text)) return null; // path-scoped: costs nothing until read

  const chars = countChars(text);
  const name = path.posix.basename(fwd(filePath));
  const budget = loadBudget(budgetPath(env, projectDir));
  const found = budget ? findEntry(budget.files, budgetKey(filePath, projectDir), filePath, projectDir) : null;

  if (found) {
    if (found.entry.layer && found.entry.layer !== 'ALWAYS_LOADED') return null;
    const { verdict, delta } = assess(found.entry, chars);
    if (verdict === 'OK') return null;
    const head = verdict === 'OVER_CEILING'
      ? `instruction-budget: ${name} is OVER ITS CEILING`
      : `instruction-budget: ${name} GREW (always-loaded)`;
    return `${head}\n` +
      `  baseline ${fmt(found.entry.chars)} (${found.entry.baseline_date || 'undated'}) -> now ${fmt(chars)} ` +
      `(${delta > 0 ? '+' : ''}${fmt(delta)} code points), ceiling ${fmt(found.entry.ceiling)}\n` +
      '  -> This is paid in every session. Does it need to be known BEFORE opening the detailed file? ' +
      'If not, it belongs in a skill, doc, runbook or path-scoped rule (docs/instruction-placement.md).\n' +
      '  -> If the growth is deliberate: node scripts/instruction-budget-baseline.js --write';
  }

  if (/\/\.claude\/rules\/.*\.md$/i.test(fwd(filePath))) {
    return `instruction-budget: GLOBAL RULE WITHOUT A BUDGET ENTRY - ${name} (${fmt(chars)} code points)\n` +
      '  It has no `paths:` frontmatter, so it loads in EVERY session regardless of its directory.\n' +
      '  -> If it only matters for some files: add `paths:` frontmatter (cost drops to zero until those files are read).\n' +
      '  -> If it is deliberately global: node scripts/instruction-budget-baseline.js --write';
  }
  return null; // always-loaded file with no budget entry: nothing to compare against
}

function handler(p, env) {
  if (p.tool_name && !EDIT_TOOLS.has(p.tool_name)) return allow();
  const ti = p.tool_input || {};
  const fp = String(ti.file_path || (p.tool_response && p.tool_response.filePath) || '');
  if (!fp) return allow();
  const projectDir = env.CLAUDE_PROJECT_DIR || p.cwd || process.cwd();
  const abs = path.isAbsolute(fp) ? fp : path.resolve(projectDir, fp);
  const msg = evaluate({ filePath: abs, projectDir, env });
  if (!msg) return allow();
  audit(HOOK, { event: 'warn', file: budgetKey(abs, projectDir) });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
    systemMessage: msg,
  }));
}

// Own stdin loop instead of common.run: run()'s error path may emit a PreToolUse deny under
// GUARDRAIL_FAIL_CLOSED=1, and this hook must never deny.
function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('error', () => allow());
  process.stdin.on('end', () => {
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || Array.isArray(p)) return allow();
      handler(p, process.env);
    } catch (e) {
      audit(HOOK, { event: 'error', error: String((e && e.message) || e).slice(0, 200) });
      allow();
    }
  });
}

if (require.main === module) main();
module.exports = {
  assess, isPathScoped, countChars, globToRegExp, resolvePattern, matchesAny, budgetKey,
  budgetPath, configuredGlobs, loadBudget, evaluate, DEFAULT_GLOBS, fwd, CI,
};
