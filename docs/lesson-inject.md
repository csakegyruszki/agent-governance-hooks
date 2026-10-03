# lesson-inject

SubagentStart + SubagentStop hook (one script, dispatching on `hook_event_name`). Subagents start with a fresh context and never read your notes, so lessons you learned the hard way do not reach them. This hook pushes the critical ones.

## Behaviour

- **SubagentStart**: reads `*.md` lessons from `GUARDRAIL_LESSONS_DIR`. A lesson is injected only if its frontmatter has `severity: critical` and `applies_to` contains the subagent's `agent_type` exactly (case-sensitive). At most 3 lessons, at most 900 characters in total, sorted by file name. Output: `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"..."}}`. The text lists name, description and file path per lesson and asks the subagent to end its report with one `INFORMATION:` line giving one word per lesson (`applied` or `not-relevant`). An `inject` event is written to the audit log.
- **SubagentStop**: if an `inject` event exists for this `agent_id`, writes an `attest` event with `attested: true|false` (true only if a line starting `INFORMATION:` in `last_assistant_message` mentions at least one injected lesson name, case-insensitive; otherwise false with a `reason`: `no matching lesson name` or `no INFORMATION line`). It never blocks.
- No `GUARDRAIL_LESSONS_DIR` set: does nothing. Any error (including malformed stdin) is audited as an `error` event and answered with `{}`: never blocks, also under `GUARDRAIL_FAIL_CLOSED`.

## Lesson file format

```markdown
---
name: empty-result-tool-down
description: One sentence, shown to the subagent.
severity: critical          # critical | high | normal | low; only critical is injected
applies_to: [general-purpose, Explore]   # may also sit under a metadata: block
---
Body (not injected; the subagent is pointed to the file).
```

Samples: `examples/lessons/`.

## Configuration

| Variable | Effect |
|---|---|
| `GUARDRAIL_LESSONS_DIR` | Directory of lesson files (no default) |
| `GUARDRAIL_AUDIT_LOG` | Audit JSONL path (default `~/.agent-governance-hooks/audit.jsonl`) |

## Payload fields used

- SubagentStart: `agent_type`, `agent_id`, `session_id`; output `hookSpecificOutput.additionalContext`.
- SubagentStop: `agent_id`, `agent_type`, `last_assistant_message`.

Documentation check (https://code.claude.com/docs/en/hooks, fetched 2026-10-03): `additionalContext` is listed for SubagentStart; `last_assistant_message` is documented for Stop and SubagentStop; `agent_id` and `agent_type` are documented as common fields inside a subagent.

## Cost

Each injected lesson adds tokens (up to about 900 characters in total) to every matching subagent start. Keep `critical` for lessons whose omission is expensive, and keep `applies_to` narrow.

## Limits

- The `INFORMATION:` line is an attestation that the subagent saw the lessons, not proof it followed them. The audit log only records whether the line was present.
- The frontmatter reader is minimal: `applies_to` must be an inline list (`[a, b]`), and `name`, `description`, `severity` single-line values.
- Matching is exact on `agent_type`; there are no wildcards or aliases, so `applies_to` must list the exact `agent_type` values.
- A lesson with no frontmatter, or without `severity` or `description`, is skipped and audited as `lesson_skipped` (file, reason).
- If SubagentStop never fires for an agent, that shows up as an `inject` record with no `attest` record, not as `attested: false`.
