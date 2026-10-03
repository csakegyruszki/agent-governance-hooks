#!/usr/bin/env node
'use strict';
// lesson-inject.js - SubagentStart / SubagentStop hook (dispatch on hook_event_name).
//
// Why: subagents start with a fresh context and never consult your notes, so a lesson learned
// the hard way does not reach them. This hook pushes the few lessons that matter.
//
// SubagentStart: scan GUARDRAIL_LESSONS_DIR for *.md lessons whose frontmatter has
//   severity: critical and applies_to containing the EXACT agent_type (case-sensitive). Inject at
//   most 3 (sorted by file name), at most 900 characters in total, as additionalContext, and audit
//   an "inject" event. The text asks the subagent to end with one INFORMATION: line.
// SubagentStop: if an inject was logged for this agent_id, audit an "attest" event: attested=true
//   only if an INFORMATION: line mentions at least one injected lesson name. Warn-only: this hook never blocks.
// No lessons dir configured -> does nothing. Any error -> '{}' (fail open).

const fs = require('fs');
const path = require('path');
const { audit, auditPath } = require('./lib/common');

const HOOK = 'lesson-inject';
const MAX_LESSONS = 3;
const MAX_CHARS = 900;

const unq = (s) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);

// Minimal frontmatter reader: fields may be top level or nested (e.g. under metadata:).
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const fm = m[1];
  const get = (key) => {
    const r = new RegExp('^[ \\t]*' + key + ':[ \\t]*(.*)$', 'm').exec(fm);
    return r ? r[1].trim() : '';
  };
  const list = /^\[(.*)\]$/.exec(get('applies_to'));
  return {
    name: unq(get('name')),
    description: unq(get('description')),
    severity: get('severity').toLowerCase(),
    applies: list ? list[1].split(',').map((s) => unq(s.trim())).filter(Boolean) : [],
  };
}

function findLessons(dir, agentType) {
  const out = [];
  const files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)).sort();
  for (const f of files) {
    const full = path.join(dir, f).replace(/\\/g, '/');
    let fm;
    try { fm = parseFrontmatter(fs.readFileSync(full, 'utf8')); } catch (e) {
      audit(HOOK, { event: 'lesson_skipped', file: f, reason: 'unreadable' });
      continue;
    }
    if (!fm || !fm.severity || !fm.description) {
      audit(HOOK, { event: 'lesson_skipped', file: f,
        reason: !fm ? 'no frontmatter' : !fm.severity ? 'missing severity' : 'missing description' });
      continue;
    }
    if ( fm.severity === 'critical' && fm.applies.includes(agentType)) {
      out.push({ name: fm.name || f.replace(/\.md$/i, ''), description: fm.description, file: full });
    }
  }
  return out.slice(0, MAX_LESSONS);
}

function buildText(lessons) {
  const head = 'Critical lessons that apply to your agent type (open the file only if relevant to this task):\n';
  // Ask for a per-lesson verdict word rather than giving a copyable "applied | not relevant" line,
  // which workers tend to paste verbatim.
  const tail = '\nEnd your final report with one line starting with "INFORMATION:" that gives, per lesson, ' +
    'one word: applied OR not-relevant (example: INFORMATION: ' + lessons[0].name + ' = not-relevant).';
  const descs = lessons.map((l) => l.description);
  const build = () => head +
    lessons.map((l, i) => `- ${l.name}: ${descs[i]} (file: ${l.file})`).join('\n') + tail;
  let text = build();
  while (text.length > MAX_CHARS) {
    let i = 0;
    for (let k = 1; k < descs.length; k++) if (descs[k].length > descs[i].length) i = k;
    if (descs[i].length <= 1) break;
    const cut = Math.max(1, descs[i].length - (text.length - MAX_CHARS) - 1);
    descs[i] = descs[i].replace(/…$/, '').slice(0, cut).trimEnd() + '…';
    text = build();
  }
  return text;
}

function wasInjected(agentId) {
  let data;
  try { data = fs.readFileSync(auditPath(), 'utf8'); } catch (_) { return null; }
  let found = null;
  for (const l of data.split('\n')) {
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (r.hook === HOOK && r.event === 'inject' && r.agent_id === agentId) found = r;
    } catch (_) { /* skip bad line */ }
  }
  return found;
}

function handler(p) {
  const out = (s) => process.stdout.write(s);
  const dir = process.env.GUARDRAIL_LESSONS_DIR;
  if (!dir) return out('{}');
  const ev = p.hook_event_name;

  if (ev === 'SubagentStart') {
    if (!p.agent_type) return out('{}');
    const lessons = findLessons(dir, String(p.agent_type));
    if (!lessons.length) return out('{}');
    audit(HOOK, { event: 'inject', session_id: p.session_id, agent_id: p.agent_id,
      agent_type: p.agent_type, lessons: lessons.map((l) => l.name) });
    return out(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: buildText(lessons) },
    }));
  }
  if (ev === 'SubagentStop') {
    const inj = p.agent_id ? wasInjected(p.agent_id) : null;
    if (inj) {
      const m = /^\s*INFORMATION:(.*)$/m.exec(String(p.last_assistant_message || ''));
      const line = m ? m[1].toLowerCase() : '';
      const attested = !!m && (inj.lessons || []).some((n) => line.includes(String(n).toLowerCase()));
      const row = { event: 'attest', session_id: p.session_id, agent_id: p.agent_id,
        agent_type: p.agent_type, attested };
      if (!attested) row.reason = m ? 'no matching lesson name' : 'no INFORMATION line';
      audit(HOOK, row);
    }
  }
  return out('{}');
}

// Never blocks, also under GUARDRAIL_FAIL_CLOSED=1: any error (including malformed stdin) is
// audited and answered with '{}'. Deliberately does not use common.run (its onError may deny).
function main() {
  let raw = '';
  let done = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    if (err) {
      audit(HOOK, { event: 'error', error: String((err && err.message) || err).slice(0, 200) });
      process.stdout.write('{}');
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('error', finish);
  process.stdin.on('end', () => {
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('hook input is not a JSON object');
      handler(p);
      done = true;
    } catch (e) {
      finish(e);
    }
  });
}

if (require.main === module) main();
module.exports = { parseFrontmatter, findLessons, buildText, handler };
