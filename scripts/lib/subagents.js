'use strict';
// Helpers shared by the subagent hooks (turn-budget, delegation-log, return-contract). Node builtins only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { auditPath } = require('./common');

// Claude Code's configuration directory: CLAUDE_CONFIG_DIR if set, else ~/.claude.
function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Directories searched for <agent_type>.md, first match wins:
//   GUARDRAIL_AGENTS_DIR (if set, the only one), else <cwd>/.claude/agents, then <config dir>/agents.
function agentDirs(cwd) {
  if (process.env.GUARDRAIL_AGENTS_DIR) return [process.env.GUARDRAIL_AGENTS_DIR];
  const dirs = [];
  if (cwd && typeof cwd === 'string') dirs.push(path.join(cwd, '.claude', 'agents'));
  dirs.push(path.join(configDir(), 'agents'));
  return dirs;
}

// maxTurns from the agent file's frontmatter. null for built-in or ad-hoc types (no file), a file
// without maxTurns, or any read problem. agent_type is restricted to a plain name, so a payload
// cannot make this read outside the agent directories.
function maxTurnsFor(agentType, cwd) {
  try {
    if (!agentType || !/^[A-Za-z0-9_-]+$/.test(agentType)) return null;
    for (const dir of agentDirs(cwd)) {
      const f = path.join(dir, agentType + '.md');
      if (!fs.existsSync(f)) continue;
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(f, 'utf8'));
      if (!fm) return null;
      const m = /^maxTurns:[ \t]*(\d+)[ \t]*$/m.exec(fm[1]);
      return m ? Number(m[1]) : null;
    }
    return null;
  } catch (_) { return null; }
}

// Path of a subagent's transcript: the documented agent_transcript_path, else derived from the
// parent transcript's location (<parent dir>/<session_id>/subagents/agent-<agent_id>.jsonl).
function transcriptPath(p) {
  if (p.agent_transcript_path) return p.agent_transcript_path;
  if (!p.transcript_path || !p.session_id || !p.agent_id) return '';
  return path.join(path.dirname(p.transcript_path), String(p.session_id), 'subagents', `agent-${p.agent_id}.jsonl`);
}

// Audit rows written by `hook` for one agent_id (oldest first). Unreadable or missing log -> [].
// Lines are pre-filtered by substring so a large shared audit log is not fully JSON-parsed.
function auditRowsFor(hook, agentId) {
  if (!agentId) return [];
  try {
    const f = auditPath();
    if (!fs.existsSync(f)) return [];
    const needle = JSON.stringify(String(agentId));
    const rows = [];
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l || !l.includes(needle)) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r && r.hook === hook && r.agent_id === agentId) rows.push(r);
    }
    return rows;
  } catch (_) { return []; }
}

// The line that opts a delegation into the return contract. Must be alone on its line.
const CONTRACT_LINE_RE = /^[ \t]*RETURN:[ \t]*contract-v1[ \t]*$/m;

module.exports = { configDir, agentDirs, maxTurnsFor, transcriptPath, auditRowsFor, CONTRACT_LINE_RE };
