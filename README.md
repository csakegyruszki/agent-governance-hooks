# agent-governance-hooks
[![tests](https://github.com/csakegyruszki/agent-governance-hooks/actions/workflows/tests.yml/badge.svg)](https://github.com/csakegyruszki/agent-governance-hooks/actions/workflows/tests.yml)

Governance hooks for Claude Code: safety, delegation discipline and observability, knowledge transfer, completion integrity and doc maintenance in one plugin.

Thirteen hooks and two tools (`tools/tickets.py`, `tools/project_init.py`), packaged as a Claude Code
plugin. They block destructive SQL, recursive deletes and secret exfiltration, keep subagent
delegation scoped, optionally require a typed JSON report from subagents, warn a subagent before it
hits its turn cap, log what each delegation cost, inject critical lessons into subagents and check
that they were acknowledged, refuse to mark a ticket `done` without fresh, passing evidence, and
ask once for a project-memory update after a session that changed many files. No npm dependencies:
Node.js 18+ for the hooks, Python 3.9+ (standard library) for the tools and `completion-gate`.

Author: [csakegyruszki](https://github.com/csakegyruszki). License: Apache-2.0.
Repository: https://github.com/csakegyruszki/agent-governance-hooks

Not affiliated with or endorsed by Anthropic.

## What sets it apart

- **Six concerns, one plugin.** Safety (`sql-guard`, `sql-cli-guard`, `deletion-guard`,
  `secret-guard`), delegation discipline (`delegation-guard`, `no-nested-agent`), delegation
  observability (`return-contract`, `turn-budget`, `delegation-log`), knowledge transfer
  (`lesson-inject`), completion integrity (`completion-gate` + `tools/tickets.py`) and doc
  maintenance (`doc-touch-gate` + `tools/project_init.py`) share one audit log, one escape-hatch
  format and one fail-open/fail-closed switch (`scripts/lib/common.js`, `hooks/hooks.json`).
- **`done` is gated on evidence, not on a claim.** `completion-gate` allows `status: done` only
  when `tickets/evidence/T-XXXX.json` belongs to that ticket, is less than 24 h old, passed, covers
  the ticket's current `checks`, and is newer than every file matched by `changed_files`. The
  evidence directory cannot be written through `Write`/`Edit`/`MultiEdit`, and the hook never runs
  ticket commands itself; it asks `tickets.py --gate-verdict`, so the verdict rule exists in one
  place (`scripts/completion-gate.js`, `tools/tickets.py` `evidence_verdict`).
- **Every bypass is written down or refused.** The escape hatch needs a reason of at least 8
  characters, and it is honoured only if its audit record was actually written; if the audit log
  cannot be written, the bypass is denied (`auditStrict` in `scripts/lib/common.js`).
- **Lessons with attestation.** `lesson-inject` injects up to 3 `severity: critical` lessons for
  the subagent's exact type on `SubagentStart`, and on `SubagentStop` logs whether the subagent's
  report acknowledged them (`scripts/lesson-inject.js`).
- **Normalisation can only add matches.** The SQL guards scan the raw text and a comment-stripped
  copy and deny if either matches, so preprocessing cannot hide a statement
  (`scripts/sql-guard.js`, `scripts/sql-cli-guard.js`, [hardening](docs/hardening.md)).
- **Adversarially tested.** Gaps found by an adversarial test run are pinned as regression cases in
  [`tests/adversarial-regressions.test.js`](tests/adversarial-regressions.test.js).

## Quick start

Requires Node.js 18+ on `PATH`.

**As a plugin (local directory):**

```bash
git clone https://github.com/csakegyruszki/agent-governance-hooks
claude plugin validate ./agent-governance-hooks
claude --plugin-dir ./agent-governance-hooks
node agent-governance-hooks/scripts/doctor.js     # self-check
```

Hooks come from `hooks/hooks.json` and reference scripts through `${CLAUDE_PLUGIN_ROOT}`. Plugin
hooks apply to every project while the plugin is enabled; disable the plugin to switch them off.

**As settings:** merge `settings-snippet.json` into your `settings.json` and replace
`/ABSOLUTE/PATH/TO/` with the clone path (quote it if it contains spaces).

Plugin and hook formats follow the Claude Code documentation:
[plugins](https://code.claude.com/docs/en/plugins),
[plugin reference](https://code.claude.com/docs/en/plugins-reference),
[hooks](https://code.claude.com/docs/en/hooks).

## Components

| hook | event / matcher | blocks or does | details |
|---|---|---|---|
| `sql-guard` | PreToolUse, MCP tools ending in `execute_sql`, `apply_migration`, `deploy_edge_function` | `DROP TABLE/SCHEMA/DATABASE`, `TRUNCATE`, `ALTER TABLE ... DROP COLUMN`, `DELETE`/`UPDATE` without `WHERE` or with a tautological `WHERE` (`1=1`, `true`, `x=x`, `OR 1=1`, ...) | [hardening](docs/hardening.md) |
| `sql-cli-guard` | PreToolUse, `Bash`/`PowerShell` commands that call `psql`, `mysql`, `mariadb`, `duckdb`, `sqlite3` | the same SQL patterns in the command, `-c`/`-e` args, heredocs and referenced `.sql` files (`<`, `-f`, `.read`, up to 1 MB) | [hardening](docs/hardening.md) |
| `deletion-guard` | PreToolUse, `Bash`/`PowerShell` | recursive or forced deletes (`rm -r`/`-f`, `Remove-Item -Recurse`, `rmdir /s`, `find -delete`, `git clean -f`, `shutil.rmtree`, ...) and any delete inside `GUARDRAIL_PROTECTED_DIRS`; suggests the trash instead. Asks (never denies) on `robocopy /MIR`/`/PURGE`, `rsync --delete*` and single-target script deletes aimed at a protected directory | [deletion-guard](docs/deletion-guard.md) |
| `secret-guard` | PreToolUse, every tool | API keys, tokens and private keys leaving the machine: in URLs, `curl`/`wget`/`Invoke-WebRequest` headers and bodies, secret files piped to network tools, `git add` of `.env`/`*.pem`/`id_rsa*`; reports only the kind of secret and its length; localhost targets allowed. Asks (never denies) when a shell command reads a secret file (`cat .env`, `Get-Content ~/.ssh/id_x`, `cp`, python `open()`) | [secret-guard](docs/secret-guard.md) |
| `no-nested-agent` | PreToolUse, `Agent`/`Task` | a spawn raised from inside a subagent (payload carries `agent_id`); only the main context delegates | [hardening](docs/hardening.md) |
| `delegation-guard` | PreToolUse, `Agent`/`Task` | a subagent prompt with no named scope (path, file, backticked identifier, URL) or no size limit (`max N lines`, JSON schema, ...) | [delegation-guard](docs/delegation-guard.md) |
| `return-contract` | PreToolUse `Agent`/`Task` and the subagent hand-back tool; SubagentStop | **opt-in per delegation** (the prompt carries the line `RETURN: contract-v1`): appends the report schema to the prompt, then denies a hand-back, or blocks the subagent's stop, when the final report has no valid JSON block (status, summary, findings with evidence and basis, not-measured list). At most 2 denials per agent; after that the report is let through and logged. On opted-in calls the injection returns `permissionDecision: "allow"` with `updatedInput`, which skips the permission prompt for that Agent call (see [return-contract](docs/return-contract.md)) | [contract](docs/contracts/subagent-return-v1.md) |
| `turn-budget` | PreToolUse, any tool, inside subagents only | **advisory**: counts a subagent's tool calls and, 4 and 2 calls before the `maxTurns` in its agent file, injects "stop investigating and write your report". Subagents without a `maxTurns` line are ignored | [turn-budget](docs/turn-budget.md) |
| `delegation-log` | PostToolUse `Agent`/`Task`; SubagentStop | **logs only**: a `launch` row (requested versus resolved model, contract requested) and a `stop` row (token usage and turns from the subagent transcript, `cap_hit`, contract outcome) | [delegation-log](docs/delegation-log.md) |
| `lesson-inject` | SubagentStart / SubagentStop | injects up to 3 `severity: critical` lessons for the subagent's type from `GUARDRAIL_LESSONS_DIR`, then logs whether they were attested; never blocks | [lesson-inject](docs/lesson-inject.md) |
| `completion-gate` | PreToolUse, `Write`/`Edit`/`MultiEdit` of a ticket file | setting `status: done` without valid evidence (see above); any write under `tickets/evidence/` | [tickets](docs/tickets.md) |
| `doc-touch-gate` | PostToolUse `Write`/`Edit`/`MultiEdit`; Stop | **opt-in** (inactive unless `GUARDRAIL_DOC_PROJECT_GLOBS` or `GUARDRAIL_DOC_ENABLED=1` is set); **blocks once per project per session**: at least 3 distinct files edited in a project and its memory file (default `PROJECT_MEMORY.md`) not edited afterwards; asks for a memory-file update and one log line, or a one-sentence reason | [doc-touch-gate](docs/doc-touch-gate.md) |
| `instruction-budget-lint` | PostToolUse, `Write`/`Edit`/`MultiEdit` | **warns**: an always-loaded instruction file (CLAUDE.md, rules without `paths:`) grew past its ceiling, or a new rule has no `paths:`; sizes in Unicode code points | [lint](docs/instruction-budget-lint.md), [placement guide](docs/instruction-placement.md) |

| tool | purpose |
|---|---|
| `tools/tickets.py` | list, due, integrity check, atomic ID reservation, `--verify` (runs a ticket's `checks` and writes the evidence file) |
| `tools/project_init.py` | scaffolds the project skeleton in `templates/project-skeleton/` (memory file, log file, `.claude/settings.json`, plus per-type extras); configurable types and path-based type detection; never overwrites |
| `scripts/doctor.js` | self-check: Node version, every referenced hook script, audit log writable, and whether nested-subagent detection has been observed working on this install (`UNKNOWN` until it has) |
| `scripts/instruction-budget-baseline.js` | records the ceilings used by `instruction-budget-lint` (`--write`) |

## Configuration

| variable | effect | default |
|---|---|---|
| `GUARDRAIL_FAIL_CLOSED=1` | a hook that gets malformed input or crashes **denies** instead of allowing | unset: fail open; `lesson-inject` never blocks |
| `GUARDRAIL_APPROVAL` | `deny` or `ask`. In `ask` the four blocking guards (`sql-guard`, `sql-cli-guard`, `deletion-guard`, `secret-guard`) return `permissionDecision: "ask"` for destructive or secret actions instead of `deny`, so Claude Code prompts the human. An `ask` can also be answered without a human by a PermissionRequest hook, `--permission-prompt-tool` or an SDK `canUseTool` host (whichever decides first applies; see the [hooks reference](https://code.claude.com/docs/en/hooks)); keep `deny` if you run one. See [Approval mode](#approval-mode) | `deny` |
| `GUARDRAIL_AUDIT_LOG` | JSONL file for bypasses, denies, errors and lesson injections. Only the last directory is created; its parent must exist | `~/.agent-governance-hooks/audit.jsonl` |
| `GUARDRAIL_PROTECTED_DIRS` | directories where `deletion-guard` blocks every delete (path-separator list) (asks under `GUARDRAIL_APPROVAL=ask`) | unset |
| `GUARDRAIL_LESSONS_DIR` | lesson files for `lesson-inject` (see `examples/lessons/`) | unset: hook does nothing |
| `GUARDRAIL_TICKETS_DIR` | ticket directory for `tools/tickets.py` and `completion-gate` | `<project>/tickets` |
| `GUARDRAIL_PYTHON` | Python used by `completion-gate` | `python3`, then `python` on `PATH` |
| `GUARDRAIL_DOC_ENABLED`, `GUARDRAIL_DOC_PROJECT_GLOBS`, `GUARDRAIL_DOC_MEMORY_FILE`, `GUARDRAIL_DOC_LOG_FILE`, `GUARDRAIL_DOC_MIN_FILES`, `GUARDRAIL_DOC_IGNORE_DIRS`, `GUARDRAIL_DOC_STATE_DIR` | `doc-touch-gate` (and the file names `project_init.py` writes): whether it is on, which directories are projects, the front-page and log file names, the threshold (`0` = off), directories to skip | see [doc-touch-gate](docs/doc-touch-gate.md) |
| `GUARDRAIL_INSTRUCTION_FILES` / `GUARDRAIL_INSTRUCTION_BUDGET` | which files count as always-loaded, and where their ceilings live | see [lint docs](docs/instruction-budget-lint.md) |

**Approval mode.** With `GUARDRAIL_APPROVAL=ask` the human prompt is the primary approval path:
the reason text is shown in the prompt with "Approve only if you intended this." and the audit log
records `event: ask`. Malformed input, fail-closed errors, un-loggable bypasses, the evidence-directory
block and `completion-gate` never become a prompt. Claude Code documents that in a `-p` run where no
one can answer the prompt the call is denied. Measured on Claude Code 2.1.288 (headless): `ask`
blocked the command in every permission mode where the model attempted Bash (five of six;
`plan` never called it), including `bypassPermissions`
([measurement table](docs/hardening.md#measured-behaviour-of-ask-per-permission-mode-claude-code-21288-headless--p));
the interactive prompt itself was not part of that measurement. Recommendation: interactive
sessions `ask`; unattended or CI runs the default `deny`, or the audited escape hatch below.

**Escape hatch.** A command or statement carrying `guardrail:confirmed reason="<at least 8
characters>"` in a comment is let through; `delegation-guard` also accepts
`guardrail:broad reason="..."` at the start of a line. A marker without a real reason is ignored,
and a bypass whose audit record cannot be written is refused.

Example lessons are in [`examples/lessons/`](examples/lessons), example tickets in
[`examples/tickets/`](examples/tickets).

## Doc maintenance

A project's front page (default `PROJECT_MEMORY.md`: goal, current state, next step, dated
decisions, open items, where the evidence is) is the one file a fresh session reads first, so it
is the file that hurts most when it is stale. Two pieces keep it current:

- **`tools/project_init.py`** scaffolds the same minimal skeleton in every project: the memory
  file, an append-only log (`_LOG.md`), and a project-scoped `.claude/settings.json` (generic: allow
  python/ls/sha256sum, deny rm/rmdir/del/git push). Built-in types add `README.md` (`code`),
  `sources/` (`research`) or an empty `EVIDENCE_MANIFEST.jsonl` plus `sources/` (`case`); custom
  types and path-based type detection come from a JSON file. It never overwrites, and in a folder
  that already holds files it adds only the core files, so an empty evidence ledger cannot make an
  old project look "ledgered". Templates: [`templates/project-skeleton/`](templates/project-skeleton).
- **`doc-touch-gate`** (**opt-in**: inactive until you set `GUARDRAIL_DOC_PROJECT_GLOBS` or `GUARDRAIL_DOC_ENABLED=1`; `GUARDRAIL_DOC_MIN_FILES=0` switches it off) closes the loop at the end of a session: if at least 3 distinct files in a
  project were edited through `Write`/`Edit`/`MultiEdit` and its memory file was not edited
  afterwards, the Stop is blocked once with a request to update it (and add one log line, or give
  a one-sentence reason). The second Stop passes and is audited. Projects are defined by directory
  patterns in `GUARDRAIL_DOC_PROJECT_GLOBS`; with only `GUARDRAIL_DOC_ENABLED=1`, the nearest ancestor with a `.git` entry or a
  memory file is the project. It is advisory and fails open, and it cannot see edits made through
  the shell. Details: [doc-touch-gate](docs/doc-touch-gate.md).

```bash
export GUARDRAIL_DOC_PROJECT_GLOBS="work/research/*;work/code/*"   # ':' separates on macOS/Linux
python3 tools/project_init.py work/code/my-tool --type code
```

## Pattern: single-binary fail-closed dispatcher (design note, no code shipped)

This repository's guards are separate Node scripts, which is simple and easy to audit. Each hook
call pays a Node start-up, and a PreToolUse event for `Bash` runs several guards one after the
other. A setup with many always-on guards can instead put them into one compiled binary:

- **One process, several guards.** `settings.json` registers a single command per event and
  matcher. The binary reads the hook JSON once, runs five guards in order (deletion, SQL CLI,
  broad filesystem search, secret exfiltration, raw-data protection) and writes one decision. In
  the author's own setup this measured about 20 ms per call against about 300 ms for the
  equivalent chain of Node scripts on Windows (one machine, not a benchmark suite).
- **Fail closed on internal error.** Malformed input, a panic or an unreadable rule file produces a
  `deny` with a reason, never a silent allow. This is the compiled counterpart of
  `GUARDRAIL_FAIL_CLOSED=1` in `scripts/lib/common.js`. A binary that cannot start at all is the
  remaining gap: keep a separate watchdog or `doctor`-style check that proves the binary runs.
- **Parity tests against a reference.** The original script versions stay in the tree, unregistered,
  and a test feeds both implementations the same corpus of payloads and requires identical
  decisions. A change to a guard is made in the compiled version and re-checked against the
  reference, so the two cannot drift silently.
- **Same escape hatch and audit format.** The bypass marker and the JSONL audit record stay
  compatible with the script versions, so existing review tooling still works.

Use this only when guard latency or the number of guards is a measured problem; for a handful of
guards the scripts here are enough.

## Behaviour

- **Ask for soft classes.** Mirror-delete sync into a protected directory, script deletes and shell
  reads of secret files return a permission prompt. In unattended `-p` runs use the audited escape hatch.
- **Fail-open by default**; set `GUARDRAIL_FAIL_CLOSED=1` to deny on malformed input or internal errors.
- **Escape hatch:** a plain-text marker; every bypass is written to the audit log.
- **Quoted text counts:** a destructive command inside a quoted string or commit message is blocked too.
- **`tickets.py --verify` runs a ticket's `checks`**: verify only tickets you trust.
- Per-hook details: [`docs/`](docs).

## Tests

```bash
npm test                                  # node --test
python -m unittest tests/test_tickets.py tests/test_project_init.py  # tickets tool, project scaffolder
```

CI runs both suites on Linux and Windows for every pull request (badge above). Tests use only
temporary directories they create; fake secrets are built at runtime. Re-run them after upgrading
Claude Code.

## Guidance documents (opt-in, not enforced)

- [`docs/delegation-routing.md`](docs/delegation-routing.md): when to delegate, which worker tier,
  brief precision, a STATUS/NEEDS report format for subagents.
- [`docs/escalation.md`](docs/escalation.md): an attempt ledger, best-checkpoint states and limits
  for deciding when an iterative fix loop should continue, change an input, or start a new approach.

No hook enforces either document.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
