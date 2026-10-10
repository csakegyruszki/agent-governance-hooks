# delegation-log

PostToolUse (`Agent|Task`) and SubagentStop logger. Never blocks and never rewrites anything. It answers the questions a delegation otherwise leaves open: what did each run cost, which agent types hit their turn cap, which model actually ran, and how did typed reports ([return-contract](return-contract.md)) end.

## Rows

All rows go to the shared audit log (`GUARDRAIL_AUDIT_LOG`, default `~/.agent-governance-hooks/audit.jsonl`) with `hook: "delegation-log"`.

**`launch`** (PostToolUse Agent/Task): `session_id`, `agent_id` (`tool_response.agentId`), `tool_use_id`, `agent_type` (`subagent_type`, else `general-purpose`), `requested_model`, `resolved_model` (`tool_response.resolvedModel`), `description`, `contract_requested` (the prompt has the `RETURN: contract-v1` line), `is_async` (`tool_response.status == "async_launched"`; `null` if there is no status). `tool_response` may be an object or a JSON string; absent fields become `null`.

**`stop`** (SubagentStop), computed from the subagent transcript: `turns`, `tool_uses`, `models`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `first_ts`, `last_ts`, `duration_ms`. A transcript holds several rows per assistant message while it streams; usage is taken from the **last** row of each `message.id`, so tokens are not double counted. Also:

- `max_turns` and `cap_hit`: `maxTurns` from the agent file (same lookup as [turn-budget](turn-budget.md)) against the observed turns. `cap_hit` is true when `turns >= max_turns`; `max_turns` is `null` and `cap_hit` false for types without a cap.
- `contract`: `{requested, denies, final}` from the return-contract rows of this agent. `final` is `pass`, `pass-after-retry`, `failed-let-through`, `blocked-once`, `bypassed` or `none`. A contract that was requested but has no verdict row stays `none`: unknown is not recorded as a pass.

A transcript that cannot be read gives a `stop` row with `error: "transcript-unreadable"`. A SubagentStop without `agent_type` (not a subagent) is ignored.

## Configuration

| Variable | Effect |
|---|---|
| `GUARDRAIL_AUDIT_LOG` | Audit JSONL path (default `~/.agent-governance-hooks/audit.jsonl`) |
| `GUARDRAIL_AGENTS_DIR`, `CLAUDE_CONFIG_DIR` | Where agent files are read for `max_turns` (see [turn-budget](turn-budget.md)) |

Any error is audited and answered with `{}`, also under `GUARDRAIL_FAIL_CLOSED=1`.

## Example: runs that hit their cap

```bash
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")) { try { const r = JSON.parse(l); if (r.hook==="delegation-log" && r.cap_hit) console.log(r.agent_type, r.turns, r.max_turns); } catch {} }' ~/.agent-governance-hooks/audit.jsonl
```

## Limits

- Token counts come from the transcript, not from the billing system. Treat them as a measured approximation of usage, not of cost.
- `turns` counts distinct assistant messages; it is the same notion `maxTurns` uses only as far as the transcript is faithful to it.
- SubagentStop hooks run in parallel: a contract verdict written by return-contract's SubagentStop path may arrive after the stop row. Handback-path verdicts always precede it.
- The shared audit log grows without bound; rotate it yourself.
