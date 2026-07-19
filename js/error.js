#!/usr/bin/env node
// error.js — log an error row into the pmtools SQLite store (+ optional CSV mirror).
//
//   error log '<json>' [--db-path P] [--csv P | --no-csv]
//   error export        [--db-path P] [--csv P]
//
// A thin spec over the shared store-CLI runner (store_cli, #76); see that module
// for the common parse → validate → insert → CSV-mirror flow. JS twin of
// py/error.py. When the errors store is DISABLED for the project, `log` prints a
// notice and exits 0.
//
// Exit codes: 0 success / disabled-store; 2 usage error; 1 operational (invalid
// JSON, validation failure, or DB error). See CONTRACT.md "Output conventions" (#44).
'use strict';

const core = require('./store_core');
const storeCli = require('./store_cli');

const SPEC = {
  name: 'error',
  table: 'errors',
  cols: core.ERROR_COLS,
  cfgKey: 'errors',
  validate: core.validateErrorRow,
  logUsage: 'usage: error log \'{"occurred_iso":"<ISO8601>","message":"..."}\' '
    + '[--db-path P] [--csv P|--no-csv]',
  insertedMessage: (rid, row) => `Inserted error row id=${rid}${row.ticket ? ` (ticket #${row.ticket})` : ''}`,
};

function main(argv) {
  return storeCli.run(argv, SPEC);
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };
