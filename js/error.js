#!/usr/bin/env node
// error.js — log an error row into the pmtools SQLite store (+ optional CSV mirror).
//
//   error log '<json>' [--db-path P] [--csv P | --no-csv]
//   error export        [--db-path P] [--csv P]
//
// JS twin of py/error.py. SQLite is the source of truth; the CSV mirror is a
// derived full-table dump regenerated after each write (or on demand via
// `export`). Config comes from the project's .claude/orchestrate.json `storage`
// block (see config.js). When the errors store is DISABLED for the project,
// `log` prints a notice and exits 0 (a disabled store is not an error).
//
// Exit codes: 0 success / disabled-store; 2 usage error (missing/unknown
// subcommand, unknown flag, missing payload arg); 1 operational (invalid JSON,
// validation failure, or DB error). See CONTRACT.md "Output conventions" (#44).
'use strict';

const path = require('node:path');

const config = require('./config');
const store = require('./store');
const core = require('./store_core');
const { makeDie } = require('./sh');

const TABLE = 'errors';
const COLS = core.ERROR_COLS;

const die = makeDie('error');

function repoBasename(cwd = null) {
  // The `repo` data column labels the PROJECT; from a worktree that is still the
  // main repo, so key off mainRepoRoot (#26), not the worktree toplevel.
  const root = config.mainRepoRoot(cwd);
  return root ? path.basename(root) : 'repo';
}

// Thin impure wrapper over the shared pure parser (store_core, #46): an unknown
// flag throws there; here we turn it into a usage die (exit 2).
function parseArgs(argv) {
  try { return core.parseStoreArgs(argv); }
  catch (e) { return die(e.message, 2); }
}

function cmdLog(args, cfg) {
  const storeCfg = cfg.errors;
  if (!storeCfg.enabled) {
    console.log('errors store disabled for this project');
    return 0;
  }

  if (!args.json) {
    die('usage: error log \'{"occurred_iso":"<ISO8601>","message":"..."}\' '
      + '[--db-path P] [--csv P|--no-csv]', 2);
  }
  let raw;
  try {
    raw = JSON.parse(args.json);
  } catch (e) {
    die(`invalid JSON: ${e.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    die('payload must be a JSON object');
  }

  // repo defaults to the git repo basename when not supplied (lccjs parity).
  if (!raw.repo) raw.repo = repoBasename();

  let row;
  try {
    row = core.validateErrorRow(raw);
  } catch (e) {
    die(e.message);
  }

  const dbPath = args.dbPath || cfg.dbPath;
  let rid;
  try {
    rid = store.insert(dbPath, TABLE, row);
  } catch (e) {
    die(`DB insert failed: ${e.message}`);
  }

  const ticketLabel = row.ticket ? ` (ticket #${row.ticket})` : '';
  console.log(`Inserted error row id=${rid}${ticketLabel}`);

  const csvPath = core.resolveCsv(args, storeCfg);
  if (csvPath) {
    const nrows = store.exportCsv(dbPath, TABLE, csvPath, COLS);
    console.log(`Exported ${nrows} rows -> ${csvPath}`);
  }
  return 0;
}

function cmdExport(args, cfg) {
  const storeCfg = cfg.errors;
  if (!storeCfg.enabled) {
    console.log('errors store disabled for this project');
    return 0;
  }
  const dbPath = args.dbPath || cfg.dbPath;
  const csvPath = args.csv || storeCfg.csvMirror;
  if (!csvPath) {
    die('no CSV target: pass --csv P or set storage.errors.csvMirror');
  }
  const nrows = store.exportCsv(dbPath, TABLE, csvPath, COLS);
  console.log(`Exported ${nrows} rows -> ${csvPath}`);
  return 0;
}

function main(argv) {
  const args = parseArgs(argv);
  const cfg = config.loadStorageConfig();
  if (args.cmd === 'log') return cmdLog(args, cfg);
  if (args.cmd === 'export') return cmdExport(args, cfg);
  die(`usage: error <log|export> [...]  (got ${JSON.stringify(args.cmd)})`, 2);
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { parseArgs, main };
