#!/usr/bin/env node
'use strict';
// PreToolUse guard (Bash matcher) for destructive SQL run through a SQL command-line client:
// psql, mysql, mariadb, duckdb, sqlite3. Supersedes sqlite-guard.js (kept as a thin wrapper).
//
// What is scanned: the WHOLE command string (so -c / -e / --command arguments and heredoc bodies
// are covered) plus the content of any SQL file the command reads (`< f.sql`, `-f f.sql`,
// `--file f.sql`, `.read f.sql`, quoted `source f.sql`) if it exists, is a regular file and is
// at most 1 MB. An unreadable file is allowed with an audit event, or denied when
// GUARDRAIL_FAIL_CLOSED=1.
//
// Normalisation rule: preprocessing may only ADD matches, never remove them. Two views are
// scanned (raw text, and a comment-stripped copy) and the union of findings decides.
// Escape hatch:  guardrail:confirmed reason="<at least 8 chars>"  (every use is audited).
// Defense in depth, not a security boundary: see docs/hardening.md for known limits.

const fs = require('fs');
const path = require('path');
const { run, allow, deny, blockOrAsk, confirmedReason, audit, auditStrict } = require('./lib/common');

const MAX_FILE_BYTES = 1024 * 1024;
const CLIENT_RE_SRC = '(?:psql|mysql|mariadb|duckdb|sqlite3)';

// ---- A1: tautological WHERE ---------------------------------------------------------------
// Operates on UPPERCASED, whitespace-collapsed text. An atom counts only when it IS the whole
// condition or a whole OR-disjunct: `WHERE 1=1 AND id=5` is a common dynamic-query idiom and
// stays allowed; `WHERE id=5 OR 1=1` and `WHERE 1=1 OR id=5` do not.
const ATOMS = [
  // numeric comparison, evaluated in code: 1=1, 0=0, 1<>0, 2>1, 1<=1 ...
  /(?<num>\d+\s*(?:<>|!=|>=|<=|=|>|<)\s*\d+)(?![\w.])/,
  /(?<s1>'[^']*')\s*=\s*\k<s1>/, // 'a'='a'
  /(?<i1>[A-Z_][A-Z0-9_]*(?:\.[A-Z_][A-Z0-9_]*)?)\s*=\s*\k<i1>(?![\w.])/, // x=x
  /\(\s*SELECT\s+(?<q>\d+)\s*\)\s*=\s*\k<q>(?![\w.])/, // (SELECT 1)=1, best effort
  /TRUE(?![\w.])/,
  /NOT\s+FALSE(?![\w.])/,
  /1(?![\w.=<>!])/,
].map((r) => r.source).join('|');
const TAUT_SRC =
  '(?:\\bWHERE|\\bOR)\\s*\\(*\\s*(?<atom>' + ATOMS + ')\\s*\\)*\\s*' +
  "(?=$|\\bOR\\b|\\bORDER\\b|\\bLIMIT\\b|\\bRETURNING\\b|[;\"'`|&<>]|--|/\\*|\\s(?:EOF|EOT|SQL)\\b)";

function numericTrue(atom) {
  const m = /^(\d+)\s*(<>|!=|>=|<=|=|>|<)\s*(\d+)$/.exec(atom);
  if (!m) return true; // not a numeric comparison: the regex alternative itself is the verdict
  const x = Number(m[1]);
  const y = Number(m[3]);
  return { '=': x === y, '<>': x !== y, '!=': x !== y, '>': x > y, '<': x < y, '>=': x >= y, '<=': x <= y }[m[2]];
}

function hasTautology(stmt) {
  const re = new RegExp(TAUT_SRC, 'g');
  let m;
  while ((m = re.exec(stmt))) {
    if (m.groups.num !== undefined && !numericTrue(m.groups.num)) continue; // e.g. 1<>1, 1=2
    return true;
  }
  return false;
}

// A marker only counts inside a comment (-- , #, /* , //) that starts OUTSIDE a single-quoted
// literal, so  SELECT '-- guardrail:confirmed reason="..."'; <destructive>  cannot authorise
// itself. Cost: SQL wrapped in shell single quotes puts the marker at odd quote parity and does
// not bypass; use a heredoc, double quotes, or a trailing shell comment instead.
function commentMarkerReason(text) {
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") { inQuote = !inQuote; continue; }
    if (inQuote) continue;
    const starter = /^(?:--|#|\/\*|\/\/)[ \t]*/.exec(text.slice(i, i + 200));
    if (!starter) continue;
    const rest = text.slice(i + starter[0].length).split('\n', 1)[0];
    if (/^guardrail:confirmed/i.test(rest)) {
      const r = confirmedReason(rest);
      if (r) return r;
    }
  }
  return null;
}

// DELETE / UPDATE statements inside a text blob (SQL embedded in a shell command or in
// edge-function source is mid-string, so match the keywords anywhere, up to the next ';').
function scanDml(norm, reasons) {
  for (const m of norm.match(/\bDELETE\s+FROM\s+\S+[^;]*/g) || []) {
    if (!/\bWHERE\b/.test(m)) reasons.push('DELETE without WHERE');
    else if (hasTautology(m)) reasons.push('DELETE with always-true WHERE');
  }
  for (const m of norm.match(/\bUPDATE\s+\S+\s+SET\b[^;]*/g) || []) {
    if (!/\bWHERE\b/.test(m)) reasons.push('UPDATE without WHERE');
    else if (hasTautology(m)) reasons.push('UPDATE with always-true WHERE');
  }
}

