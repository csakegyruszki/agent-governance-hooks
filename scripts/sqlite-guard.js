#!/usr/bin/env node
'use strict';
// SUPERSEDED by sql-cli-guard.js (covers psql, mysql, mariadb, duckdb, sqlite3, SQL files and
// always-true WHERE clauses). Kept as a thin wrapper that engages only for sqlite3, so existing
// installs that still reference this file keep working. New installs should use sql-cli-guard.js.
require('./sql-cli-guard.js').main('sqlite-guard', 'sqlite3');
