# Changelog

## 0.5.0

Added

- `doc-touch-gate` (PostToolUse `Write`/`Edit`/`MultiEdit` + Stop): after a session that edited at
  least 3 distinct files in a project without touching its memory file (default `PROJECT_MEMORY.md`),
  blocks the Stop once per project per session and asks for an update plus one log line. Project
  roots from `GUARDRAIL_DOC_PROJECT_GLOBS` (or the nearest ancestor with `.git` / the memory file);
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
- Tests: `tests/doc-touch-gate.test.js` (15 cases) and `tests/test_project_init.py` (11 cases).

Compatibility

- No existing hook changed behaviour because of the doc-maintenance additions. The new hooks are
  registered in `hooks/hooks.json` and `settings-snippet.json`.
