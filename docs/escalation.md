# Escalation for iterative work (opt-in guidance, not enforcement)

This applies to any loop of "change something, run the check": debugging a failing test,
re-running a worker, fixing a flaky scraper. No hook enforces it; copy what you need into your own
instructions. The idea is that the measured trend of the check, not persistence, decides what
happens next.

## Attempts and the ledger

One **attempt** is one change followed by one run of the success check. Write the estimate of
the effort (tokens or wall time) before the first attempt, then keep a ledger with one row per attempt:

```text
attempt | change summary | check metric | git diff --shortstat vs best checkpoint
```

The metric is whatever the success check reports as a number: failing tests, error count, lint
findings. If the check gives no number, define one before starting.

## Best checkpoint

Whenever the metric reaches a new best, commit or tag the work as the **best checkpoint**. Every
later comparison, and every reset, refers to this checkpoint.

## States after each attempt

- **IMPROVING**: the metric is a new best. Continue the same approach.
- **FLAT**: no new best for 2 consecutive attempts. Change exactly one input and keep the
  approach: more context, a stronger model tier, or a narrower sub-goal.
- **DIVERGING**: any of these:
  - the metric is worse than the best checkpoint for 2 attempts in a row;
  - inserted plus deleted lines versus the checkpoint grew by more than 50% without a new best;
  - an attempt undoes the change of an earlier attempt.

  Reset to the best checkpoint and start a **new approach**.

## Starting a new approach

Do not let the worker that is stuck pick the next approach. Run a separate planning pass in a
fresh, read-only context. It receives the goal, the ledger, and a list of failed approaches with a
one-line reason each, and it must propose something that is not on that list. Add the new
approach to the list when it fails too.

## Limits

- At most 3 attempts per approach. After that, treat it as FLAT and change one input.
- At most 2 approach resets per task. A third would mean the task needs a human.
- Budget gate: when spend (tokens or wall time) passes 2x the estimate written before attempt 1,
  pause and ask the human before continuing.

## What never changes

Do not reduce the success criterion, skip a check, or loosen a check in order to make progress.
Narrowing the scope of the task is the human's decision, never the worker's.

## Worker report

A worker ends its report with two lines, so a stop is visible instead of improvised:

```text
STATUS: done | partial | blocked
NEEDS: none | decision: <question> | approval: <exact action>
```
