#!/usr/bin/env node
// store_cli.js — the shared error/velocity store-CLI runner (#76, cont. of #74).
//
// error.js and velocity.js are ~80% identical: parse the shared store args, load
// the storage config, dispatch `log`/`export`, then validate → insert → CSV-mirror.
// This module owns that common flow; each wrapper supplies a small `spec` and the
// store-specific bits (validate fn, usage string, inserted-row message, and the
// optional pre/post-validate hooks velocity needs for title-autofetch + model
// notice). Twin of py/store_cli.py.
//
// Exit codes (unchanged, #44): 0 success / disabled-store; 2 usage error; 1
// operational (invalid JSON, validation failure, DB error).
'use strict';

const path = require('node:path');
const config = require('./config');
const store = require('./store');
const core = require('./store_core');
const { makeDie, wantsHelp } = require('./sh');

function repoBasename(cwd = null) {
  // The `repo` data column labels the PROJECT; from a worktree that is still the
  // main repo, so key off mainRepoRoot (#26), not the worktree toplevel.
  const root = config.mainRepoRoot(cwd);
  return root ? path.basename(root) : 'repo';
}

// Run one store-CLI invocation against `spec`. Keys: name, table, cols, cfgKey,
// validate, logUsage, insertedMessage(rid, row); optional preValidate(raw, note,
// die) and postValidate(raw, note).
function run(argv, spec) {
  const die = makeDie(spec.name);
  const note = (msg) => process.stderr.write(`[${spec.name}] note: ${msg}\n`);

  // #117 command-aware --help: print this store command's own usage, exit 0.
  if (wantsHelp(argv)) { console.log(spec.logUsage); return 0; }

  let args;
  try { args = core.parseStoreArgs(argv); }
  catch (e) { return die(e.message, 2); }

  const cfg = config.loadStorageConfig();
  const storeCfg = cfg[spec.cfgKey];
  if (args.cmd === 'log') return cmdLog(args, cfg, storeCfg, spec, die, note);
  if (args.cmd === 'export') return cmdExport(args, cfg, storeCfg, spec, die);
  die(`usage: ${spec.name} <log|export> [...]  (got ${JSON.stringify(args.cmd)})`, 2);
  return 1;
}

function cmdLog(args, cfg, storeCfg, spec, die, note) {
  if (!storeCfg.enabled) {
    console.log(`${spec.cfgKey} store disabled for this project`);
    return 0;
  }

  if (!args.json) { die(spec.logUsage, 2); }
  let raw;
  try {
    raw = JSON.parse(args.json);
  } catch (e) {
    die(`invalid JSON: ${e.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    die('payload must be a JSON object');
  }

  if (spec.preValidate) spec.preValidate(raw, note, die);

  // repo defaults to the git repo basename when not supplied (lccjs parity).
  if (!raw.repo) raw.repo = repoBasename();

  let row;
  try {
    row = spec.validate(raw);
  } catch (e) {
    die(e.message);
  }

  if (spec.postValidate) spec.postValidate(raw, note);

  const dbPath = args.dbPath || cfg.dbPath;
  let rid;
  try {
    rid = store.insert(dbPath, spec.table, row);
  } catch (e) {
    die(`DB insert failed: ${e.message}`);
  }

  console.log(spec.insertedMessage(rid, row));

  const csvPath = core.resolveCsv(args, storeCfg);
  if (csvPath) {
    const nrows = store.exportCsv(dbPath, spec.table, csvPath, spec.cols);
    console.log(`Exported ${nrows} rows -> ${csvPath}`);
  }
  return 0;
}

function cmdExport(args, cfg, storeCfg, spec, die) {
  if (!storeCfg.enabled) {
    console.log(`${spec.cfgKey} store disabled for this project`);
    return 0;
  }
  const dbPath = args.dbPath || cfg.dbPath;
  const csvPath = args.csv || storeCfg.csvMirror;
  if (!csvPath) {
    die(`no CSV target: pass --csv P or set storage.${spec.cfgKey}.csvMirror`);
  }
  const nrows = store.exportCsv(dbPath, spec.table, csvPath, spec.cols);
  console.log(`Exported ${nrows} rows -> ${csvPath}`);
  return 0;
}

module.exports = { run, repoBasename };
