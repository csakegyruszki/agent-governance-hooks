# instruction-budget-lint

Warn-only PostToolUse hook that notices when an always-loaded instruction file grows, or when a new
rule file silently becomes global.

## Why

Anything in `CLAUDE.md` or in a `.claude/rules/*.md` file without `paths:` frontmatter is loaded into
every session, whether or not the topic comes up. Such files grow one reasonable addition at a time,
and a one-off cleanup does not stay done. The hook makes the growth visible at the moment it happens.
Where content should go instead: [instruction-placement.md](instruction-placement.md).

## Event and output

- Event: **PostToolUse**, matcher `Write|Edit|MultiEdit`. Not PreToolUse: the check needs the file size
  after the edit, which exists only once the tool has run.
- Output: `hookSpecificOutput.additionalContext` (Claude sees it, delivered next to the tool result)
  plus `systemMessage` (shown to the user). Source of both fields:
  [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), PostToolUse decision control and
  "Add context for Claude".
- **It never denies**, including malformed input and `GUARDRAIL_FAIL_CLOSED=1`: a size warning is not
  worth blocking an edit. Any error is audited and answered with `{}`.

## What it checks

For an edited file that is in the always-loaded set and has no `paths:` frontmatter:

| Situation | Message |
|---|---|
| size > baseline, <= ceiling | `GREW` with the delta |
| size > ceiling | `OVER ITS CEILING` |
| `.claude/rules/**/*.md`, no budget entry | `GLOBAL RULE WITHOUT A BUDGET ENTRY` |
| unchanged, shrunk, path-scoped, outside the set, no budget file | silent |

An always-loaded file that is not a rule and has no budget entry is silent: there is nothing to compare
against. Run the baseline script to add it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GUARDRAIL_INSTRUCTION_FILES` | `CLAUDE.md`, `.claude/CLAUDE.md`, `~/.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `~/.claude/rules/**/*.md` | Comma- or newline-separated globs. Relative globs resolve against the project dir, `~/` against the home dir. `**` matches any depth, `*` one path segment. Setting it replaces the defaults. |
| `GUARDRAIL_INSTRUCTION_BUDGET` | `<project>/.claude/instruction-budget.json` | Budget/ceiling file. |
| `CLAUDE_PROJECT_DIR` | payload `cwd` | Project dir used to resolve relative paths. |

A file in the set whose frontmatter contains `paths:` is path-scoped and ignored (it costs nothing until
Claude reads a matching file). Only the frontmatter counts; the word `paths:` in a body does not.

## The unit

Size is counted in **Unicode code points**, with `CRLF` counted as one newline. Not bytes, not UTF-16
code units (`String.length` counts an emoji as two), not tokens. The baseline script and the hook use
the same function; mixing units makes the hook report growth on an unchanged file. Code points are a
proxy for token cost, not a measurement of it.

## The budget file

Generated, never typed:

```text
node scripts/instruction-budget-baseline.js            # dry run: print sizes
node scripts/instruction-budget-baseline.js --write    # record baseline + ceiling
node scripts/instruction-budget-baseline.js --check    # exit 1 if over ceiling or no entry; 2 if no budget file
  --dir=<project>   --headroom=1.10
```

```json
{
  "baseline_date": "2026-01-01",
  "headroom": 1.1,
  "always_loaded_total_chars": 3200,
  "files": {
    "CLAUDE.md": { "chars": 2000, "ceiling": 2200, "baseline_date": "2026-01-01", "layer": "ALWAYS_LOADED" }
  }
}
```

Keys are project-relative, `~/`-relative, or absolute, always with forward slashes. `ceiling` is
`baseline * headroom`: the aim is to notice growth, not to freeze today's size. After a deliberate
increase, re-run with `--write`.

## Known blind spot

Edits made through a shell command (a `Bash` call that rewrites the file) fire no Write/Edit event, so
the hook does not see them. The real gate is a periodic re-measure: run `--check` in CI or on a
schedule. Likewise, path-scoped rules fire on file reads, not on shell-scripted edits.

## Install

Add to `hooks/hooks.json` (or your own settings):

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit",
  "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/instruction-budget-lint.js\"" } ] } ] } }
```
