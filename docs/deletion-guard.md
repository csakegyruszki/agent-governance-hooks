# deletion-guard

PreToolUse hook for the `Bash` and `PowerShell` tools (`scripts/deletion-guard.js`). It denies
destructive deletes and tells the model to move files to the trash instead.

## What it blocks

Recursive or forced deletes, anywhere:

- `rm` with `-r`, `-R`, `-f`, `--recursive`, `--force`, in any flag order and in combined flags
  (`-rf`, `-fr`, `-rfv`, `rm dir -rf`)
- `Remove-Item` / `ri` / `rm` (PowerShell) with `-Recurse`, `-Force` or an abbreviation (`-r`, `-fo`)
- `rmdir` / `rd` / `del` / `erase` with `/s`, `/q` or `/f`
- `find ... -delete`, `find ... -exec rm ...` (also `-exec rm -rf {} +`), `xargs rm`
- `git clean` with `-f`, `-x`, `-X` or `-d`; a dry run (`-n`, `--dry-run`, `-ndx`) stays allowed
- `shred`
- script one-liners: `shutil.rmtree`, `rimraf`, `fs.rmSync`/`fs.rm`, `FileUtils.rm_rf`,
  `os.removedirs`, and `os.remove`/`os.unlink`/`.unlink()` together with a loop (`for`, `walk`,
  `listdir`, `glob`, ...)
- permanent .NET deletes: `[IO.File]::Delete(...)`, and the VisualBasic `DeleteFile` /
  `DeleteDirectory` unless every call provably ends in `SendToRecycleBin`

Any delete (including a plain single-file `rm`, `del`, `Remove-Item`, `unlink`) whose target
resolves inside a protected directory.

Allowed: trash commands (`trash`, `trash-put`, `gio trash`, the VisualBasic `SendToRecycleBin`
call) and every non-recursive delete outside the protected directories (`rm file.txt`).

## Environment variables

| Variable | Meaning |
|---|---|
| `GUARDRAIL_PROTECTED_DIRS` | Directories whose contents may never be deleted by this hook's rules. Separated by the OS path separator (`;` on Windows, `:` elsewhere). `~`, `$VAR`, `${VAR}`, `%VAR%` and `$env:VAR` are expanded; `..` is resolved; symlinks are followed when the path (or its nearest existing parent) exists; the comparison is case-insensitive on Windows. Relative targets are resolved against the call's `cwd` and against a preceding `cd`. |
| `GUARDRAIL_AUDIT_LOG` | Audit log path (default `~/.agent-governance-hooks/audit.jsonl`). Every deny and every bypass is logged. |
| `GUARDRAIL_FAIL_CLOSED=1` | A malformed input or an internal error denies instead of allowing. |

## Escape hatch

Add `guardrail:confirmed reason="<at least 8 characters>"` to the command (for example as a
trailing `# guardrail:confirmed reason="scratch build output"`). A marker without a reason is
ignored. The bypass is honoured only if its audit record could be written; otherwise the call is
denied with "bypass could not be logged". The model can type the marker too: the audit log is
there so a human can review every use.

## Design rule

Preprocessing may only add matches. Quotes, heredoc bodies and comments are never stripped to
avoid a match, because stripping is how an attacker hides a command from a scanner.

## Known false positives

- A delete pattern inside text that is never executed: `echo "rm -rf /"`, a commit message or
  a here-document that mentions `rm -rf`. Kept on purpose (see Design rule); use the escape hatch.
- `git rm -f`, `docker rm -f` and similar commands that reuse the `rm` word with `-f`.
- PowerShell `-Filter`-style parameters are not mistaken for flags, but `rm -r`-like abbreviations
  of other parameters can be.

## Known bypasses (this is a text scan, not a shell parser)

- Variable or computed flags and targets: `rm -$flags target`, `F=-rf; rm $F x`,
  `rm $TARGET` where the variable points into a protected directory.
- Shell indirection: `eval "$(echo cm0gLXJmIHg= | base64 -d)"`, `sh script.sh` (the script body is
  not read), `alias`, functions, `$(...)` building the command name.
- Other languages and tools not listed: Perl, Ruby, PHP, `robocopy /MIR`, `rsync --delete`,
  `mv x /dev/null`, `truncate`, `> file` truncation, a compiled helper, a language one-liner
  using an API not in the pattern list.
- Globs in a protected directory name (`rm /prot*/x`) and paths that only resolve at run time.
- Windows 8.3 short names and other path aliases that `path.posix.normalize` does not know.

Treat this hook as a seat belt for honest mistakes, not as a sandbox.
