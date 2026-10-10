#!/usr/bin/env node
'use strict';
// PreToolUse guard for destructive file deletion in Bash / PowerShell tool calls.
//
// Denies:
//   * recursive or forced deletes: rm -r/-R/-f/--recursive/--force (any flag order, combined flags),
//     Remove-Item -Recurse/-Force, rmdir/rd /s, del /s /q /f, find -delete, find -exec rm,
//     xargs rm, git clean -f/-x/-d (dry runs with -n stay allowed), shred,
//     script one-liners (shutil.rmtree, rimraf, fs.rmSync, os.remove inside a loop, ...),
//     .NET permanent deletes ([IO.File]::Delete, VisualBasic DeleteFile without SendToRecycleBin);
//   * ANY delete (also a plain single-file rm/del/Remove-Item/unlink) whose target resolves inside
//     a directory listed in GUARDRAIL_PROTECTED_DIRS (os.pathsep-separated).
// Asks (never denies, in both approval modes), only when the target is inside GUARDRAIL_PROTECTED_DIRS:
//   * a mirror-style sync into a protected directory: robocopy /MIR or /PURGE, rsync --delete*
//     (destination argument only; a protected SOURCE copied elsewhere is fine);
//   * a script one-liner (python os.remove/unlink/rmdir, Path(...).unlink/rmdir, node fs.unlink*) whose quoted
//     path is inside a protected directory and that the hard script rule did not already deny.
// Allows: moving to trash (trash, trash-put, gio trash, VisualBasic SendToRecycleBin) and every
// non-recursive delete outside the protected directories.
//
// Normalisation rule: preprocessing may only ADD matches. Quotes, heredoc bodies and comments are
// NOT stripped, so a delete pattern that only appears inside a string that is never executed
// (echo "rm -rf /", a commit message) is over-blocked on purpose. The escape hatch covers it.
//
// Defense in depth, not a security boundary: this is a text scan, not a shell parser. See
// docs/deletion-guard.md for known bypasses and false positives.

const os = require('os');
const path = require('path');
const fs = require('fs');
const common = require('./lib/common');

