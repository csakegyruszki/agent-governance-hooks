# Delegation routing (opt-in guidance, not enforcement)

Nothing in this file is enforced by a hook. Copy the parts you want into your own `CLAUDE.md`
or rules. The only related mechanism shipped here is `no-nested-agent`, which blocks
subagent-spawned subagents.

## Roles

The main context orchestrates: it decomposes work, judges across workstreams and writes the
final synthesis. A work package that can be detached is delegated when doing so frees the main
context for substantive work, or when the package is tool-heavy or parallelizable.

## Worker tiers

- **Small/fast model** - only simple, bounded work whose correctness can be checked strongly,
  ideally deterministically (a test, a schema, an exact comparison). Not the primary worker for
  published prose or for judgment that is hard to verify.
- **Mid-tier model** - the default delegated worker: long, tool-heavy research, implementation,
  review, inventory and well-specified execution.
- **Top-tier subagent** - complex or high-stakes packages that can still be isolated: adversarial
  judgment, resolving competing evidence, work where the mid tier is not reliable enough.
  "Complicated" alone is not a reason to keep the work in the main context.

## Specialist or general-purpose

If a registered specialist agent's declared scope matches the package, prefer it. But a
specialist's model is fixed in its definition, so the choice is not independent of the tier:

1. decide the tier the package needs
2. look for a specialist
3. if one exists and its fixed tier is acceptable, use it
4. otherwise use a general-purpose agent on the tier you need, with the model set explicitly

Example: the package needs the top tier but the reviewer agent is pinned to the mid tier ->
general-purpose on the top tier.

## Lifecycle

- continuation of the same workstream: resume the existing agent if possible
- new, independent package: start a new agent
- genuinely independent packages: start them in parallel

Do not spawn a fresh agent for what is a natural continuation of an existing agent's context.

## Brief precision

Every delegation brief should contain:

1. **Scope by name**: a concrete file, path, command or identifier, not "check the rules".
2. **A size limit**: "max 5 lines", "JSON in this schema", "one number".
3. **What not to do**: "do not fix, only measure".
4. **For measurements**: "whatever you could not measure, mark NOT MEASURED and say why;
   do not guess".

Why: a broad brief makes the worker explore widely, and the cost is mostly in that exploration,
not in the fixed spawn overhead.

## Do not

- delegate verification to whoever did the work; a worker's "done" is a claim, not evidence
- run several expensive subagents in parallel on the same scarce resource
- save on the model where judgment is the product
- let a subagent start subagents (see the `no-nested-agent` hook)

## Report format

A subagent usually cannot ask the user anything. When it hits a wall it should stop rather than
improvise. Ask workers that can touch files, the network or anything irreversible to end their
report with these two lines (same format as in [escalation.md](escalation.md)):

```text
STATUS: done | partial | blocked
NEEDS: none | decision: <question> | approval: <exact action>
```

For small mechanical workers: any judgment call means stop and ask, never guess. A blocked worker
that quietly works around a guard defeats the guard; the lines make the block visible.
