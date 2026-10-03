#!/usr/bin/env node
'use strict';
// instruction-budget-baseline.js - measures the always-loaded instruction files and (with --write)
// records the budget/ceiling file that scripts/instruction-budget-lint.js compares against.
//
// Why generated, not typed: numbers in a budget file must be measured, in the same unit the hook
// uses (Unicode code points, CRLF counted as LF) - a hand-typed or byte-counted baseline makes the
// hook warn on unchanged files.
//
// Usage (project dir = current directory, or --dir=<path>):
//   node scripts/instruction-budget-baseline.js             dry run: print what would be recorded
//   node scripts/instruction-budget-baseline.js --write     write the budget file
//   node scripts/instruction-budget-baseline.js --check     exit 1 if a file is over its ceiling or
//                                                           has no entry (use in CI / periodically;
//                                                           this is the gate for shell-made edits)
//   --headroom=1.10   ceiling = baseline * headroom (default 1.10). The aim is to notice growth,
//                     not to freeze today's size.
// Same env as the hook: GUARDRAIL_INSTRUCTION_FILES, GUARDRAIL_INSTRUCTION_BUDGET.

const fs = require('fs');
const path = require('path');
const lint = require('./instruction-budget-lint');

const { fwd, CI } = lint;
const SKIP_DIRS = new Set(['node_modules', '.git']);

function staticPrefix(absGlob) {
  const segs = absGlob.split('/');
  const out = [];
  for (const s of segs) {
    if (/[*?]/.test(s)) break;
    out.push(s);
  }
  return out.join('/') || '/';
}

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = dir.replace(/\/$/, '') + '/' + e.name;
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
}

// All existing files matched by the glob list, absolute forward-slash paths, de-duplicated.
function expand(globs, projectDir) {
  const found = new Map();
  for (const g of globs) {
    const abs = lint.resolvePattern(g, projectDir);
    const re = lint.globToRegExp(abs);
    const prefix = staticPrefix(abs);
    let st;
    try { st = fs.statSync(prefix); } catch (_) { continue; }
    const cands = [];
    if (st.isDirectory()) walk(prefix, cands); else cands.push(prefix);
    for (const f of cands) {
      if (re.test(f)) found.set(CI ? f.toLowerCase() : f, f);
    }
  }
  return [...found.values()].sort();
}

function measure(projectDir, env, today) {
  const globs = lint.configuredGlobs(env);
  const always = {};
  const scoped = {};
  for (const f of expand(globs, projectDir)) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const key = lint.budgetKey(f, projectDir);
    const chars = lint.countChars(text);
    if (lint.isPathScoped(text)) scoped[key] = { chars, layer: 'PATH_SCOPED' };
    else always[key] = { chars, layer: 'ALWAYS_LOADED' };
  }
  return { always, scoped, today };
}

function main(argv, env, cwd) {
  const arg = (name) => {
    const a = argv.find((x) => x.startsWith('--' + name + '='));
    return a ? a.slice(name.length + 3) : null;
  };
  const projectDir = fwd(path.resolve(arg('dir') || cwd));
  const headroom = Number(arg('headroom') || 1.1);
  if (!(headroom >= 1)) { console.error('--headroom must be a number >= 1'); return 2; }
  const today = new Date().toISOString().slice(0, 10);
  const { always, scoped } = measure(projectDir, env, today);
  const out = lint.budgetPath(env, projectDir);

  if (argv.includes('--check')) {
    const budget = lint.loadBudget(out);
    if (!budget) { console.error(`no readable budget file: ${out} (run with --write first)`); return 2; }
    let bad = 0;
    for (const [key, v] of Object.entries(always)) {
      const fileAbs = lint.resolvePattern(key, projectDir);
      const hit = Object.keys(budget.files).find((k) => {
        const a = lint.resolvePattern(k, projectDir);
        return CI ? a.toLowerCase() === fileAbs.toLowerCase() : a === fileAbs;
      });
      if (!hit) { console.log(`NO ENTRY       ${v.chars}  ${key}`); bad++; continue; }
      const { verdict, delta } = lint.assess(budget.files[hit], v.chars);
      if (verdict === 'OVER_CEILING') {
        console.log(`OVER CEILING   ${v.chars} / ${budget.files[hit].ceiling} (${delta > 0 ? '+' : ''}${delta})  ${key}`);
        bad++;
      }
    }
    console.log(bad ? `${bad} problem(s)` : 'all always-loaded files within ceiling');
    return bad ? 1 : 0;
  }

  const total = Object.values(always).reduce((a, v) => a + v.chars, 0);
  console.log(`=== ALWAYS-LOADED (${Object.keys(always).length} files, code points) ===`);
  for (const [k, v] of Object.entries(always).sort((a, b) => b[1].chars - a[1].chars)) {
    console.log(`${String(v.chars).padStart(8)}  (ceiling ${String(Math.floor(v.chars * headroom)).padStart(8)})  ${k}`);
  }
  console.log(`TOTAL: ${total} code points`);
  const sc = Object.values(scoped);
  console.log(`path-scoped (zero cost until read): ${sc.length} files, ${sc.reduce((a, v) => a + v.chars, 0)} code points`);

  if (!argv.includes('--write')) {
    console.log('\n(dry run - pass --write to record the budget file)');
    return 0;
  }
  const files = {};
  for (const [k, v] of Object.entries(always)) {
    files[k] = { chars: v.chars, ceiling: Math.floor(v.chars * headroom), baseline_date: today, layer: v.layer };
  }
  const doc = {
    _doc: 'Always-loaded size baselines for scripts/instruction-budget-lint.js. WARN-ONLY: the hook warns, ' +
      'it never blocks. Unit: Unicode code points (CRLF as one). ceiling = baseline * headroom, so the aim ' +
      'is to notice growth, not to freeze today\'s size. Generated by scripts/instruction-budget-baseline.js --write.',
    baseline_date: today,
    headroom,
    always_loaded_total_chars: total,
    files,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`\nwritten: ${out}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2), process.env, process.cwd());
module.exports = { expand, measure, main };
