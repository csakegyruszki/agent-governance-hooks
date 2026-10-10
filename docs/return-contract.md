# return-contract

Opt-in typed reports for delegated work. A subagent's free-text report cannot be checked mechanically; a fixed JSON block can. The spec, including the exact text injected into the prompt, is [contracts/subagent-return-v1.md](contracts/subagent-return-v1.md).

## Permission behaviour

On those opted-in Agent/Task calls the hook returns `permissionDecision: "allow"` together with `updatedInput`, so **the permission prompt for that Agent call is skipped** (deny and ask rules are still evaluated). The Claude Code [hooks reference](https://code.claude.com/docs/en/hooks) says `"allow"` "skips the permission prompt" and that `updatedInput` is to be combined "with `"allow"` to auto-approve, or `"ask"` to show the modified input to the user"; it does not state that `updatedInput` takes effect with no decision at all, so the hook keeps `allow`. Prompts without the `RETURN: contract-v1` line are untouched.

One script, three registrations (`hooks/hooks.json`):

| Event / matcher | What it does |
|---|---|
| PreToolUse `Agent\|Task` | The prompt has a line `RETURN: contract-v1` on its own: append the spec's INJECT block (once), after a sentinel comment that only this hook writes. A prompt that merely quotes the spec is never enforced. The output is `permissionDecision: "allow"` plus `updatedInput`, so the user's permission prompt for that Agent call is skipped (see below). |
| PreToolUse `SubagentHandback` | Contract requested and the report in `tool_input.message` is invalid, and fewer than 2 earlier denials for this `agent_id`: deny with the list of problems. |
| SubagentStop | Contract requested, no accepted handback, `last_assistant_message` invalid, `stop_hook_active` false: block once with the problems. |

`SubagentHandback` is the tool a subagent uses to deliver its report on Claude Code v2.1.271 or later (https://code.claude.com/docs/en/hooks). On builds without it, only the SubagentStop path applies.

## Behaviour

- Opt-in: nothing happens without the `RETURN: contract-v1` line.
- A report that still fails after the retries (2 denied handbacks, or 1 block on the SubagentStop path) is **let through and logged** (`allow-after-retries` / `allow-after-retry`). The hook never traps an agent in a loop; the caller sees the failure in the log and decides.
- A denied handback is not a delivery: SubagentStop still checks the final message in that case.
- A transcript that cannot be read is logged as `transcript-unreadable` and never treated as "contract not requested".
- Structural checks only (see the table in the spec): the report is well-formed and every finding states what it rests on. It cannot tell whether a finding is true.

## Escape hatch

A report containing `guardrail:confirmed reason="<at least 8 non-whitespace characters>"` skips the check. It is honoured only if the `bypass` event was written to the audit log. The model can type the marker itself, so review `bypass` events.

## Audit log

Rows go to the shared audit log with `hook: "return-contract"`: `event` is one of `inject`, `deny`, `allow`, `allow-after-retries`, `block`, `allow-after-retry`, `skip-handback`, `bypass`, `transcript-unreadable`, `error`. `phase` is the hook event and tool (`PreToolUse:SubagentHandback`), plus `agent_id`, `agent_type`, `requested`, `valid`, `problems`. [delegation-log](delegation-log.md) reads these rows to record the contract outcome per run.

## Configuration

| Variable | Effect |
|---|---|
| `GUARDRAIL_AUDIT_LOG` | Audit JSONL path (default `~/.agent-governance-hooks/audit.jsonl`) |
| `GUARDRAIL_RETURN_CONTRACT_SPEC` | Spec file to read the INJECT block from (default: the shipped `docs/contracts/subagent-return-v1.md`) |
| `GUARDRAIL_RETURN_CONTRACT_ADVICE=1` | Makes [delegation-guard](delegation-guard.md) hint at the contract on ad-hoc calls that lack the line |

`GUARDRAIL_FAIL_CLOSED` is deliberately **not** honoured: this is a report-quality check, not a safety guard, so an internal error is audited and answered with `{}` (same stance as lesson-inject).

## Payload fields used

- PreToolUse Agent/Task: `tool_name`, `tool_input.prompt`; output `hookSpecificOutput.updatedInput` with `permissionDecision: "allow"`.
- PreToolUse SubagentHandback: `agent_id`, `tool_input.message`, `agent_transcript_path` (else derived from `transcript_path`, `session_id`, `agent_id`).
- SubagentStop: `agent_id`, `last_assistant_message`, `stop_hook_active`, `agent_transcript_path`; output top-level `decision: "block"` with `reason`.

## Limits

- The check is on form. A report can be valid and wrong; `basis: read` is the worker's claim that it opened the source, and `evidence` is where you can check.
- Whether the contract was requested is read from the first user message of the subagent transcript (the sentinel). If the transcript is unavailable, the hook logs that and does not enforce.
- Retry state (denials per agent) is read from the audit log, so a deleted or unwritable log resets the count.
- The SubagentStop verdict row may be written after `delegation-log` has already written its stop row (parallel hooks); handback-path rows always precede it.
