# Subagent return contract v1

> Opt-in typed return for delegated work. Enforced by `scripts/return-contract.js`
> (see [docs/return-contract.md](../return-contract.md) for the hook).
> Why: a worker's free-text report cannot be checked mechanically; a fixed block can.

## How to request it

Put this line on its own line in the Agent/Task prompt:

```text
RETURN: contract-v1
```

The hook then appends the INJECT block below to the prompt and checks the worker's final report.
Without the line nothing happens: the contract is opt-in.

## Checks (what the hook enforces)

| field | rule |
|---|---|
| `contract` | must be `"v1"` |
| `status` | one of `DONE`, `PARTIAL`, `BLOCKED`, `FAILED` |
| `summary` | non-empty string |
| `findings` | array; each item has a non-empty `claim` and `basis` in `read`, `measured`, `inferred`; `evidence` is required unless `basis` is `inferred` |
| `not_measured` | array (may be empty) |
| `artifacts`, `checks`, `deviations` | optional arrays |
| domain: `status` is `DONE` | `findings` must contain at least one item |
| domain: `status` is `PARTIAL` / `BLOCKED` / `FAILED` | `not_measured` or `deviations` must contain a non-empty string (the report must say why) |

The checks are structural. They prove the report is well-formed and that every claim states what
it rests on; they do not prove a claim is true. `basis: read` / `measured` means the worker says it
opened or ran something, and `evidence` is where the caller can look to check.

A report that fails the check is sent back to the worker (the `SubagentHandback` call is denied, or
`SubagentStop` blocks) with the list of problems. After two failed handback attempts, or one failed
retry on the `SubagentStop` path, the report is let through and logged, and the caller decides.

## INJECT

<!-- The hook appends everything between the two markers verbatim. -->
<!-- INJECT-BEGIN -->
---
RETURN CONTRACT v1 - end your final report with exactly one fenced JSON block of this shape
(prose may come before it; the block must be valid JSON):

```json
{
  "contract": "v1",
  "status": "DONE | PARTIAL | BLOCKED | FAILED",
  "summary": "max 3 sentences",
  "findings": [
    {"claim": "one checkable statement", "evidence": "file:line | URL | command + output", "basis": "read | measured | inferred"}
  ],
  "artifacts": ["paths you wrote"],
  "checks": [{"cmd": "command you ran", "result": "exit code / pass count"}],
  "not_measured": ["what you could not establish, and why"],
  "deviations": ["where you did not follow the brief, and why"]
}
```

Rules: write the JSON values in the language of the task brief. Use `basis: inferred` for anything you
did not read or measure yourself. Empty arrays are fine; missing required keys (contract, status,
summary, findings, not_measured) are not.
<!-- INJECT-END -->
