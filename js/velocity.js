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
// Exit codes: 0 success / disabled-store; 2 usage error (missing/unknown
// subcommand, unknown flag, missing payload arg); 1 operational (invalid JSON,
// validation failure, or DB error). See CONTRACT.md "Output conventions" (#44).
'use strict';

const path = require('node:path');
const config = require('./config');
const store = require('./store');
const core = require('./store_core');
const { getProvider } = require('./provider');
const { makeDie } = require('./sh');

const TABLE = 'velocity';
const COLS = core.VELOCITY_COLS;

const die = makeDie('velocity');

function note(msg) {
  process.stderr.write(`[velocity] note: ${msg}\n`);
}

// Best-effort title fetch via a host provider. null on any failure. `provider`
// is injectable (#46) so the seam is unit-testable with a canned/throwing
// stand-in instead of shelling out to `gh`; null → the real GitHub provider.
function fetchTitle(ticket, provider = null) {
  try {
    return (provider || getProvider('github')).issueTitle(ticket);
  } catch {
    return null;
  }
}

// Thin impure wrapper over the shared pure parser (store_core, #46): an unknown
// flag throws there; here we turn it into a usage die (exit 2).
function parseArgs(argv) {
  try { return core.parseStoreArgs(argv); }
  catch (e) { return die(e.message, 2); }
}

function repoBasename(cwd = null) {
  // The `repo` data column labels the PROJECT; from a worktree that is still the
  // main repo, so key off mainRepoRoot (#26), not the worktree toplevel.
  const root = config.mainRepoRoot(cwd);
  return root ? path.basename(root) : 'repo';
}

function cmdLog(args, cfg) {
  const storeCfg = cfg.velocity;
  if (!storeCfg.enabled) {
    console.log('velocity store disabled for this project');
    return 0;
  }

  if (!args.json) {
    die('usage: velocity log \'{"role":"DEV","agent":"apple",...}\' '
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

  // repo defaults to the git repo basename when not supplied (lccjs parity, #61).
  if (!raw.repo) raw.repo = repoBasename();

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

  const csvPath = core.resolveCsv(args, storeCfg);
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
  die(`usage: velocity <log|export> [...]  (got ${JSON.stringify(args.cmd)})`, 2);
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { parseArgs, main, fetchTitle };
