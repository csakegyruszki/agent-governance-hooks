# doc-touch-gate

PostToolUse (`Write|Edit|MultiEdit`) and Stop hook, one script (`scripts/doc-touch-gate.js`). It keeps a project's front page, by default `PROJECT_MEMORY.md`, from going stale: a session that changes several files in a project and then stops without touching that page is asked once to update it.

## Opt-in

The hook is **inactive by default**: it answers `{}` on every event and writes nothing (no state file, no audit row). It becomes active when `GUARDRAIL_DOC_PROJECT_GLOBS` is set, or when `GUARDRAIL_DOC_ENABLED=1` is set (which turns on the `.git` / memory-file ancestor fallback below). `GUARDRAIL_DOC_MIN_FILES=0` switches it off again.

## Behaviour

- **PostToolUse**: when the edited file lies inside a project, it records `(session, project root, relative path)` in a small per-session state file. Only the three edit tools are seen.
- **Stop**: per project, if at least `GUARDRAIL_DOC_MIN_FILES` (default 3) distinct *substantive* files were edited this session and the memory file was not edited after the last substantive edit, the hook answers `{"decision":"block","reason":...}`. The reason names the project, the file count and the two documents to update (memory file, log file), or asks for a one-sentence reason why no update is needed.
- **Once, then pass.** A project is blocked at most once per session. The next Stop passes (`allow-already-blocked`), as does a Stop with `stop_hook_active: true` on first sight (`allow-stop-hook-active`). Every Stop decision is written to the audit log (`action`: `block`, `allow-below-threshold`, `allow-memory-updated`, `allow-already-blocked`, `allow-stop-hook-active`).
- **Substantive** = not the memory file, not the log file, not under `archive/`. The comparison counts distinct files, so ten edits of one file are one file.
- **Skeleton hint.** If the project lacks the memory file, the log file or `.claude/settings.json`, the reason also carries the `tools/project_init.py` command that creates them.
- **Advisory.** Any error (including malformed stdin and an unusable state directory) is audited and answered with `{}`, also under `GUARDRAIL_FAIL_CLOSED=1`: blocking every session stop because of a hook bug would cost more than a missed nudge.

## Project roots

`GUARDRAIL_DOC_PROJECT_GLOBS` lists directory patterns, separated by the platform path delimiter (`:` or `;`) or newlines. Each pattern names the project root directory:

| pattern part | meaning |
|---|---|
| `*` | exactly one path segment that does not start with `.` or `_` (cache and helper folders are not projects) |
| any other segment | literal, case-insensitive |
| leading `/` or drive letter | anchored at the path start; otherwise the pattern matches at any segment boundary |
| `~` | the home directory |
| leading `!` | exclusion: nothing below a matching directory is a project |

Both slash styles are accepted. The edited file must lie *below* the matched directory, so a file directly inside `work/research/` is not mistaken for a project. If several patterns match, the leftmost match wins.

```text
GUARDRAIL_DOC_PROJECT_GLOBS="work/research/*;work/cases/*/*;work/code/*;!work/cases/tools"
```

If the variable is unset and `GUARDRAIL_DOC_ENABLED=1`, the project root is the nearest ancestor directory that contains the memory file or a `.git` entry. With neither set the hook is off.

## Configuration

| variable | effect | default |
|---|---|---|
| `GUARDRAIL_DOC_ENABLED` | `1` activates the hook without globs, using the nearest ancestor with the memory file or `.git` as project root | unset: hook is off unless globs are set |
| `GUARDRAIL_DOC_PROJECT_GLOBS` | project root patterns (above); setting it activates the hook | unset |
| `GUARDRAIL_DOC_MEMORY_FILE` | file name of the project front page | `PROJECT_MEMORY.md` |
| `GUARDRAIL_DOC_LOG_FILE` | file name of the append-only log | `_LOG.md` |
| `GUARDRAIL_DOC_MIN_FILES` | distinct substantive files that trigger the block; `0` disables the hook; an empty or invalid value means `3` | `3` |
| `GUARDRAIL_DOC_IGNORE_DIRS` | directories (path-delimiter list) the gate never applies to | `~/.claude` |
| `GUARDRAIL_DOC_STATE_DIR` | per-session state | `<GUARDRAIL_STATE_DIR or ~/.agent-governance-hooks/state>/doc-touch` |
| `GUARDRAIL_AUDIT_LOG` | audit JSONL | `~/.agent-governance-hooks/audit.jsonl` |

## Limits

- Only edits made through `Write`, `Edit` or `MultiEdit` are seen. Files changed by shell commands (redirects, `sed -i`, scripts, `git checkout`, generators) are invisible, so a session that works mostly through the shell is not counted.
- The hook checks *that* the memory file was edited after the last substantive edit, not *what* was written. Editing one character satisfies it; the audit log and your review are the control.
- The state file is per session id. A session that is resumed under a new id starts counting again.

## Scaffolding

`tools/project_init.py` creates the skeleton the gate looks for (memory file, log file, `.claude/settings.json`) from `templates/project-skeleton/`, with built-in types `project`, `code`, `research`, `case` and custom types and path-based type detection from a JSON file. See `templates/project-skeleton/README.md`.