const HOOK = 'deletion-guard';
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Unicode-aware word boundary: JS \b is ASCII-only, so an accented letter would otherwise count as
// a boundary and the "rd" inside an ordinary word could look like a command.
const DEL_VERB = /(?<![\p{L}\p{N}_-])(remove-item|rmdir|erase|shred|unlink|rm|rd|del|ri)(?:\.exe)?(?=[\s;&|)"'`]|$)/giu;
const POSIX_STYLE = new Set(['rm', 'shred', 'unlink']);

const SEGMENT_SPLIT = /&&|\|\||[;|\n\r]|\s&\s/;

// ---- path helpers -------------------------------------------------------------------------

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function expand(p) {
  let s = String(p);
  if (/^~(?=$|[\\/])/.test(s)) s = homeDir() + s.slice(1);
  const lookup = (name) => {
    if (process.env[name] !== undefined) return process.env[name];
    if (process.platform === 'win32') {
      const k = Object.keys(process.env).find((x) => x.toLowerCase() === name.toLowerCase());
      if (k) return process.env[k];
    }
    return undefined;
  };
  s = s.replace(/\$\{(\w+)\}|\$env:(\w+)|\$(\w+)|%(\w+)%/gi, (m, a, b, c, d) => {
    const v = lookup(a || b || c || d);
    return v === undefined ? m : v;
  });
  return s;
}

function normPath(p, cwd) {
  let s = expand(p).replace(/\\/g, '/');
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(s)) {
    s = s[1].toUpperCase() + ':' + s.slice(2); // MSYS-style /c/Users/x
  }
  if (!/^([a-zA-Z]:)?\//.test(s)) s = cwd + '/' + s;
  s = path.posix.normalize(s);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

function protectedDirs(cwd) {
  const raw = process.env.GUARDRAIL_PROTECTED_DIRS || '';
  return raw.split(path.delimiter).map((x) => x.trim()).filter(Boolean).map((d) => forms(d, cwd));
}

// Lexical form plus, when the path exists, its fully resolved form (symlinks followed). Either form
// landing in a protected directory counts.
function forms(p, cwd) {
  const lex = normPath(p, cwd);
  const out = [lex];
  if (/[*?]/.test(lex)) return out;
  // Resolve the nearest existing ancestor through symlinks, then re-append the missing tail.
  let probe = lex;
  let tail = '';
  for (let i = 0; i < 64 && probe.length > 1; i++) {
    try {
      let real = fs.realpathSync(probe).split(path.sep).join('/');
      if (process.platform === 'win32') real = real.toLowerCase();
      if (real.length > 1 && real.endsWith('/')) real = real.slice(0, -1);
      const full = real + tail;
      if (full !== lex) out.push(full);
      break;
    } catch (_) {
      const k = probe.lastIndexOf('/');
      if (k <= 0) break;
      tail = probe.slice(k) + tail;
      probe = probe.slice(0, k);
    }
  }
  return out;
}

function insideAny(target, dirs) {
  const dd = dirs.flat();
  for (const t of Array.isArray(target) ? target : [target]) {
    const d = dd.find((x) => t === x || t.startsWith(x + '/'));
    if (d) return d;
  }
  return null;
}

const unq = (t) => t.replace(/^[("'`]+|[)"'`]+$/g, '');

// ---- analysis -----------------------------------------------------------------------------

function verbDanger(verb, tokens) {
  const v = verb.toLowerCase();
  if (v === 'shred') return 'shred (overwrites data irrecoverably)';
  if (v === 'unlink') return null;
  let ddash = false;
  for (const t of tokens) {
    if (t === '--') { ddash = true; continue; }
    if (ddash) continue;
    if (/^--(recursive|force)$/i.test(t)) return `${v} --${t.slice(2).toLowerCase()}`;
    if (v === 'rm' && /^-(?=[a-zA-Z]*[rRf])[dfiIPrRvx]+$/.test(t)) return `${v} ${t}`;
    if (/^-(?:r|re|rec|recu|recur|recurs|recurse|fo|for|forc|force)(?::\S*)?$/i.test(t)) return `${v} ${t}`;
    if (v !== 'rm' && /^\/[sqf](?:\/[sqf])*$/i.test(t)) return `${v} ${t}`;
  }
  return null;
}

function gitCleanDanger(seg) {
  const m = /(?<![\w-])git\b[^\n]*?\sclean(?=\s|$)(.*)$/i.exec(seg);
  if (!m) return null;
  const toks = m[1].split(/\s+/).filter(Boolean).map(unq);
  let letters = '';
  let dry = false;
  let force = false;
  for (const t of toks) {
    if (/^--dry-run$/i.test(t)) dry = true;
    else if (/^--force$/i.test(t)) force = true;
    else if (/^-[a-zA-Z]+$/.test(t)) letters += t.slice(1);
  }
  if (/n/.test(letters)) dry = true;
  if (dry) return null;
  if (force || /[fxXd]/.test(letters)) return 'git clean with -f/-x/-d';
  return null;
}

function scriptDelete(cmd, cwd, dirs) {
  if (/\b(?:shutil\s*\.\s*)?rmtree\s*\(|\brimraf\b|\.\s*(?:rmSync|rmdirSync)\s*\(|\bfs\s*\.\s*(?:rm|rmdir)\s*\(|\.promises\s*\.\s*rm\s*\(|\bFileUtils\s*\.\s*rm_rf?\b|\bos\s*\.\s*removedirs\s*\(/i.test(cmd)) {
    return { cls: 'script-recursive-delete', detail: 'recursive delete in a script one-liner (rmtree/rimraf/fs.rm)' };
  }
  if (/\bos\s*\.\s*(?:remove|unlink|rmdir)\s*\(|\.unlink(?:Sync)?\s*\(|\bfs\s*\.\s*unlink(?:Sync)?\s*\(/i.test(cmd)) {
    if (/\bfor\b|\bwhile\b|\bwalk\b|\blistdir\b|\bglob\b|\biterdir\b|\bscandir\b/i.test(cmd)) {
      return { cls: 'script-delete-loop', detail: 'file delete inside a loop in a script one-liner' };
    }
    if (dirs.length) {
      const re = /(["'])((?:(?!\1).)+)\1/g;
      let m;
      while ((m = re.exec(cmd))) {
        const hit = insideAny(forms(m[2], cwd), dirs);
        if (hit) return { cls: 'protected-dir', detail: 'script deletes inside a protected directory' };
      }
    }
  }
  return null;
}

// ---- soft detections (always "ask", protected directories only) -------------------------------

// A temp-directory placeholder ($env:TEMP, ${env:TMP}, %TEMP%, $TMPDIR, ...) is resolved to the real
// temp directory even when the variable is not set in the hook's environment; left unresolved it
// would be read as a relative path and could land inside a protected cwd.
const TEMP_PLACEHOLDER = /^(?:\$env:(TEMP|TMP)|\$\{env:(TEMP|TMP)\}|%(TEMP|TMP)%|\$\{?(TMPDIR)\}?)(?=$|[\\/])/i;
function softForms(p, cwd) {
  const m = TEMP_PLACEHOLDER.exec(p);
  if (m) {
    const name = (m[1] || m[2] || m[3] || m[4]).toUpperCase();
    const root = (name === 'TMPDIR' ? process.env.TMPDIR : process.env[name]) || (name === 'TMPDIR' ? '/tmp' : os.tmpdir());
    return forms(root + p.slice(m[0].length), cwd);
  }
  return forms(p, cwd);
}

const OPT_LIKE = /^\/[A-Za-z?]+(?::[^\\/]*)?$/; // robocopy switch: /MIR, /E, /R:3 (a lone /tmp looks the same; harmless)
const ROBO_LIST_OPT = /^\/(?:XD|XF|IF|XJD|XJF)$/i;
const RSYNC_VALUE_OPT = /^(?:-e|-f|--rsh|--exclude|--include|--exclude-from|--include-from|--filter|--files-from|--port|--bwlimit|--rsync-path|--log-file|--backup-dir|--temp-dir|--partial-dir|--compare-dest|--link-dest|--copy-dest|--timeout|--max-size|--min-size|--chmod|--chown|--password-file)$/;
const isRemote = (t) => /^rsync:\/\//i.test(t) || (/^[^\\/\s]+:/.test(t) && !/^[A-Za-z]:[\\/]?/.test(t));

// Destination argument of `robocopy src dst [files] [options]` when /MIR or /PURGE is present, else null.
function robocopyDest(tokens) {
  if (!tokens.some((t) => /^\/(?:MIR|PURGE)$/i.test(t))) return null;
  const pos = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (ROBO_LIST_OPT.test(t)) { while (i + 1 < tokens.length && !OPT_LIKE.test(tokens[i + 1])) i++; continue; }
    if (OPT_LIKE.test(t)) continue;
    pos.push(t);
  }
  return pos.length >= 2 ? pos[1] : null;
}

// Destination (last positional) of an rsync call that has a --delete* option, else null (remote -> null).
function rsyncDest(tokens) {
  if (!tokens.some((t) => /^--(?:delete(?:-[a-z]+)?|del)$/i.test(t))) return null;
  const pos = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (RSYNC_VALUE_OPT.test(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    pos.push(t);
  }
  if (pos.length < 2) return null;
  const dst = pos[pos.length - 1];
  return isRemote(dst) ? null : dst;
}

function softSegment(seg, cwd, dirs) {
  const re = /(?<![\p{L}\p{N}_-])(robocopy|rsync)(?:\.exe)?(?=\s)/giu;
  let m;
  while ((m = re.exec(seg))) {
    const tokens = seg.slice(re.lastIndex).split(/\s+/).filter(Boolean).map(unq);
    const dst = m[1].toLowerCase() === 'robocopy' ? robocopyDest(tokens) : rsyncDest(tokens);
    if (dst && insideAny(softForms(dst, cwd), dirs)) {
      return { cls: 'mirror-sync-protected-dir', soft: true, detail: `${m[1].toLowerCase()} mirror/delete mode with a destination inside a protected directory` };
    }
  }
  return null;
}

// Single-target delete calls in a script one-liner. The hard rule (scriptDelete) only looks at quoted
// strings that are not nested inside another quote pair, so `python -c "...os.remove(r'<path>')"` slips
// through it; here every single- and double-quoted literal is checked on its own.
const SOFT_SCRIPT_CALL = /\bPath\s*\([^)]*\)\s*\.\s*rmdir\s*\(|\bos\s*\.\s*(?:remove|unlink|rmdir)\s*\(|\.unlink(?:Sync)?\s*\(|\bfs\s*\.\s*unlink(?:Sync)?\s*\(/i;
function softScript(cmd, cwd, dirs) {
  if (!SOFT_SCRIPT_CALL.test(cmd)) return null;
  for (const re of [/'([^'\n]+)'/g, /"([^"\n]+)"/g]) {
    let m;
    while ((m = re.exec(cmd))) {
      if (insideAny(softForms(m[1], cwd), dirs)) {
        return { cls: 'script-delete-protected-dir', soft: true, detail: 'script one-liner deletes a path inside a protected directory' };
      }
    }
  }
  return null;
}

function analyze(cmd, cwd0) {
  const dirs = protectedDirs(cwd0);
  let cwd = normPath(cwd0, cwd0);

  // .NET / VisualBasic API deletes. Only a call that provably goes to the recycle bin passes.
  const VB_CALL = /[:.]\s*Delete(File|Directory)\s*\(/gi;
  const VB_RECYCLE = /[:.]\s*Delete(File|Directory)\s*\(.*?(?:['"]SendToRecycleBin['"]|RecycleOption\]::SendToRecycleBin)\s*\)/gi;
  const vbCalls = (cmd.match(VB_CALL) || []).length;
  const vbRecycle = (cmd.match(VB_RECYCLE) || []).length;
  if (vbCalls > 0 && (vbRecycle < vbCalls || /DeletePermanently/i.test(cmd))) {
    return { cls: 'permanent-dotnet', detail: 'VisualBasic DeleteFile/DeleteDirectory not provably sent to the recycle bin' };
  }
  if (/(?:::|\.)\s*Delete\s*\(/.test(cmd)) {
    return { cls: 'permanent-dotnet', detail: '.NET Delete() call (permanent, can be recursive)' };
  }

  const sc = scriptDelete(cmd, cwd, dirs);
  if (sc) return sc;

  if (/(?<![\p{L}\p{N}_-])xargs\b[^;&|\n]*?(?<![\p{L}\p{N}_-])(?:rm|unlink|shred|del|rmdir)(?=\s|$)/iu.test(cmd)) {
    return { cls: 'xargs-delete', detail: 'xargs feeding a delete command (targets unknown)' };
  }

  let soft = dirs.length ? softScript(cmd, cwd, dirs) : null;
  for (const seg of cmd.split(SEGMENT_SPLIT)) {
    const cdm = /^\s*(?:cd|pushd|chdir|set-location|sl)\s+(?:\/d\s+)?(?:-\w+\s+)?(\S+)/i.exec(seg);
    if (cdm) cwd = normPath(unq(cdm[1]), cwd);

    if (/(?<![\w-])find\b/i.test(seg) &&
        (/\s-delete\b/.test(seg) || /\s-exec(?:dir)?\s+(?:\S*[\\/])?(?:rm|unlink|shred)(?=\s|$)/i.test(seg))) {
      return { cls: 'find-delete', detail: 'find -delete / find -exec rm' };
    }
    const gc = gitCleanDanger(seg);
    if (gc) return { cls: 'git-clean', detail: gc };

    DEL_VERB.lastIndex = 0;
    let m;
    while ((m = DEL_VERB.exec(seg))) {
      const verb = m[1];
      const tokens = seg.slice(DEL_VERB.lastIndex).split(/\s+/).filter(Boolean).map(unq);
      const danger = verbDanger(verb, tokens);
      if (danger) return { cls: 'recursive-or-forced', detail: danger };
      if (dirs.length) {
        for (const t of tokens) {
          if (!t || t.startsWith('-') || /^\/[sqf](?:\/[sqf])*$/i.test(t)) continue;
          for (const cand of t.split(',')) {
            if (!cand) continue;
            const hit = insideAny(forms(unq(cand), cwd), dirs);
            if (hit) return { cls: 'protected-dir', detail: `${verb.toLowerCase()} target inside a protected directory` };
          }
        }
      }
    }
    if (!soft && dirs.length) soft = softSegment(seg, cwd, dirs);
  }
  return soft; // a hard hit above always wins; a soft hit (or null) is all that is left
}

function main(payload) {
  const tool = payload.tool_name;
  if (tool && !SHELL_TOOLS.has(tool)) return common.allow();
  const rawCmd = (payload.tool_input || {}).command;
  if (rawCmd != null && typeof rawCmd !== 'string') throw new Error('tool_input.command is not a string');
  const cmd = String(rawCmd || '');
  if (!cmd.trim()) return common.allow();

  const cwd = String(payload.cwd || process.cwd());
  const hit = analyze(cmd, cwd);
  if (!hit) return common.allow();

  const reason = common.confirmedReason(cmd);
  if (reason) {
    if (common.auditStrict(HOOK, { event: 'bypass', cls: hit.cls, reason, command: cmd.slice(0, 200) })) {
      return common.allow();
    }
    return common.deny(`${HOOK}: escape hatch present but the bypass could not be logged, so the call is blocked. Fix the audit log path (GUARDRAIL_AUDIT_LOG).`);
  }
  if (hit.soft) {
    return common.softAsk(HOOK, { cls: hit.cls, command: cmd.slice(0, 200) },
      `${HOOK} asks (${hit.cls}): ${hit.detail}. This can remove files the sync source does not have. ` +
      'Check the destination, or add guardrail:confirmed reason="<why, at least 8 characters>" to the command.');
  }
  common.blockOrAsk(HOOK, { cls: hit.cls, command: cmd.slice(0, 200) },
    `${HOOK} blocked (${hit.cls}): ${hit.detail}. ` +
    'Move to the trash instead of deleting permanently (trash <path>, gio trash <path>, or in ' +
    "PowerShell [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('<path>','OnlyErrorDialogs','SendToRecycleBin'); " +
    "DeleteDirectory for folders). If a permanent delete is really intended, add " +
    'guardrail:confirmed reason="<why, at least 8 characters>" to the command; the use is logged.'
  );
}

common.run(HOOK, main);
