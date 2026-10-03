# Tickets with an evidence-gated "done"

A small ticket system whose one strong rule is: **a ticket cannot become `done` on a claim, only on
evidence.** `tools/tickets.py` runs the checks and writes an evidence file; the PreToolUse hook
`scripts/completion-gate.js` refuses to let `status: done` be written without a fresh, passing one.

## Security: tickets are trusted input

`tickets.py --verify` executes the shell commands listed in a ticket's `checks` field. Treat ticket
files exactly like a `Makefile` or a CI config: **never run `--verify` on a ticket from an untrusted
source** (a downloaded repo, a pasted file, another person's branch you have not read). The gate hook
itself never runs anything; it only reads the evidence file.

## A ticket

One ticket = one Markdown file named `T-NNNN-slug.md` in a `tickets/` directory, with frontmatter:

| field | meaning |
|---|---|
| `id` | `T-0001` style, unique |
| `title` | one line |
| `status` | `candidate` (proposed, awaiting approval) -> `open` -> `done` or `dropped` |
| `date` | created, `YYYY-MM-DD` |
| `due` | `YYYY-MM-DD` or `null` |
| `workspace` | free label; restrict it with `GUARDRAIL_TICKET_WORKSPACES="a,b,c"` |
| `session` | optional, e.g. a session id you can resume from |
| `checks` | commands that prove it is done (see below), or `none - <reason>` |
| `changed_files` | optional comma-separated globs (relative to the project root); evidence older than the newest match is rejected |
| `reservation_id` | optional, written when you reserve the ID with `--reserve` |

The body should say **where we left off** and **what counts as done**. See `examples/tickets/`.

### `checks`

- One line: `checks: npm test ;; node scripts/lint.js` - the separator is `;;`, not `;`, because a
  single `;` can be part of a command (`python -c "import sys; sys.exit(3)"`).
- A YAML block, one command per line:
  ```
  checks: |
    npm test
    node scripts/lint.js
  ```
  A newline inside an open double quote continues the same command.
- `checks: none - <reason>` is a conscious, visible exemption and is accepted only **with** a reason.
  A bare `none` is rejected.

Commands run with the project root as working directory, through the system shell, with a 10 minute
timeout per command (the whole process tree is killed on timeout).

## `tools/tickets.py`

Python 3.9+, standard library only.

```
python tools/tickets.py                  # --list: overdue, due soon, open, candidates, closed
python tools/tickets.py --due 5          # open tickets due within 5 days (default 3)
python tools/tickets.py --check          # frontmatter integrity; exit 1 on a BLOCKER
python tools/tickets.py --reserve        # atomically reserve the next ID, prints JSON
python tools/tickets.py --verify T-0001  # run the checks, write tickets/evidence/T-0001.json
```

In the list, `+` marks an open ticket that is proven (could be closed now) and `!` one whose evidence
is missing, stale or failing.

**Evidence file** `tickets/evidence/T-XXXX.json`: for every check the command, exit code, duration,
and the SHA-256 of its output (plus a bounded, redacted `output_tail`), plus a UTC `verified_at`. **Locations:** tickets dir = `--tickets-dir`,
else `GUARDRAIL_TICKETS_DIR`, else `<root>/tickets`; root = `--root`, else the parent of the tickets dir,
else the current directory.

**Reserving IDs.** `max(id)+1` is a race: two sessions see the same maximum. `--reserve` creates
`tickets/.ids/T-NNNN.id` with exclusive-create, so exactly one caller gets each number; reserved but
unwritten IDs stay taken. Write the returned `reservation_id` into the ticket and `--check` will flag a
mismatch. A ticket with no marker is only a warning (it was probably written by hand).

## `scripts/completion-gate.js`

PreToolUse on `Write|Edit|MultiEdit`. It acts on files named `T-NNNN*.md` that sit in a directory called
`tickets` (or, if `GUARDRAIL_TICKETS_DIR` is set, only in that directory) and only when the edit would
make the ticket `status: done`. The verdict is **allow** if:

1. the ticket is already `done` on disk (not a transition), or
2. `checks: none - <reason>` is present, or
3. evidence exists, is less than 24 h old, every check passed, it covers every command currently in
   `checks`, and (if `changed_files` is set) it is newer than those files, or
4. the escape hatch is used.

Otherwise it denies with the reason (no evidence, stale, failed, a check was added after the run...).
The gate judges the file **as it will be after the edit** (it applies each `old_string`->`new_string`, honouring
`replace_all`, for `Edit` and `MultiEdit`; for `Write` it uses the new content), reading `status` from the
frontmatter only: `status:done`, quotes, any case, indentation and block scalars (`status: >-` then `done`) all
count, a `status: done` line in the body does not. A call of any kind that changes `checks:` or
`changed_files:` and sets `done` in the same step is denied: change them first, `--verify`, then close in a
separate edit. The evidence must also belong to the ticket (its `ticket` field must equal the ID), or it is
rejected.

**Evidence files are not writable by the agent's tools.** Write/Edit/MultiEdit of anything under
`tickets/evidence/` is denied; the escape hatch does not apply there. Only `tools/tickets.py --verify` writes
them.

**Escape hatch.** Put `guardrail:confirmed reason="<at least 8 characters>"` inside the ticket text. The
gate lets the edit through, appends a `bypass` event to the audit log (`GUARDRAIL_AUDIT_LOG`, default
`~/.agent-governance-hooks/audit.jsonl`), and refuses the bypass if that record cannot be written. The marker
stays in the ticket, so a forced close is visible to anyone reading it later. A marker without a reason
is ignored.

**Python.** The gate calls `GUARDRAIL_PYTHON` if set, else `python3`, then `python`, from `PATH`. If none
works, it **fails open** and logs a `no-verdict` audit event; with `GUARDRAIL_FAIL_CLOSED=1` it denies.

**Wiring.** `hooks/hooks.json` already wires `completion-gate` when you use this repo as a plugin. Only if
you maintain your own hook configuration, add:

```json
{ "matcher": "Write|Edit|MultiEdit",
  "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/completion-gate.js" }] }
```

## Limits

- The gate only sees edits made through the Write/Edit/MultiEdit tools. A shell command that rewrites a
  ticket (`sed -i`) is not covered.
- A shell command can still write `tickets/evidence/T-XXXX.json` (or edit a ticket): the gate sees only
  Write/Edit/MultiEdit, not Bash. Evidence is therefore not tamper-proof; there is no signature. The
  `ticket` binding, the 24 h freshness and the coverage of the current `checks:` limit accidents, not a
  determined actor with shell access. Review the evidence file when it matters.
- Evidence proves the commands exited 0 at a point in time; it is only as good as the commands.
- `output_tail` in the evidence is bounded (last 20 lines, 2000 characters) and token-looking values
  (`sk-`, `ghp_`, `github_pat_`, `AKIA...`, `xox?-`, 32+ character hex/base64 strings, `password=`/`token=`
  values) are replaced with `[redacted]`. This is best effort: do not print secrets from a check.
- `changed_files` compares file modification times, not contents.

## Tests

```
node --test tests/completion-gate.test.js
python -m unittest tests/test_tickets.py
```

The example checks use `node`; replace them with your own commands.
