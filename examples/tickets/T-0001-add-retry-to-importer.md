---
id: T-0001
title: Add retry with backoff to the CSV importer
workspace: backend
status: open
due: 2030-01-31
date: 2026-10-01
session: manual
checks: node --version ;; node -e "process.exit(0)"
changed_files: src/importer/*.js
---

**Where we left off:** the importer fails on the first transient network error. A retry wrapper
with exponential backoff is drafted in a branch but not wired in.

**What counts as done:** a failing fetch is retried up to 3 times; the unit test for the wrapper
passes. The `checks` above are placeholders: replace them with your real test command(s).
Separator between checks on one line is `;;` (a single `;` can be part of a command).

## Log
- 2026-10-01: ticket opened.
