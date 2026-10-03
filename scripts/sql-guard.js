#!/usr/bin/env node
'use strict';
// PreToolUse guard for Supabase SQL-executing / mutating MCP tools.
// Blocks clearly destructive SQL: DROP TABLE/SCHEMA/DATABASE, TRUNCATE, ALTER TABLE DROP COLUMN,
// DELETE/UPDATE without WHERE, and DELETE/UPDATE whose WHERE is trivially true (1=1, x=x, ...).
// Escape hatch:  guardrail:confirmed reason="<at least 8 chars>"  anywhere in the query (for
// deploy_edge_function: anywhere in the deployed source). A marker without a reason does not
// bypass; every bypass is written to the audit log. The marker is an operator escape hatch, NOT
// an authorization mechanism: the model can type it too, which is why it is logged.
//
// Tools covered (keep in sync with the matcher in hooks/hooks.json):
//   *__execute_sql, *__apply_migration - raw SQL in the `query` field
//   *__deploy_edge_function            - SQL can ride inside files[].content; code is scanned raw
// Both the claude.ai connector namespace and the supabase plugin namespace are listed, plus a
// shape fallback so a future namespace rename fails CLOSED, not open.
//
// Normalisation rule: preprocessing may only ADD matches. The raw text and a comment-stripped
// copy are both scanned and the union decides (a `--` inside a string literal must not hide a
// following statement). Defense in depth, not a security boundary.
// Malformed input: fail open, or deny under GUARDRAIL_FAIL_CLOSED=1 (via lib/common run()).

const { run, allow, deny, audit, auditStrict } = require('./lib/common');
const { scanDml, commentMarkerReason } = require('./sql-cli-guard');

const KNOWN_SQL_TOOLS = new Set([
  'mcp__claude_ai_Supabase__execute_sql',
  'mcp__plugin_supabase_supabase__execute_sql',
  'mcp__claude_ai_Supabase__apply_migration',
  'mcp__plugin_supabase_supabase__apply_migration',
  'mcp__claude_ai_Supabase__deploy_edge_function',
  'mcp__plugin_supabase_supabase__deploy_edge_function',
]);
const EDGE_DEPLOY_SHAPE = /deploy_edge_function$/;
const GUARDED_SHAPE = /(?:execute_sql|apply_migration|deploy_edge_function)$/;

const toNorm = (s) => s.replace(/\s+/g, ' ').toUpperCase();

function scanSql(norm, reasons) {
  if (/\bDROP\s+TABLE\b/.test(norm)) reasons.push('DROP TABLE');
  if (/\bDROP\s+SCHEMA\b/.test(norm)) reasons.push('DROP SCHEMA');
  if (/\bDROP\s+DATABASE\b/.test(norm)) reasons.push('DROP DATABASE');
  if (/\bTRUNCATE\b/.test(norm)) reasons.push('TRUNCATE');
  if (/\bALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b/.test(norm)) reasons.push('ALTER TABLE DROP COLUMN');
  // Split on ';' AND backtick so SQL in an edge-function template literal (sql`...`) becomes its
  // own segment; the DML scan matches the keywords anywhere inside a segment.
  for (const seg of norm.split(/[;`]/).map((x) => x.trim()).filter(Boolean)) scanDml(seg, reasons);
}

run('sql-guard', (payload) => {
  // Classify the tool before reading its arguments, so a `query` field on an unrelated tool
  // (web search, RAG lookup) is not scanned as SQL.
  const toolName = String(payload.tool_name || '');
  let namespaceNote = '';
  if (toolName && !KNOWN_SQL_TOOLS.has(toolName)) {
    if (!GUARDED_SHAPE.test(toolName)) return allow();
    namespaceNote = ` [unrecognised Supabase tool namespace "${toolName}" - guard applied fail-closed]`;
  }

  const toolInput = payload.tool_input || {};
  const isEdge = EDGE_DEPLOY_SHAPE.test(toolName);
  let sql;
  let markerWhere;
  if (isEdge) {
    const files = Array.isArray(toolInput.files) ? toolInput.files : [];
    sql = files.map((f) => String((f && f.content) || '')).join('\n');
    markerWhere = 'anywhere in the deployed function source';
  } else {
    const q = toolInput.query !== undefined ? toolInput.query : toolInput.sql;
    if (q !== undefined && q !== null && typeof q !== 'string') throw new Error('query is not a string');
    sql = q || '';
    markerWhere = 'inside the query (e.g. at the top)';
  }
  sql = sql.trim();
  if (!sql) return allow();

  const views = [toNorm(sql)];
  // In edge-function source `--` is the decrement operator, not a comment: raw view only there.
  if (!isEdge) {
    views.push(toNorm(sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')));
  }
  const reasons = [];
  for (const v of views) scanSql(v, reasons);
  if (reasons.length === 0) return allow();
  const uniq = [...new Set(reasons)];

  const why = commentMarkerReason(sql);
  if (why) {
    if (auditStrict('sql-guard', { event: 'bypass', reason: why, tool: toolName || '(none)', detected: uniq })) return allow();
    return deny('SQL-guard: bypass could not be logged (audit log not writable), so the call stays blocked.');
  }
  audit('sql-guard', { event: 'deny', patterns: uniq, tool: toolName || '(none)' });
  deny(`SQL-guard blocked destructive SQL: ${uniq.join(', ')}. If intentional, add a comment  -- guardrail:confirmed reason="<why, at least 8 chars>"  ${markerWhere} and retry.${namespaceNote}`);
});