function scanCli(norm, reasons) {
  if (/\bDROP\s+TABLE\b/.test(norm)) reasons.push('DROP TABLE');
  if (/\bDROP\s+INDEX\b/.test(norm)) reasons.push('DROP INDEX');
  if (/\bDROP\s+VIEW\b/.test(norm)) reasons.push('DROP VIEW');
  if (/\bDROP\s+TRIGGER\b/.test(norm)) reasons.push('DROP TRIGGER');
  if (/\bDROP\s+SCHEMA\b/.test(norm)) reasons.push('DROP SCHEMA');
  if (/\bDROP\s+DATABASE\b/.test(norm)) reasons.push('DROP DATABASE');
  if (/\bTRUNCATE\b/.test(norm)) reasons.push('TRUNCATE');
  if (/\bALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b/.test(norm)) reasons.push('ALTER TABLE DROP COLUMN');
  scanDml(norm, reasons);
}

// Strip SQL comments only where SQL can be: block comments anywhere, `--` inside quotes, and
// `--` at line start. A `--` outside quotes mid-line is a shell token (CLI flag) and stays.
function stripSqlComments(s) {
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (q) => q.replace(/--[^\n]*/g, ' '));
  s = s.replace(/^[ \t]*--[^\n]*/gm, ' ');
  return s;
}
const toNorm = (s) => s.replace(/\s+/g, ' ').toUpperCase();

// ---- A2: referenced SQL files ---------------------------------------------------------------
function referencedFiles(cmd) {
  const found = new Set();
  const res = [
    /(?<![<\w])<(?![<(])\s*(["']?)([^\s"'|;&<>]+)\1/g, // < file.sql (not << heredoc, not <( )
    /(?:^|\s)(?:-f|--file)(?:\s+|=)(["']?)([^\s"'|;&<>]+)\1/g, // -f file / --file=file
    /(?:^|[\s"';])\.read\s+(["']?)([^\s"'|;&<>]+)\1/g, // sqlite3/duckdb .read file
    /["']\s*source\s+(["']?)([^\s"'|;&<>]+)\1/g, // mysql "source file"
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(cmd))) {
      const f = m[2];
      if (f && f !== '-' && !f.startsWith('/dev/')) found.add(f);
    }
  }
  return [...found];
}

function readSqlFile(file, cwd) {
  try {
    const p = path.resolve(cwd || process.cwd(), file);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (_) { return null; }
}

// ---- hook ----------------------------------------------------------------------------------
// hook: name used in audit/deny text. clientSrc: optional narrower client regex source.
function main(hook = 'sql-cli-guard', clientSrc = CLIENT_RE_SRC) {
  run(hook, (p) => {
    const raw = (p.tool_input || {}).command;
    if (raw === undefined || raw === null || raw === '') return allow();
    if (typeof raw !== 'string') throw new Error('tool_input.command is not a string');
    const cmd = raw;
    if (!new RegExp('\\b' + clientSrc + '(?:\\.exe)?\\b', 'i').test(cmd)) return allow();

    let text = cmd;
    const unreadable = [];
    for (const f of referencedFiles(cmd)) {
      const body = readSqlFile(f, p.cwd);
      if (body === null) unreadable.push(f);
      else text += '\n' + body;
    }
    for (const f of unreadable) audit(hook, { event: 'file-unreadable', file: f.slice(0, 200) });

    const reasons = [];
    let unreadableDeny = null;
    for (const view of [toNorm(text), toNorm(stripSqlComments(text))]) scanCli(view, reasons);
    if (unreadable.length && process.env.GUARDRAIL_FAIL_CLOSED === '1') {
      unreadableDeny = `unreadable SQL file (${unreadable.join(', ')}) under GUARDRAIL_FAIL_CLOSED=1`;
    }
    const uniq = [...new Set(reasons)];
    if (uniq.length === 0 && !unreadableDeny) return allow();

    const why = commentMarkerReason(text);
    if (why) {
      if (auditStrict(hook, { event: 'bypass', reason: why, tool: 'Bash', detected: uniq })) return allow();
      return deny(`${hook}: bypass could not be logged (audit log not writable), so the call stays blocked.`);
    }
    if (unreadableDeny) {
      // Fail-closed denial is never turned into an approval prompt, in either mode.
      audit(hook, { event: 'deny', patterns: [...uniq, unreadableDeny] });
      return deny(`${hook}: ${unreadableDeny}. Make the file readable or unset the variable.`);
    }
    blockOrAsk(hook, { patterns: uniq }, `${hook} blocked destructive SQL via a SQL CLI: ${uniq.join(', ')}. ` +
      'Check the scope with a SELECT first and keep a backup. If intentional, add ' +
      'guardrail:confirmed reason="<why, at least 8 chars>" to the command and retry.');
  });
}

if (require.main === module) main();

module.exports = { main, commentMarkerReason, scanDml, scanCli, hasTautology, stripSqlComments, toNorm, referencedFiles };
