# delegation-guard

PreToolUse hook on `Agent` / `Task`. Denies a subagent call whose prompt lacks either of two things:

1. **A named scope**: a path-like token (`src/lib`), a file extension (`README.md`), a `backticked` identifier, a drive-letter path, or a URL.
2. **A size limit**: "max N", "at most N", "N lines/words/sentences/bullets/rows", "JSON", "schema", "table with N rows", "exactly N", "one number", "yes/no".

Why: a subagent prompt without scope or size limit makes the subagent wander and costs tokens, and the caller pays for it. The deny message names what is missing and shows examples.

The checks are intentionally generous. A sloppy prompt that slips through costs less than a good delegation that is blocked. A bare file name such as `settings.json` counts as scope but not as an output schema.

## Bypass

For an intentional broad task (exploratory search), put this in the prompt:

```
guardrail:broad reason="exploratory survey of an unknown repo"
```

The generic `guardrail:confirmed reason="..."` marker also works. The marker must start a line (a marker quoted mid-sentence in pasted material is ignored) and the reason needs at least 8 non-whitespace characters. A bypass is honoured only if its audit record was written successfully; if the log is not writable the call is denied with "bypass could not be logged". Denies are logged too (`event: deny`). The model can type the marker itself, so review the log.

## Configuration

| Variable | Effect |
|---|---|
| `GUARDRAIL_AUDIT_LOG` | Audit JSONL path (default `~/.agent-governance-hooks/audit.jsonl`) |
| `GUARDRAIL_FAIL_CLOSED=1` | A hook error denies instead of allowing |

## Payload fields used

`tool_name` (`Agent` or `Task`), `tool_input.prompt`, `tool_input.subagent_type` (audit only). Output is the standard PreToolUse deny object. See https://code.claude.com/docs/en/hooks.

## Limits

- Pattern matching only: it cannot judge whether the scope is the right one or the limit sensible, just that both are stated.
- English-language patterns; prompts in other languages need their own limit words or the bypass.
- It does not check model choice or agent type.
