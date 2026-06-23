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
// Exit codes: 0 success / disabled-store; 1 missing arg, invalid JSON,
// validation failure, or DB error.
'use strict';

const path = require('node:path');

const config = require('./config');
const store = require('./store');
const core = require('./store_core');

const TABLE = 'errors';
const COLS = core.ERROR_COLS;

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function repoBasename(cwd = null) {
  const root = config.repoRoot(cwd);
  return root ? path.basename(root) : 'repo';
}

function parseArgs(argv) {
  const a = { cmd: null, json: null, dbPath: null, csv: null, noCsv: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--db-path') { a.dbPath = (i + 1 < argv.length) ? argv[++i] : null; }
    else if (t === '--csv') { a.csv = (i + 1 < argv.length) ? argv[++i] : null; }
    else if (t === '--no-csv') { a.noCsv = true; }
    else if (t.startsWith('--')) { die('unknown flag: ' + t); }
    else { positionals.push(t); }
  }
  a.cmd = positionals.length ? positionals[0] : null;
  a.json = positionals.length > 1 ? positionals[1] : null;
  return a;
}

function resolveCsv(args, storeCfg) {
  if (args.noCsv) return null;
  if (args.csv) return args.csv;
  return storeCfg.csvMirror;
}

function cmdLog(args, cfg) {
  const storeCfg = cfg.errors;
  if (!storeCfg.enabled) {
    console.log('errors store disabled for this project');
    return 0;
  }

  if (!args.json) {
    die('usage: error log \'{"occurred_iso":"<ISO8601>","message":"..."}\' '
      + '[--db-path P] [--csv P|--no-csv]');
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

  const csvPath = resolveCsv(args, storeCfg);
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
  die(`usage: error <log|export> [...]  (got ${JSON.stringify(args.cmd)})`);
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { parseArgs, main };
