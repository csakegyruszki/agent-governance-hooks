# Hardening notes

These guards are defense in depth, not a security boundary. They are regex scanners over tool input; a determined model or operator can get around them. The goal is to stop accidents and to leave an audit trail when someone deliberately bypasses a guard.

## What changed

- **Always-true WHERE.** `DELETE`/`UPDATE` statements whose `WHERE` is trivially true are denied, in `sql-guard` and `sql-cli-guard`: `1=1`, `0=0`, `2>1`, `1<>0`, `true`, `NOT false`, `'a'='a'`, `x=x` (same identifier on both sides), `(SELECT 1)=1` (best effort), and a leading or trailing `OR <always-true>` disjunct. `WHERE 1=1 AND id = 5` stays allowed (common in dynamically built queries), as do `1<>1` and `a = b`.
- **`sql-cli-guard.js` (new, Bash/PowerShell matcher).** Replaces `sqlite-guard.js`. It engages when a command invokes `psql`, `mysql`, `mariadb`, `duckdb` or `sqlite3`, scans the whole command string (`-c`, `-e`, `--command` arguments and heredoc bodies included), and also reads SQL files the command refers to (`< f.sql`, `-f f.sql`, `--file f.sql`, `.read f.sql`, quoted `source f.sql`) when the file exists, is a regular file and is at most 1 MB. `sqlite-guard.js` stays as a thin wrapper that engages only for `sqlite3`; point `hooks.json` at `sql-cli-guard.js`.
- **Normalisation only adds matches.** Both `sql-guard` and `sql-cli-guard` scan the raw text and a comment-stripped copy and deny if either matches. `sql-guard` used to scan only the stripped copy, so `SELECT '--'; <destructive statement>` hid the second statement.
- **Marker with a reason, audited.** The escape hatch is now `guardrail:confirmed reason="<at least 8 non-space characters>"`. A marker without a reason (and the old `claude:confirmed`) does not bypass. The marker must sit in a comment (`--`, `#`, `/* */`, `//`) that starts outside a single-quoted literal, so `SELECT '-- guardrail:confirmed reason="xxxxxxxx"'; <destructive>` is still denied. Every bypass is appended to the audit log (`event: bypass`, reason, tool, what was detected). If the log cannot be written, the bypass is refused ("bypass could not be logged").
- **Fail-closed mode for all hooks (except lesson-inject, which never blocks)** (`sql-guard`, `sql-cli-guard`, `no-nested-agent`) through `run()` in `lib/common.js`. Malformed JSON, `null`, `[]`, empty stdin and non-string `command`/`query` fields are errors, handled by the fail mode. Objects are never coerced to text.
- **`scripts/doctor.js` (new).** Prints a short report and always exits 0: Node >= 18, `hooks/hooks.json` parses and references existing scripts, audit log path writable, and whether `agent_id` was ever seen. `no-nested-agent` now logs `event: seen, has_agent_id` for every Agent/Task call. If no subagent-origin event was ever logged, doctor reports the state as UNKNOWN (not absent): nested-spawn detection is unverified on that install.

## Environment variables

| Variable | Effect |
|---|---|
| `GUARDRAIL_FAIL_CLOSED=1` | A hook that cannot parse its input or throws denies the call instead of allowing it. `sql-cli-guard` also denies when a referenced SQL file cannot be read (missing, not a regular file, over 1 MB). |
| `GUARDRAIL_APPROVAL` | `deny` (default) or `ask`. See below. |
| `GUARDRAIL_AUDIT_LOG` | Path of the JSONL audit log. Default `~/.agent-governance-hooks/audit.jsonl`. |

## Approval mode (`GUARDRAIL_APPROVAL=ask`)

Default `deny` is unchanged. In `ask`, wherever `sql-guard`, `sql-cli-guard`, `deletion-guard` or `secret-guard` would deny a destructive or secret action, the hook returns `permissionDecision: "ask"` with the same reason plus "Approve only if you intended this.", and writes an audit row with `event: ask`. It does not apply to malformed input, fail-closed errors, a bypass that could not be logged, the evidence-directory block or `completion-gate`; those keep their fail-open / fail-closed / deny behaviour.

The text escape hatch (marker with a reason) keeps working in both modes, for unattended runs, and every use is still audited. In `ask` mode the human prompt is the primary approval path.

Documented by Anthropic ([hooks reference](https://code.claude.com/docs/en/hooks), PreToolUse decision control): `"ask"` prompts the user to confirm; the reason is shown in that prompt; in a `-p` run where no one can answer, Claude Code denies the call and Claude reads the reason in the tool result; a hook `"ask"` also forces a prompt in auto mode; deny and ask rules are still evaluated; precedence among hooks is `deny` > `defer` > `ask` > `allow`.

### Measured behaviour of `ask` (Claude Code 2.1.288, headless `-p`)

| permission mode | hook fired | command ran | permission_denials / result |
|---|---|---|---|
| default (`manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| control: hook returns `deny`, default mode | NOT MEASURED | NOT MEASURED | NOT MEASURED |

Why: `claude -p` in the build environment returned "Failed to authenticate: OAuth session expired and could not be refreshed" (`claude auth status`: not logged in) before any tool call, in two attempts, so no mode was exercised. The probe (a PreToolUse hook on Bash that returns `ask` for a marker string and logs each call) is straightforward to rerun after `claude auth login`. Interactive UI behaviour (what the prompt looks like, whether approving runs the command) is NOT MEASURED either; check it once by hand before relying on `ask`.

Recommendation: interactive sessions `ask`; unattended or CI runs `deny` (default) or the audited escape hatch.

## Marker syntax

```
-- guardrail:confirmed reason="dropping scratch table after migration test"
```

In a shell command, put it as a trailing shell comment (`# guardrail:confirmed reason="..."`) or inside a heredoc as a SQL comment. If the SQL is wrapped in shell single quotes, the marker sits at odd quote parity and is not honoured; use double quotes, a heredoc, or a trailing comment.

## Known limits

- **Shell indirection.** `q=$(printf ...); sqlite3 db "$q"`, command substitution, `eval`, environment-variable SQL, and SQL assembled across several commands are not seen.
- **Encoded or obfuscated SQL.** Base64, hex, `char()` concatenation, `EXECUTE format(...)`, and keywords split by string concatenation are not decoded.
- **Large or unreadable files.** A SQL file over 1 MB, a missing file, or a file produced by an earlier command in the same line is not scanned: allowed with an `file-unreadable` audit event by default, denied under `GUARDRAIL_FAIL_CLOSED=1`. Files read via `-i`, `\i` inside other files, or `psql -f -` are not followed.
- **Other clients.** Anything that is not `psql`, `mysql`, `mariadb`, `duckdb`, `sqlite3` (ORMs, `pgcli`, `sqlcmd`, language drivers, GUI tools, ad-hoc Python/Node scripts) is out of scope.
- **Quoted text is not stripped.** `echo 'psql -c "<destructive>"'` is denied although nothing runs. This over-block is deliberate: removing quoted text would let a payload hide inside quotes.
- **Tautology detection is pattern based.** Only the listed forms are caught; `WHERE id = id + 0`, `WHERE 1=1 AND 1=1`-style compound constants, `WHERE x IS NOT NULL` on a NOT NULL column and similar are not. Subquery forms are best effort.
- **The marker is not authorisation.** The model can type it too. The audit log is how a human reviews bypasses.
- **`agent_id` presence.** `no-nested-agent` relies on Claude Code putting `agent_id` in PreToolUse payloads for subagent calls. Run `node scripts/doctor.js` after some real use; until it reports an observed `agent_id`, treat nested-spawn blocking as unverified.
