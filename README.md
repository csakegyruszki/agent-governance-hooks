# agent-governance-hooks

Governance hooks for Claude Code: safety, delegation discipline, knowledge transfer and completion integrity in one plugin.

Nine hooks and a ticket tool, packaged as a Claude Code plugin. They block destructive SQL,
recursive deletes and secret exfiltration, keep subagent delegation scoped, inject critical
lessons into subagents and check that they were acknowledged, and refuse to mark a ticket `done`
without fresh, passing evidence. No npm dependencies: Node.js 18+ for the hooks, Python 3.9+
(standard library) for `tools/tickets.py` and `completion-gate`.

Author: [csakegyruszki](https://github.com/csakegyruszki). License: Apache-2.0.
Repository: https://github.com/csakegyruszki/agent-governance-hooks

Not affiliated with or endorsed by Anthropic.

## What sets it apart

- **Four concerns, one plugin.** Safety (`sql-guard`, `sql-cli-guard`, `deletion-guard`,
  `secret-guard`), delegation discipline (`delegation-guard`, `no-nested-agent`), knowledge
  transfer (`lesson-inject`) and completion integrity (`completion-gate` + `tools/tickets.py`)
  share one audit log, one escape-hatch format and one fail-open/fail-closed switch
  (`scripts/lib/common.js`, `hooks/hooks.json`).
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
| `deletion-guard` | PreToolUse, `Bash`/`PowerShell` | recursive or forced deletes (`rm -r`/`-f`, `Remove-Item -Recurse`, `rmdir /s`, `find -delete`, `git clean -f`, `shutil.rmtree`, ...) and any delete inside `GUARDRAIL_PROTECTED_DIRS`; suggests the trash instead | [deletion-guard](docs/deletion-guard.md) |
| `secret-guard` | PreToolUse, every tool | API keys, tokens and private keys leaving the machine: in URLs, `curl`/`wget`/`Invoke-WebRequest` headers and bodies, secret files piped to network tools, `git add` of `.env`/`*.pem`/`id_rsa*`; reports only the kind of secret and its length; localhost targets allowed | [secret-guard](docs/secret-guard.md) |
| `no-nested-agent` | PreToolUse, `Agent`/`Task` | a spawn raised from inside a subagent (payload carries `agent_id`); only the main context delegates | [hardening](docs/hardening.md) |
| `delegation-guard` | PreToolUse, `Agent`/`Task` | a subagent prompt with no named scope (path, file, backticked identifier, URL) or no size limit (`max N lines`, JSON schema, ...) | [delegation-guard](docs/delegation-guard.md) |
| `lesson-inject` | SubagentStart / SubagentStop | injects up to 3 `severity: critical` lessons for the subagent's type from `GUARDRAIL_LESSONS_DIR`, then logs whether they were attested; never blocks | [lesson-inject](docs/lesson-inject.md) |
| `completion-gate` | PreToolUse, `Write`/`Edit`/`MultiEdit` of a ticket file | setting `status: done` without valid evidence (see above); any write under `tickets/evidence/` | [tickets](docs/tickets.md) |
| `instruction-budget-lint` | PostToolUse, `Write`/`Edit`/`MultiEdit` | **warns**: an always-loaded instruction file (CLAUDE.md, rules without `paths:`) grew past its ceiling, or a new rule has no `paths:`; sizes in Unicode code points | [lint](docs/instruction-budget-lint.md), [placement guide](docs/instruction-placement.md) |

| tool | purpose |
|---|---|
| `tools/tickets.py` | list, due, integrity check, atomic ID reservation, `--verify` (runs a ticket's `checks` and writes the evidence file) |
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
| `GUARDRAIL_INSTRUCTION_FILES` / `GUARDRAIL_INSTRUCTION_BUDGET` | which files count as always-loaded, and where their ceilings live | see [lint docs](docs/instruction-budget-lint.md) |

**Approval mode.** With `GUARDRAIL_APPROVAL=ask` the human prompt is the primary approval path:
the reason text is shown in the prompt with "Approve only if you intended this." and the audit log
records `event: ask`. Malformed input, fail-closed errors, un-loggable bypasses, the evidence-directory
block and `completion-gate` never become a prompt. Claude Code documents that in a `-p` run where no
one can answer the prompt the call is denied. What each permission mode does with `ask` was NOT
MEASURED on this release, because headless runs were not authenticated in the build environment; see
[hardening notes](docs/hardening.md#approval-mode-guardrail_approvalask). Recommendation: interactive
sessions `ask`; unattended or CI runs the default `deny`, or the audited escape hatch below.

**Escape hatch.** A command or statement carrying `guardrail:confirmed reason="<at least 8
characters>"` in a comment is let through; `delegation-guard` also accepts
`guardrail:broad reason="..."` at the start of a line. A marker without a real reason is ignored,
and a bypass whose audit record cannot be written is refused.

Example lessons are in [`examples/lessons/`](examples/lessons), example tickets in
[`examples/tickets/`](examples/tickets).

## Scope and limits

- **Defense in depth, not a security boundary.** The guards are text scans, not shell or SQL
  parsers. Commands assembled through shell variables, `eval`, encoded text, scripts in other
  languages or other clients are outside their scope.
- **Fail-open by default.** On malformed input or an internal error every hook allows. Set
  `GUARDRAIL_FAIL_CLOSED=1` to deny instead. If no Python is found, `completion-gate` also fails
  open with an audit event (denies under `GUARDRAIL_FAIL_CLOSED=1`).
- **The escape-hatch marker is plain text.** The agent can write it as well as a human can; the
  audit log is the review point for every bypass.
- **Deliberate over-blocking.** A destructive command inside a quoted string or commit message, or
  a commented-out `DROP`, is blocked; quotes are not stripped because that would also hide real
  matches. Use the escape hatch for such false positives.
- **`no-nested-agent` depends on `agent_id`.** It relies on Claude Code sending `agent_id` for
  calls made inside a subagent; if a version stops sending it, the hook allows. `doctor.js` reports
  whether the field has been observed.
- **`tickets.py --verify` executes the shell commands in a ticket's `checks`.** Treat ticket files
  like a Makefile: do not verify tickets from an untrusted source. The gate hook itself never runs
  them.
- `lesson-inject` adds tokens to every matching subagent; keep `critical` lessons few.
- Per-hook limits are listed in each document under [`docs/`](docs).

## Tests

```bash
npm test                                  # node --test
python -m unittest tests/test_tickets.py  # tickets tool
```

345 Node tests and 28 Python tests, run with Claude Code 2.1.288 and Node.js 22. Hook matchers and
payload fields can change between Claude Code versions; re-run the tests after upgrading.

- The SQL, deletion, secret and delegation tests are regression cases: concrete inputs that exposed
  a gap or pin intended behaviour. Tests touch only temporary directories they create; no real
  database, repository file or ticket is modified. Fake secrets are built at runtime so the test
  files do not trip secret scanners.
- `lesson-inject.test.js` runs on the shipped sample lessons in `examples/lessons/`.
- `no-nested-agent.test.js` uses payload shapes derived from real Claude Code hook events, with
  values redacted and only the fields the hook reads kept. The field names `agent_id` /
  `agent_type` follow the Claude Code [hooks documentation](https://code.claude.com/docs/en/hooks).
  Its malformed-input cases are synthetic and labelled so.

## Guidance documents (opt-in, not enforced)

- [`docs/delegation-routing.md`](docs/delegation-routing.md): when to delegate, which worker tier,
  brief precision, a STATUS/NEEDS report format for subagents.
- [`docs/escalation.md`](docs/escalation.md): an attempt ledger, best-checkpoint states and limits
  for deciding when an iterative fix loop should continue, change an input, or start a new approach.

No hook enforces either document.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
