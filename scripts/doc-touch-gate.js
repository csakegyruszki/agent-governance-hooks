#!/usr/bin/env node
'use strict';
// doc-touch-gate.js - PostToolUse (Write|Edit|MultiEdit) + Stop hook (dispatch on hook_event_name).
//
// OPT-IN: the hook is inactive (answers '{}' on every event, writes nothing) unless
// GUARDRAIL_DOC_PROJECT_GLOBS is set or GUARDRAIL_DOC_ENABLED=1. GUARDRAIL_DOC_MIN_FILES=0 also
// disables it.
//
// Why: a project's memory file (default PROJECT_MEMORY.md) is the front page the next session reads
// first. Sessions that change many files and then stop without touching it leave the next session
// with a stale page. This hook turns that into one nudge.
//
// PostToolUse: when the edited file lies inside a project (see "Project roots"), record
//   (session, project root, relative path) in a small per-session state file.
// Stop: per project with >= GUARDRAIL_DOC_MIN_FILES (default 3) distinct SUBSTANTIVE files edited in
//   this session and no edit of its memory file AFTER the last substantive edit -> block ONCE per
//   project per session ({"decision":"block","reason":...}), asking for a memory-file update plus one
//   log-file line, or a one-sentence reason why none is needed. The second Stop passes and is audited.
//   Substantive = not the memory file, not the log file, not under archive/.
//
// Project roots (GUARDRAIL_DOC_PROJECT_GLOBS, entries separated by the platform path delimiter or a
// newline): each entry is a directory pattern. `*` matches exactly one path segment that does not
// start with '.' or '_' (helper and cache folders are not projects); other segments are literal;
// matching is case-insensitive and accepts both slash styles; `~` expands to the home directory.
// An entry starting with '/' or a drive letter is anchored at the path start; any other entry
// matches at any segment boundary (leftmost match wins). The file must lie BELOW the matched
// directory, so a file directly in `work/research/` is not mistaken for a project. An entry starting
// with '!' excludes: a path below a matching directory is never a project.
//   example:  work/research/*;work/cases/*/*;!work/cases/tools
// Globs unset but GUARDRAIL_DOC_ENABLED=1: the project root is the nearest ancestor directory that
// contains the memory file or a `.git` entry.
//
// Never applies to GUARDRAIL_DOC_IGNORE_DIRS (default: ~/.claude).
//
// LIMITATION: only edits made through Write/Edit/MultiEdit are seen. Files changed by shell commands
// (redirects, sed -i, scripts, git checkout, generators) are invisible, so a session that works
// mostly through the shell is not counted.
//
// Advisory: any error -> '{}' (audited when possible); it does not follow GUARDRAIL_FAIL_CLOSED,
// because blocking every session stop on a hook bug would be worse than a missed nudge.
//
// Configuration (env): GUARDRAIL_DOC_ENABLED (=1 enables the .git/memory-file fallback),
// GUARDRAIL_DOC_PROJECT_GLOBS, GUARDRAIL_DOC_MEMORY_FILE (default
// PROJECT_MEMORY.md), GUARDRAIL_DOC_LOG_FILE (default _LOG.md), GUARDRAIL_DOC_MIN_FILES (default 3; 0 = disabled),
// GUARDRAIL_DOC_IGNORE_DIRS, GUARDRAIL_DOC_STATE_DIR (default <GUARDRAIL_STATE_DIR or
// ~/.agent-governance-hooks/state>/doc-touch),
// GUARDRAIL_AUDIT_LOG.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { audit, ensureDir } = require('./lib/common');

const HOOK = 'doc-touch-gate';
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit'];
const SEG = '[^/._][^/]*';

function norm(p) { return String(p || '').replace(/\\/g, '/'); }
function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function stripSlash(s) { return s.replace(/\/+$/, ''); }

function splitList(v) {
  return String(v || '').split(new RegExp('[\\n' + escRx(path.delimiter) + ']')).map((s) => s.trim()).filter(Boolean);
}

