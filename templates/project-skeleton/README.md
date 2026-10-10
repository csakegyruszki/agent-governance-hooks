# project-skeleton - template for `tools/project_init.py`

Every project folder gets the same minimal governance skeleton. Run:

```bash
python3 tools/project_init.py <path> [--type NAME] [--config FILE] [--dry-run]
```

| item | which types | source file here |
|---|---|---|
| `PROJECT_MEMORY.md` (name configurable) | all | `PROJECT_MEMORY.md` (placeholders `{{NAME}}`, `{{TODAY}}`) |
| `_LOG.md` (name configurable) | all | `_LOG.md` |
| `.claude/settings.json` | all | `claude-settings.json` (generic: allow python/ls/sha256sum, deny rm/rmdir/del/git push) |
| `archive/` | none up front | created on first use, when a superseded file is moved there |
| `EVIDENCE_MANIFEST.jsonl` (empty) and `sources/` | `case` | `EVIDENCE_MANIFEST.jsonl` |
| `sources/` | `research` | directory only |
| `README.md` (title, description, run, test) | `code` | `README.code.md` |
| nothing extra | `project` | - |

Custom types and path-based type detection come from a JSON file (`--config` or
`GUARDRAIL_PROJECT_TYPES_FILE`); see the docstring of `tools/project_init.py`. The memory and log
file names follow `GUARDRAIL_DOC_MEMORY_FILE` and `GUARDRAIL_DOC_LOG_FILE`, the same variables the
`doc-touch-gate` hook reads, so the scaffold and the gate agree on what the front page is called.

The tool never overwrites. In a folder that already holds other files it adds only the core files,
not the typed add-ons: an empty evidence ledger dropped into an existing project would read as
"ledgered, no evidence" while the evidence lives elsewhere.
