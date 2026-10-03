#!/usr/bin/env node
'use strict';
// PreToolUse guard against sending secrets off the machine.
//
// Denies:
//   1. any non-local tool call (WebFetch, WebSearch, MCP tools, ...) whose input contains a URL with a
//      key/token-looking value in the path or query string; for WebFetch/WebSearch the whole input is
//      also scanned for high-confidence token formats;
//   2. Bash/PowerShell network commands (curl, wget, Invoke-WebRequest/iwr, Invoke-RestMethod/irm,
//      nc/ncat/netcat) whose arguments carry such a value, or that read a secret file
//      (.env, *.pem, *.key, id_rsa*, *credentials*) through @file, --data-binary @, -T, < file,
//      `cat file |` or $(cat file);
//   3. git add / git commit naming a secret file, and git commit carrying a high-confidence token.
// Allows local-only use: export X=..., writing a secret to a local file, Edit/Write/Read tools.
// Messages never echo a secret: only the kind of secret and its length.
//
// Defense in depth, not a security boundary: regex scan, no shell parsing. See docs/secret-guard.md.

const common = require('./lib/common');

const HOOK = 'secret-guard';
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const LOCAL_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'LS',
]);

// High-confidence token formats: [type, regex]. Order matters (more specific first).
const HIGH = [
  ['anthropic-style key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-style key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['Slack token', /\bxox[abp]-[A-Za-z0-9-]{10,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['private key block', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
];
// keyword = value (query string, assignment, header-like). Value of at least 16 characters.
const GENERIC = /(?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?key)["']?\s*[=:]\s*["']?([^\s"'&;,)]{16,})/i;
// Values that only reference a secret held elsewhere are not secrets.
const SAFE_REF = /^(?:\$|%|\{\{|<|os\.(?:environ|getenv)\b|process\.env\b|ENV\[|config\.|settings\.)/i;
const BEARER = /\b(?:Bearer|Token)\s+([A-Za-z0-9._~+/=-]{20,})/i;
const CURL_USER = /(?:^|\s)(?:-u|--user)\s+["']?[^\s:"'$]+:([^\s"'$]{6,})/;

const NET_VERB = /(?<![\p{L}\p{N}_-])(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|nc|ncat|netcat)(?:\.exe)?(?=[\s"'`]|$)/iu;
const SECRET_FILE = /(?:^|[\\/])(?:[^\s\\/]*\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?|[^\s\\/]*\.pem|[^\s\\/]*\.key|id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub)[^\s\\/]*|[^\s\\/]*credentials[^\s\\/]*)$/i;

const visible = (s) => String(s).replace(/\p{Cf}/gu, ''); // zero-width characters may only add matches
// Never print any character of the value: only the kind of secret and its length.
const describe = (type, v) => `${type}, ${String(v).length} chars`;

function findToken(text, { generic = true, auth = false } = {}) {
  const v = visible(text);
  for (const [type, re] of HIGH) {
    const m = re.exec(v);
    if (m) return { type, desc: describe(type, m[0]) };
  }
  if (generic) {
    const g = GENERIC.exec(v);
    if (g && !SAFE_REF.test(g[1])) return { type: 'key/token/password value', desc: describe('key/token/password value', g[1]) };
  }
  if (auth) {
    const b = BEARER.exec(v);
    if (b && !SAFE_REF.test(b[1])) return { type: 'bearer/token credential', desc: describe('bearer/token credential', b[1]) };
    const u = CURL_USER.exec(v);
    if (u) return { type: 'basic-auth password', desc: describe('basic-auth password', u[1]) };
  }
  return null;
}

function findSecretFile(unit) {
  let t = unit.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, ' '); // a URL ending in .key is not a file read
  t = t.replace(/(?:^|\s)(?:-o|-O|--output|-OutFile)\s+\S+/g, ' '); // download targets are writes
  for (const w of t.split(/[\s"'`()<>|;&=@,$]+/)) {
    if (w && SECRET_FILE.test(w)) return w;
  }
  return null;
}

// Category of a sensitive file, so reasons never echo the name or path.
function fileCategory(f) {
  const b = String(f).replace(/^.*[\/]/, '');
  if (/\.env(?:\.|$)/i.test(b)) return 'env file';
  if (/\.pem$|\.key$|^id_/i.test(b)) return 'private key file';
  return 'credentials file';
}

function strings(v, out = []) {
  if (v == null) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (typeof v === 'object') Object.keys(v).forEach((k) => strings(v[k], out));
  return out;
}

const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
function hostOf(url) {
  const m = /^https?:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)/i.exec(url);
  return m ? m[1] : '';
}

// Options whose next argument is a value (header, body, file, ...), never a target.
const VALUE_OPT = new RegExp('^(?:-(?:H|d|F|X|u|A|e|o|T|b|c|x|m|w|K|E|t|P|U|O)|' +
  '--(?:header|data|data-raw|data-binary|data-urlencode|form|request|user|user-agent|referer|output|' +
  'upload-file|cookie|cookie-jar|proxy|max-time|connect-timeout|retry|write-out|config|cert|key|cacert|' +
  'post-data|post-file|body-data|password|json)|' +
  '-(?:Headers|Body|Method|InFile|OutFile|ContentType|UserAgent|Credential|Proxy|Authentication|' +
  'TimeoutSec|WebSession|SessionVariable|Token))$', 'i');
const URL_OPT = /^(?:--url|-Uri)$/i;
const NET_TOKEN = /^(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|nc|ncat|netcat)$/i;

// Whitespace tokenizer that understands quotes; a bare | becomes its own token.
function tokenize(unit) {
  const out = [];
  let cur = '';
  let q = '';
  let has = false;
  for (const ch of unit) {
    if (q) { if (ch === q) q = ''; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
    if (ch === '|') { if (has || cur) out.push(cur); out.push('|'); cur = ''; has = false; continue; }
    cur += ch; has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

// Host of a token that looks like a target (scheme URL, host, host:port, host/path), else null.
function targetHost(tok) {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(tok);
  const rest = scheme ? scheme[1] : tok;
  const m = /^(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)(?::\d+)?(?:[/?#].*)?$/.exec(rest);
  if (!m) return null;
  const h = m[1];
  if (scheme) return h;
  if (LOCAL_HOST.test(h) || /^\[[^\]]+\]$/.test(h)) return h;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h) || /^(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/.test(h)) return h;
  return null;
}

// A network unit is local only if it has at least one host/URL target and every target is
// localhost / 127.0.0.0/8 / ::1. Header and body values are never targets.
function isLocalTarget(unit) {
  const toks = tokenize(unit);
  const targets = [];
  let active = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '|') { active = false; continue; }
    const base = t.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
    if (!active) { if (NET_TOKEN.test(base)) active = true; continue; }
    if (/^[<>]/.test(t) || /^\d?[<>]/.test(t)) { if (/^\d?[<>]+$/.test(t)) i++; continue; }
    if (URL_OPT.test(t)) { if (toks[i + 1] !== undefined) targets.push(toks[++i]); continue; }
    if (/^--url=/i.test(t)) { targets.push(t.slice(6)); continue; }
    if (VALUE_OPT.test(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    const h = targetHost(t);
    if (h !== null) targets.push(h);
  }
  if (!targets.length) return false;
  return targets.every((x) => LOCAL_HOST.test(targetHost(x) === null ? x : targetHost(x)));
}

function analyzeShell(cmd) {
  for (const unit of cmd.split(/&&|\|\||;|\n|\r|\s&\s/)) {
    const isNet = NET_VERB.test(unit) && !isLocalTarget(unit);
    const isGit = /(?<![\w-])git\b/i.test(unit);
    if (isNet) {
      const tok = findToken(unit, { generic: true, auth: true });
      if (tok) return { cls: 'network-secret', msg: `network command carries a ${tok.desc}` };
      const f = findSecretFile(unit);
      if (f) return { cls: 'network-secret-file', msg: `network command reads a ${fileCategory(f)}` };
    }
    if (isGit && /\s(?:add|stage|commit)(?=\s|$)/i.test(unit)) {
      const f = findSecretFile(unit);
      if (f) return { cls: 'git-secret-file', msg: `git add/commit names a ${fileCategory(f)}` };
      if (/\scommit(?=\s|$)/i.test(unit)) {
        const tok = findToken(unit, { generic: false });
        if (tok) return { cls: 'git-commit-token', msg: `git commit carries a ${tok.desc}` };
      }
    }
  }
  return null;
}

function analyzeOther(tool, input) {
  const all = strings(input);
  for (const s of all) {
    for (const url of visible(s).match(/\bhttps?:\/\/[^\s"'<>]+/gi) || []) {
      if (LOCAL_HOST.test(hostOf(url))) continue;
      const tok = findToken(url, { generic: true });
      if (tok) return { cls: 'url-secret', msg: `URL in tool input contains a ${tok.desc}` };
    }
  }
  if (/^(?:WebFetch|WebSearch)$/.test(tool)) {
    for (const s of all) {
      const tok = findToken(s, { generic: false });
      if (tok) return { cls: 'web-tool-secret', msg: `${tool} input contains a ${tok.desc}` };
    }
  }
  return null;
}

function main(payload) {
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input || {};
  if (LOCAL_TOOLS.has(tool)) return common.allow();
  if ((SHELL_TOOLS.has(tool) || !tool) && input.command != null && typeof input.command !== 'string') {
    throw new Error('tool_input.command is not a string');
  }

  let hit;
  let text;
  if (SHELL_TOOLS.has(tool) || (!tool && input.command)) {
    text = String(input.command || '');
    if (!text.trim()) return common.allow();
    hit = analyzeShell(text);
  } else {
    text = strings(input).join('\n');
    hit = analyzeOther(tool, input);
  }
  if (!hit) return common.allow();

  const reason = common.confirmedReason(text);
  if (reason) {
    if (common.auditStrict(HOOK, { event: 'bypass', tool, cls: hit.cls, reason })) return common.allow();
    return common.deny(`${HOOK}: escape hatch present but the bypass could not be logged, so the call is blocked. Fix the audit log path (GUARDRAIL_AUDIT_LOG).`);
  }
  common.blockOrAsk(HOOK, { tool, cls: hit.cls },
    `${HOOK} blocked (${hit.cls}): ${hit.msg}. Secrets must not leave the machine. ` +
    'Keep them in an environment variable or a local secret store and reference them there. ' +
    'If this is a false positive, add guardrail:confirmed reason="<why, 8+ chars>" ' +
    'to the call; the use is logged.'
  );
}

if (require.main === module) common.run(HOOK, main);
module.exports = { isLocalTarget, hostOf, LOCAL_HOST };
