# Where an instruction belongs

A guide for deciding where a persistent instruction goes before you add it to `CLAUDE.md` or a rule.
It pairs with [instruction-budget-lint](instruction-budget-lint.md), which warns when the always-loaded
layer grows.

## The one question

> **Does this need to be known BEFORE opening the detailed file?**

- **No**: it goes in the detailed file.
- **Yes**: it may stay in an always-loaded layer, but only the minimum:

```text
trigger (when)  ·  pointer (what to read)  ·  hard limit (what NOT to do)
```

Lists, enums, command examples, tables, prices, rationale and history go to the target file. A version
or hash pin stays: it is needed before the file is opened.

Why this matters: an always-loaded character is paid in every session, whether or not the topic comes
up. Path-scoped rules, docs, runbooks and skills cost nothing until they are needed.

## Placement taxonomy

Every atomic piece of content gets exactly one label. A large section can be split into several atoms
(summary of capabilities to an inventory, a procedure to a skill, exact syntax to a skill reference).

| Label | Use for | Typical location |
|---|---|---|
| `ALWAYS_LOADED` | needed before almost any decision | `CLAUDE.md`, rules without `paths:` |
| `PATH_SCOPED` | only relevant for certain files | `.claude/rules/**/*.md` with `paths:` frontmatter |
| `SKILL` | a reusable procedure | `skills/<name>/SKILL.md` |
| `SKILL_REFERENCE` | exact syntax, long gotchas for one skill | `skills/<name>/references/` |
| `INVENTORY` | capability registry: what exists, what it is for, how to reach it | `docs/capabilities.md` |
| `ON_DEMAND_DOC` | long reference that is not a procedure | `docs/...` |
| `RUNBOOK` | long methodology, read when triggered | `runbooks/<name>.md` |
| `HOOK_OR_SCRIPT` | deterministic enforcement | `hooks/`, `scripts/` |
| `HISTORICAL` | provenance; never rewrite | `archive/` or similar |
| `DELETE_OBSOLETE` | no longer true | nowhere |

If a placement is not clear, mark it unknown and decide; do not invent a location. A `SKILL_REFERENCE`
without a parent skill is not allowed: if no skill exists and none is justified, use `ON_DEMAND_DOC`.

Directory names do not decide loading. A rule under `.claude/rules/team/` with no `paths:` frontmatter is
global just like one under `.claude/rules/global/`.

## Path-scoped rules are a weak delivery channel

A path-scoped rule is loaded when Claude **reads** a matching file. Edits made through a shell script
(a `Bash` call rewriting a file) fire no read event, so the rule may never load. If a rule must take
effect every time, use a **hook** (deterministic) or a skill plus a hook, not only a path-scoped rule.

## Shape rules

| Instead of | Write |
|---|---|
| paragraphs of prose | a table, a `code block`, a one-line key-value |
| "it is important to note that..." | the statement itself |
| the same thing in three sections | once, plus a pointer |
| the story of how you found out | in the target file; here at most half a sentence |

**Keep a one-line why.** A rule without a reason becomes uninterpretable later, and therefore
undeletable, which is how the layer accumulates. One line is enough: `trigger -> action -> why`.

Admission test for a new always-loaded line (all must hold):

1. Claude cannot easily infer it (not from `ls`, not from file names)
2. it matters across several task types
3. it prevents a concrete failure
4. it is not an enforcement problem (else: hook)
5. it is not a procedure (else: skill)
6. it is not file-local (else: path-scoped rule)
7. it is not already stated elsewhere
8. you know what would justify deleting it later

What not to put in the always-loaded layer: directory trees that `ls` answers in a second, model names
and prices, provider recipes, command examples, benchmark data, incident stories. What stays: the
non-derivable convention, e.g. "`<work-state-dir>/` is the authoritative work state" or "`archive/` is
historical evidence, do not rewrite it".

`@import` is not progressive disclosure: an imported file is loaded at startup like the importing one.
It helps organise files, not cost.

## Deleting or moving: copy before delete

```text
1. COPY                     to the destination layer; the source stays untouched
2. DESTINATION-LAYER CHECK  is the taxonomy placement actually right?
3. SEMANTIC EQUIVALENCE     are the normative meaning AND the trigger preserved?
                            (the destination merely existing, or containing something similar, is not enough)
4. LIVE-REFERENCE REWRITE   every live reference points at the new place
-> only then delete the source
```

Prove that something is superseded, do not assume it: `grep` for references. If you cannot prove it, it
stays. Keep a backup before large edits.

## Claims in instruction files

Put a measurement date or a locator (file:line, command, output) next to every factual claim, and a
number only if you measured it. Counts go stale; point at the generated source instead. Units are part
of the measurement: bytes, characters and tokens differ; UTF-16 code units differ from code points;
`CRLF` differs from `LF`.

## Before you add something

```text
node scripts/instruction-budget-baseline.js     # how large is the always-loaded set now?
```
