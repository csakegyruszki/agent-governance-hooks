# Changelog

## Unreleased

Added

- Soft classes that always answer with a permission prompt (ask, never deny, in every approval mode; new `softAsk` in `scripts/lib/common.js`, audited as event ask with soft: true):
  - `deletion-guard`: robocopy /MIR or /PURGE and rsync --delete* (destination argument only), plus single-target script deletes (python os.remove/unlink/rmdir, Path(...).unlink/rmdir, node fs.unlink*) whose quoted path is inside GUARDRAIL_PROTECTED_DIRS. Outside the protected directories: allow as before. Temp placeholders ($env:TEMP, $env:TMP, ${env:TEMP}, %TEMP%, %TMP%, $TMPDIR) resolve to the temp directory even when unset.
  - `secret-guard`: a shell command that reads a secret file (cat/type/gc/Get-Content/head/tail/less/cp/Copy-Item, python open(), node readFileSync) of .env and .env.* (not .example/.sample/.template/.dist), *credentials*.json, auth.json, id_rsa-style keys or any file under a .ssh directory (not *.pub, known_hosts, config).
- README: documented limit that obfuscation is not caught; tests/soft-asks.test.js (77 tests, including known-limit cases asserted as allow).

Changed

- tests/secret-guard.test.js: cat .env and cp .env .env.bak moved out of the must-allow list (they now ask).

Compatibility

- Every call denied before is still denied with the same message. Newly asking: reading a secret file in the shell, mirror-delete sync into a protected directory, script deletes the old rule missed. No new deny.

## 0.5.0

Added

- `doc-touch-gate` (PostToolUse `Write`/`Edit`/`MultiEdit` + Stop), **opt-in** (inactive unless `GUARDRAIL_DOC_PROJECT_GLOBS` or `GUARDRAIL_DOC_ENABLED=1` is set; `GUARDRAIL_DOC_MIN_FILES=0` disables it): after a session that edited at
  least 3 distinct files in a project without touching its memory file (default `PROJECT_MEMORY.md`),
  blocks the Stop once per project per session and asks for an update plus one log line. Project
  roots from `GUARDRAIL_DOC_PROJECT_GLOBS` (or, with `GUARDRAIL_DOC_ENABLED=1`, the nearest ancestor with `.git` / the memory file);
  file names, threshold, ignored directories and state directory are configurable
  (`GUARDRAIL_DOC_*`). Advisory: fails open. See `docs/doc-touch-gate.md`.
- `tools/project_init.py` and `templates/project-skeleton/`: scaffolds the project skeleton (memory
  file, `_LOG.md`, `.claude/settings.json`; per-type `README.md`, `sources/`, empty
  `EVIDENCE_MANIFEST.jsonl`). Built-in types `project`, `code`, `research`, `case`; custom types and
  path-based detection from a JSON file. Never overwrites; typed add-ons only in new folders.
- `return-contract`, `turn-budget`, `delegation-log`: opt-in typed subagent reports
  (`RETURN: contract-v1`, schema in `docs/contracts/subagent-return-v1.md`), an advisory warning
  shortly before a subagent's `maxTurns` cap, and a per-delegation log (model, tokens, turns, cap hit,
  contract outcome). Shared plumbing: `runAdvisory` in `scripts/lib/common.js`.
- README: doc-maintenance section and the "single-binary fail-closed dispatcher" design note
  (a pattern description; no code is shipped for it).
- Shared `ensureDir` in `scripts/lib/common.js` (guarded recursive mkdir for state directories), used by `doc-touch-gate` and `turn-budget`.
- Tests: `tests/return-contract.test.js` (16), `tests/turn-budget.test.js` (9), `tests/delegation-log.test.js` (9), `tests/doc-touch-gate.test.js` (19, including default-off, enabled-blocks-once and `MIN_FILES=0`) and `tests/test_project_init.py` (11).

Compatibility

- No existing hook (`sql-guard`, `sql-cli-guard`, `deletion-guard`, `secret-guard`, `no-nested-agent`,
  `delegation-guard`, `lesson-inject`, `completion-gate`, `instruction-budget-lint`) changed behaviour.
- Defaults of the new hooks: `doc-touch-gate` is off until configured (see above); `return-contract`
  acts only on delegations whose prompt carries the line `RETURN: contract-v1`, and on those it returns
  `permissionDecision: "allow"` with `updatedInput`, which skips the permission prompt for that Agent
  call; `turn-budget` is **on** once registered (advisory; only for subagents whose agent file has a
  `maxTurns` line, writes a one-byte-per-call counter under the state directory); `delegation-log` is
  **on** once registered (appends launch/stop rows to the audit log; never blocks or rewrites).
- The new hooks are registered in `hooks/hooks.json` and `settings-snippet.json`; remove those entries
  to run without them.
