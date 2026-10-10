#!/usr/bin/env node
'use strict';
// delegation-guard.js - PreToolUse gate on Agent/Task: a subagent prompt must name its scope and
// state a size limit.
//
// Why: a subagent prompt without a named scope or an output limit makes the subagent wander and
// costs tokens, and the caller pays for it. Both properties are cheap to state up front and
// mechanical to check.
//
// Rules (both must hold, otherwise deny):
//   1. SCOPE   - the prompt names something concrete: a path-like token, a file extension,
//                a `backticked` identifier, or a URL.
//   2. LIMIT   - the prompt bounds the answer: "max N", "at most N", "N lines/words/...",
//                JSON / schema / table with N rows, "one number", yes/no.
// The checks are deliberately generous: a false negative (a sloppy prompt let through) is cheaper
// than a false positive (a good delegation blocked).
//
// Bypass: guardrail:broad reason="<at least 8 chars>" for intentional exploration, or the generic
// guardrail:confirmed reason="...". Every bypass is written to the audit log.

const { run, allow, deny, confirmedReason, audit, auditStrict } = require('./lib/common');
const { CONTRACT_LINE_RE } = require('./lib/subagents');

const HOOK = 'delegation-guard';
// Markers count only at the START of a line (a marker quoted mid-sentence inside pasted material
// is ignored) and need a reason of at least 8 non-whitespace characters.
const BROAD_RE = /^[ \t]*guardrail:broad[ \t]+reason[ \t]*=[ \t]*"([^"\n]*)"/im;
const CONFIRMED_LINE_RE = /^[ \t]*guardrail:confirmed[ \t]+reason[ \t]*=[ \t]*"[^"\n]*"/im;
const longEnough = (r) => r.replace(/\s/g, '').length >= 8;

const HAS_SCOPE = new RegExp([
  '`[^`\\n]+`',                                            // backticked identifier
  '\\.(md|py|js|mjs|ts|tsx|jsx|jsonl?|ya?ml|toml|csv|xlsx?|sql|txt|sh|ps1|docx?|pdf|html?|rs|go|java|cpp|h)\\b', // extension
  '[\\w.~-]+[\\/\\\\][\\w.-]+',                             // path separator between words
  '\\b[A-Za-z]:[\\\\/]',                                   // drive letter
  'https?:\\/\\/',                                         // URL
].join('|'), 'i');

// JSON must not match inside a file name such as settings.json (the lookbehind excludes "." and
// word characters before it), otherwise a bare file name would count as an output schema.
const UNITS = 'lines?|words?|sentences?|bullets?|bullet\\s+points?|items?|rows?|paragraphs?|chars?|characters?';
const HAS_LIMIT = new RegExp([
  '\\bmax(imum)?\\.?\\s*(of\\s+)?\\d',
  '\\bat\\s+most\\s+\\d',
  '\\b(up\\s+to|no\\s+more\\s+than|under|within)\\s+\\d+\\s*(' + UNITS + ')\\b',
  '\\b\\d+\\s*(' + UNITS + ')\\b',
  '(?<![.\\w])JSON\\b',
  '\\bschema\\b',
  '\\btable\\s+(with|of)\\s+\\d+\\s+rows?\\b',
  '\\bexactly\\s+\\d+\\b',
  '\\b(one|a\\s+single)\\s+(number|word|sentence|line|value)\\b',
  '\\byes\\s*\\/\\s*no\\b',
  '\\byes\\s+or\\s+no\\b',
].join('|'), 'i');

// Opt-in advice (GUARDRAIL_RETURN_CONTRACT_ADVICE=1): on an ad-hoc call (no subagent_type, or
// general-purpose) whose prompt has no  RETURN: contract-v1  line, remind the caller that the typed
// report exists. Advice only: the call is allowed either way. Pairs with scripts/return-contract.js.
function allowWithAdvice(prompt, agent) {
  const adhoc = !agent || agent === 'general-purpose';
  if (process.env.GUARDRAIL_RETURN_CONTRACT_ADVICE !== '1' || !adhoc ||
      CONTRACT_LINE_RE.test(prompt) || prompt.includes('return-contract-v1:injected')) return allow();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: 'Return contract: if this result feeds a decision, add the line "RETURN: contract-v1" ' +
        'to the prompt for a typed, hook-checked report (docs/contracts/subagent-return-v1.md). Advice only.',
    },
  }));
}

function handler(p) {
  if (!/^(Agent|Task)$/i.test(String(p.tool_name || ''))) return allow();
  const ti = p.tool_input || {};
  const prompt = String(ti.prompt || '');
  const agent = ti.subagent_type || null;

  const broad = BROAD_RE.exec(prompt);
  const confLine = CONFIRMED_LINE_RE.exec(prompt);
  const confirmed = confLine ? confirmedReason(confLine[0]) : null;
  const bypass = broad && longEnough(broad[1])
    ? { marker: 'broad', reason: broad[1].trim() }
    : confirmed ? { marker: 'confirmed', reason: confirmed } : null;
  if (bypass) {
    if (auditStrict(HOOK, { event: 'bypass', ...bypass, agent })) return allow();
    return deny('delegation-guard: bypass could not be logged (audit log not writable), so it is not honoured. ' +
      'Fix GUARDRAIL_AUDIT_LOG or name a scope and a size limit in the prompt.');
  }

  const missing = [];
  if (!HAS_SCOPE.test(prompt)) missing.push('a NAMED SCOPE');
  if (!HAS_LIMIT.test(prompt)) missing.push('a SIZE LIMIT');
  if (!missing.length) return allowWithAdvice(prompt, agent);

  audit(HOOK, { event: 'deny', missing, agent });
  return deny(
    `The subagent prompt is missing ${missing.join(' and ')}.\n` +
    'A subagent prompt without scope or size limit makes the subagent wander and costs tokens.\n' +
    '- SCOPE: name the file, directory, command or URL (a `backticked` identifier, a file extension or a path).\n' +
    '- LIMIT: e.g. "max 5 lines", "3 sentences", "JSON with this schema", "one number", "yes/no".\n' +
    'Also useful: say what NOT to do, and "mark anything you could not verify as NOT VERIFIED".\n' +
    'If a broad scope is intentional (exploratory search), add to the prompt: ' +
    'guardrail:broad reason="<why, at least 8 characters>"'
  );
}

if (require.main === module) run(HOOK, handler);
module.exports = { HAS_SCOPE, HAS_LIMIT, handler };