// One glob entry -> RegExp that matches the project root directory and requires "/" to follow.
function compileGlob(entry) {
  let g = norm(entry).replace(/^~(?=\/|$)/, norm(os.homedir()));
  g = stripSlash(g);
  const anchored = g.startsWith('/') || /^[a-z]:\//i.test(g);
  const body = g.split('/').map((seg) => (seg === '*' ? SEG : escRx(seg))).join('/');
  return new RegExp((anchored ? '^' : '(?:^|/)') + body + '(?=/)', 'i');
}

// Unset, empty or not a non-negative integer -> 3. An explicit 0 is kept: it disables the gate.
function parseMinFiles(v) {
  if (v === undefined || String(v).trim() === '') return 3;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

function loadConfig(env = process.env) {
  const includes = [];
  const excludes = [];
  for (const entry of splitList(env.GUARDRAIL_DOC_PROJECT_GLOBS)) {
    if (entry.startsWith('!')) excludes.push(compileGlob(entry.slice(1)));
    else includes.push(compileGlob(entry));
  }
  const ignore = splitList(env.GUARDRAIL_DOC_IGNORE_DIRS || path.join(os.homedir(), '.claude'))
    .map((d) => stripSlash(norm(d)).toLowerCase());
  const cfg = {
    memoryFile: env.GUARDRAIL_DOC_MEMORY_FILE || 'PROJECT_MEMORY.md',
    logFile: env.GUARDRAIL_DOC_LOG_FILE || '_LOG.md',
    minFiles: parseMinFiles(env.GUARDRAIL_DOC_MIN_FILES),
    enabled: false, // set below
    stateDir: env.GUARDRAIL_DOC_STATE_DIR ||
      path.join(env.GUARDRAIL_STATE_DIR || path.join(os.homedir(), '.agent-governance-hooks', 'state'), 'doc-touch'),
    includes,
    excludes,
    hasGlobs: includes.length > 0,
    ignore,
  };
  cfg.enabled = cfg.minFiles > 0 && (cfg.hasGlobs || env.GUARDRAIL_DOC_ENABLED === '1');
  return cfg;
}

// Fallback when no globs are configured: nearest ancestor holding the memory file or a .git entry.
function nearestMarkerRoot(absDir, cfg) {
  let dir = absDir;
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, cfg.memoryFile)) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// Returns { root, rel } or null.
function mapProject(filePath, cwd, cfg = loadConfig()) {
  if (!filePath || typeof filePath !== 'string') return null;
  let abs = filePath;
  if (!path.isAbsolute(abs) && !/^[a-z]:[\\/]/i.test(abs)) abs = path.resolve(cwd || process.cwd(), abs);
  const n = norm(abs);
  const low = n.toLowerCase();
  for (const d of cfg.ignore) if (low === d || low.startsWith(d + '/')) return null;
  let root = null;
  if (cfg.hasGlobs) {
    let best = null;
    for (const rx of cfg.includes) {
      const m = rx.exec(n);
      if (!m) continue;
      const end = m.index + m[0].length;
      if (best === null || m.index < best.start) best = { start: m.index, end };
    }
    if (!best) return null;
    root = n.slice(0, best.end);
    for (const rx of cfg.excludes) if (rx.test(n)) return null;
  } else {
    const dir = nearestMarkerRoot(path.dirname(abs), cfg);
    if (!dir) return null;
    root = norm(dir);
    if (!(low.startsWith(root.toLowerCase() + '/'))) return null;
  }
  return { root, rel: n.slice(root.length + 1) };
}

function isMemoryFile(rel, cfg) { return rel.toLowerCase() === cfg.memoryFile.toLowerCase(); }
function isSubstantive(rel, cfg = loadConfig()) {
  const low = rel.toLowerCase();
  const base = low.split('/').pop();
  if (base === cfg.memoryFile.toLowerCase() || base === cfg.logFile.toLowerCase()) return false;
  if (low.startsWith('archive/')) return false;
  return true;
}

function stateFile(cfg, session) {
  return path.join(cfg.stateDir, String(session || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
}
function loadState(cfg, session) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(cfg, session), 'utf8'));
    if (s && Array.isArray(s.edits)) {
      return { seq: s.seq || 0, edits: s.edits, blocked: Array.isArray(s.blocked) ? s.blocked : [] };
    }
  } catch (_) { /* new state */ }
  return { seq: 0, edits: [], blocked: [] };
}
function saveState(cfg, session, st) {
  ensureDir(cfg.stateDir);
  fs.writeFileSync(stateFile(cfg, session), JSON.stringify(st));
}

