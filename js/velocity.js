#!/usr/bin/env node
// velocity.js — log a velocity row into the pmtools SQLite store (+ optional CSV mirror).
//
//   velocity log '<json>' [--db-path P] [--csv P | --no-csv]
//   velocity export        [--db-path P] [--csv P]
//
// A thin spec over the shared store-CLI runner (store_cli, #76) plus the two
// velocity-only hooks: a pre-validate title-autofetch (when title is omitted and a
// ticket is present, fetch it best-effort via the GitHub provider) and a
// post-validate model notice (a non-canonical model is NOTICED, not rejected). JS
// twin of py/velocity.py. Velocity is OPT-IN: the store is DISABLED by default.
//
// Exit codes: 0 success / disabled-store; 2 usage error; 1 operational (invalid
// JSON, validation failure, or DB error). See CONTRACT.md "Output conventions" (#44).
'use strict';

const core = require('./store_core');
const storeCli = require('./store_cli');
const { getProvider } = require('./provider');

// Best-effort title fetch via a host provider. null on any failure. `provider` is
// injectable (#46) so the seam is unit-testable with a canned/throwing stand-in
// instead of shelling out to `gh`; null → the real GitHub provider.
function fetchTitle(ticket, provider = null) {
  try {
    return (provider || getProvider('github')).issueTitle(ticket);
  } catch {
    return null;
  }
}

function preValidate(raw, note) {
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
}

function postValidate(raw, note) {
  const n = core.modelNotice(raw);
  if (n) note(n);
}

const SPEC = {
  name: 'velocity',
  table: 'velocity',
  cols: core.VELOCITY_COLS,
  cfgKey: 'velocity',
  validate: core.validateVelocityRow,
  logUsage: 'usage: velocity log \'{"role":"DEV","agent":"apple",...}\' '
    + '[--db-path P] [--csv P|--no-csv]',
  preValidate,
  postValidate,
  insertedMessage: (rid, row) => `Inserted velocity row id=${rid} (${row.ticket ? `ticket #${row.ticket}` : 'no ticket'})`,
};

function main(argv) {
  return storeCli.run(argv, SPEC);
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, fetchTitle };
