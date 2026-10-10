# turn-budget

PreToolUse hook (matcher `.*`) that acts only inside subagents. A subagent that reaches its `maxTurns` cap ends without a report and the work is lost. The agent cannot see its own turn counter, so this hook counts for it and, shortly before the cap, injects a one-line warning telling it to stop investigating and write its report.

## Behaviour

- Fires only when the payload carries `agent_id`, `agent_type` and `session_id` (documented common fields inside a subagent, https://code.claude.com/docs/en/hooks). The main context is ignored.
- Looks up `maxTurns` in the frontmatter of `<agent_type>.md`. Search order: `GUARDRAIL_AGENTS_DIR` (if set, the only directory), else `<cwd>/.claude/agents`, then `<config dir>/agents` where the config dir is `CLAUDE_CONFIG_DIR` or `~/.claude`. Built-in or ad-hoc types without a `maxTurns:` line are left alone.
- Counts PreToolUse calls per `agent_id` and, with 4 and with 2 calls left before the cap, answers with `hookSpecificOutput.additionalContext`:

  `TURN BUDGET: ~4 turns left before your hard cap. Stop investigating now; write your report in the next turn. Mark anything you did not check as NOT MEASURED.`

- Never denies, never changes the tool call. Any error is audited and answered with `{}`, also under `GUARDRAIL_FAIL_CLOSED=1`.

## Agent file

```markdown
---
name: bounded-reviewer
description: Reviews one file.
maxTurns: 25
---
```

## Configuration

| Variable | Effect |
|---|---|
| `GUARDRAIL_STATE_DIR` | Where counters live (default `~/.agent-governance-hooks/state`; files under `turn-budget/<session>/<agent_id>.count`) |
| `GUARDRAIL_AGENTS_DIR` | Single directory to read agent files from (default: see search order above) |
| `CLAUDE_CONFIG_DIR` | Claude Code config directory used for the default agent directory |
| `GUARDRAIL_AUDIT_LOG` | Audit JSONL path, used for `error` events |

## Limits

- **Tool calls are not turns.** One assistant turn can issue several parallel tool calls, so the count is at least the turns used and the warning arrives earlier than the true turn count. That is the conservative side, but a warning can come with more than 4 turns left.
- It cannot make an agent obey. The warning is context, not enforcement.
- The counter is a file of one byte per call (appends are safe under parallel hook processes). Counter files are not cleaned up; they are tiny, delete the state directory whenever you like.
- Agent files defined elsewhere (for example inside a plugin) are not searched; point `GUARDRAIL_AGENTS_DIR` at them.