function skeletonMissing(root, cfg) {
  return [cfg.memoryFile, cfg.logFile, '.claude/settings.json'].filter((f) => !fs.existsSync(path.join(root, f)));
}

function handlePost(p, cfg) {
  if (!EDIT_TOOLS.includes(p.tool_name)) return '{}';
  const hit = mapProject((p.tool_input || {}).file_path, p.cwd, cfg);
  if (!hit) return '{}';
  const st = loadState(cfg, p.session_id);
  st.seq += 1;
  st.edits.push({ seq: st.seq, root: hit.root, rel: hit.rel });
  saveState(cfg, p.session_id, st);
  audit(HOOK, { event: 'record', tool: p.tool_name, session_id: p.session_id, project: hit.root, file: hit.rel });
  return '{}';
}

function handleStop(p, cfg) {
  const st = loadState(cfg, p.session_id);
  const byProject = new Map();
  for (const e of st.edits) {
    const key = e.root.toLowerCase();
    if (!byProject.has(key)) byProject.set(key, { key, root: e.root, files: new Map(), lastSub: 0, memSeq: 0 });
    const g = byProject.get(key);
    if (isMemoryFile(e.rel, cfg)) { g.memSeq = Math.max(g.memSeq, e.seq); continue; }
    if (isSubstantive(e.rel, cfg)) {
      g.files.set(e.rel.toLowerCase(), true);
      g.lastSub = Math.max(g.lastSub, e.seq);
    }
  }
  if (byProject.size === 0) return '{}';

  const toBlock = [];
  for (const g of byProject.values()) {
    const base = { event: 'stop', session_id: p.session_id, project: g.root, edited_files: g.files.size };
    let action;
    if (g.files.size < cfg.minFiles) action = 'allow-below-threshold';
    else if (g.memSeq > g.lastSub) action = 'allow-memory-updated';
    else if (st.blocked.includes(g.key)) action = 'allow-already-blocked';
    else if (p.stop_hook_active) action = 'allow-stop-hook-active';
    else { action = 'block'; toBlock.push(g); st.blocked.push(g.key); }
    audit(HOOK, { ...base, action });
  }
  if (toBlock.length === 0) return '{}';
  saveState(cfg, p.session_id, st);
  const init = norm(path.join(__dirname, '..', 'tools', 'project_init.py'));
  const parts = toBlock.map((g) => {
    const missing = skeletonMissing(g.root, cfg);
    let s = `- ${g.root} (${g.files.size} files edited this session)`;
    if (missing.length) {
      s += `; skeleton missing (${missing.join(', ')}): run \`python3 "${init}" "${g.root}" --type <type>\` first`;
    }
    return s;
  });
  const reason = `Doc-touch gate: this session edited >=${cfg.minFiles} files in a project without updating its ` +
    `${cfg.memoryFile} afterwards:\n` + parts.join('\n') +
    `\nUpdate ${cfg.memoryFile} (current state, next step, a dated decision if any, open items; bump the review date) ` +
    `and add one line to ${cfg.logFile} - or state in one sentence why no update is needed. ` +
    'This blocks once per project per session.';
  return JSON.stringify({ decision: 'block', reason });
}

function handle(p, cfg = loadConfig()) {
  if (!cfg.enabled) return '{}'; // opt-in: inactive, writes nothing
  const ev = p.hook_event_name;
  if (ev === 'PostToolUse') return handlePost(p, cfg);
  if (ev === 'Stop') return handleStop(p, cfg);
  return '{}';
}

function safeHandle(p, cfg) {
  try { return handle(p, cfg); } catch (e) {
    audit(HOOK, { event: 'error', error: String((e && e.message) || e).slice(0, 200) });
    return '{}';
  }
}

module.exports = { loadConfig, mapProject, isSubstantive, handle, safeHandle };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let out = '{}';
    try { out = safeHandle(JSON.parse(raw || '{}')); } catch (e) {
      audit(HOOK, { event: 'error', error: 'malformed input' });
    }
    process.stdout.write(out);
  });
}
