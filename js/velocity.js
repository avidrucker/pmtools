#!/usr/bin/env node
// velocity.js — log a velocity row into the pmtools SQLite store (+ optional CSV mirror).
//
//   velocity log '<json>' [--db-path P] [--csv P | --no-csv]
//   velocity export        [--db-path P] [--csv P]
//
// JS twin of py/velocity.py. Same shape as error.js, for the velocity store.
// Velocity is OPT-IN: the store is DISABLED by default, so `log` prints a notice
// + exits 0 unless the project's .claude/orchestrate.json enables
// storage.velocity. Required fields: role (closed vocabulary) + agent; ticket
// nullable. delta_h_min / delta_c_min are DERIVED (estimate - actual). A
// non-canonical model is NOTICED, not rejected. When title is omitted and a
// ticket is present, the title is fetched best-effort via the GitHub provider.
//
// Exit codes: 0 success / disabled-store; 1 missing arg, invalid JSON,
// validation failure, or DB error.
'use strict';

const config = require('./config');
const store = require('./store');
const core = require('./store_core');
const { getProvider } = require('./provider');

const TABLE = 'velocity';
const COLS = core.VELOCITY_COLS;

function die(msg) {
  process.stderr.write(`[velocity] ✗ ${msg}\n`);
  process.exit(1);
}

function note(msg) {
  process.stderr.write(`[velocity] note: ${msg}\n`);
}

// Best-effort title fetch via the GitHub provider. null on any failure.
function fetchTitle(ticket) {
  try {
    return getProvider('github').issueTitle(ticket);
  } catch {
    return null;
  }
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
  const storeCfg = cfg.velocity;
  if (!storeCfg.enabled) {
    console.log('velocity store disabled for this project');
    return 0;
  }

  if (!args.json) {
    die('usage: velocity log \'{"role":"DEV","agent":"apple",...}\' '
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

  // Auto-fetch the title when omitted and a ticket is present (best-effort).
  if ((raw.title === null || raw.title === undefined || raw.title === '')
      && raw.ticket !== null && raw.ticket !== undefined) {
    const fetched = fetchTitle(raw.ticket);
    if (fetched) {
      raw.title = fetched;
    } else {
      note(`could not fetch title for #${raw.ticket} via gh — using fallback`);
      raw.title = `#${raw.ticket} (title unavailable)`;
    }
  }

  let row;
  try {
    row = core.validateVelocityRow(raw);
  } catch (e) {
    die(e.message);
  }

  const n = core.modelNotice(raw);
  if (n) note(n);

  const dbPath = args.dbPath || cfg.dbPath;
  let rid;
  try {
    rid = store.insert(dbPath, TABLE, row);
  } catch (e) {
    die(`DB insert failed: ${e.message}`);
  }

  const ticketLabel = row.ticket ? `ticket #${row.ticket}` : 'no ticket';
  console.log(`Inserted velocity row id=${rid} (${ticketLabel})`);

  const csvPath = resolveCsv(args, storeCfg);
  if (csvPath) {
    const nrows = store.exportCsv(dbPath, TABLE, csvPath, COLS);
    console.log(`Exported ${nrows} rows -> ${csvPath}`);
  }
  return 0;
}

function cmdExport(args, cfg) {
  const storeCfg = cfg.velocity;
  if (!storeCfg.enabled) {
    console.log('velocity store disabled for this project');
    return 0;
  }
  const dbPath = args.dbPath || cfg.dbPath;
  const csvPath = args.csv || storeCfg.csvMirror;
  if (!csvPath) {
    die('no CSV target: pass --csv P or set storage.velocity.csvMirror');
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
  die(`usage: velocity <log|export> [...]  (got ${JSON.stringify(args.cmd)})`);
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { parseArgs, main, fetchTitle };
