#!/usr/bin/env node
'use strict';
// doctor.js - prints a short install report. Always exits 0 (it is a report, not a gate).
// Checks: Node >= 18; hooks/hooks.json parses and every referenced script exists; the audit log
// path is writable; whether agent_id was ever observed by no-nested-agent (a PreToolUse payload
// cannot be produced on demand, so the audit log is the evidence).

const fs = require('fs');
const path = require('path');
const { auditPath } = require('./lib/common');

const ROOT = path.join(__dirname, '..');

function report() {
  const out = [];
  const line = (status, msg) => out.push(`[${status}] ${msg}`);

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 18 ? 'ok' : 'FAIL', `Node ${process.versions.node} (need >= 18)`);

  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const missing = [];
    let n = 0;
    for (const entries of Object.values(hooks.hooks || {})) {
      for (const e of entries) {
        for (const h of e.hooks || []) {
          const m = String(h.command || '').match(/scripts\/[\w.-]+\.js/);
          if (!m) continue;
          n++;
          if (!fs.existsSync(path.join(ROOT, m[0]))) missing.push(m[0]);
        }
      }
    }
    line(missing.length ? 'FAIL' : 'ok',
      missing.length ? `hooks.json: missing scripts: ${missing.join(', ')}`
        : `hooks.json parses, ${n} referenced script(s) exist`);
  } catch (e) {
    line('FAIL', `hooks.json unreadable or invalid: ${e.message}`);
  }

  const ap = auditPath();
  try {
    require('./lib/common').ensureLogDir(ap);
    if (fs.existsSync(ap) && fs.statSync(ap).isDirectory()) throw new Error('path is a directory');
    fs.closeSync(fs.openSync(ap, 'a'));
    line('ok', `audit log writable: ${ap}`);
  } catch (e) {
    line('WARN', `audit log NOT writable (${ap}): ${e.message}`);
  }

  let seen = 0;
  let withId = 0;
  try {
    for (const l of fs.readFileSync(ap, 'utf8').split('\n')) {
      if (!l) continue;
      try {
        const r = JSON.parse(l);
        if (r.hook === 'no-nested-agent' && r.event === 'seen') {
          seen++;
          if (r.has_agent_id === true) withId++;
        }
      } catch (_) { /* skip a corrupt line */ }
    }
  } catch (_) { /* no log yet */ }
  if (withId > 0) {
    line('ok', `agent_id observed ${withId} time(s) in ${seen} Agent/Task call(s): nested-spawn detection works`);
  } else if (seen > 0) {
    line('WARN', `${seen} Agent/Task call(s) seen, no subagent-origin event observed (agent_id presence UNKNOWN, not absent) - nested-spawn detection unverified on this install`);
  } else {
    line('WARN', 'agent_id presence UNKNOWN (no Agent/Task call logged yet, none observed) - nested-spawn detection unverified on this install');
  }

  return out;
}

if (require.main === module) {
  process.stdout.write(report().join('\n') + '\n');
  process.exitCode = 0;
}
module.exports = { report };
