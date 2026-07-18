#!/usr/bin/env node
'use strict';
// pmtools sweep — delete stale claim refs whose issue is CLOSED (#71).
//
//   sweep.js [--dry-run] [--host github|gitlab]
//
// Lists `refs/claims/*` on origin, resolves each claimed issue's state via the
// host provider, and deletes ONLY the refs whose issue is CONFIRMED CLOSED
// (classifySweepTargets). OPEN / in-flight / unknown (offline) refs are NEVER
// touched — an active claim is a live worktree lock. The explicit, auditable
// alternative to hand-running `git push origin :refs/claims/issue-N`, which
// `claim` only ever nagged about. --dry-run reports what WOULD be swept.
//
// Exit 0 on success or nothing-to-do; a usage error (unknown flag/host) → 2; a
// host not yet implemented or a delete that left a ref behind → 1. Twin of
// py/sweep.py.
const { execFileSync } = require('node:child_process');
const { getProvider } = require('./provider');
const { parseClaimRefs, classifySweepTargets } = require('./claim_core');
const { deleteClaimRef } = require('./claimref');
const { makeDie, makeLog, wantsHelp } = require('./sh');

const die = makeDie('sweep');
const log = makeLog('sweep');

// The command's own usage line — printed on a bad invocation (exit 2) and on
// `--help` (exit 0, #117). Single source so the error and help paths never drift.
const USAGE = 'usage: sweep [--dry-run] [--host github|gitlab]';

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const opts = { dryRun: false, host: 'github' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--host') opts.host = argv[++i];
    else if (a.startsWith('--')) die(`unknown flag: ${a}\n${USAGE}`, 2);
    else die(`sweep takes no positional args (got '${a}')\n${USAGE}`, 2);
  }
  return opts;
}

function listClaims() {
  return parseClaimRefs(run('git', ['ls-remote', 'origin', 'refs/claims/*']));
}

function main(argv) {
  if (wantsHelp(argv)) { console.log(USAGE); return 0; } // #117 command-aware --help
  const opts = parseArgs(argv);
  if (opts.host !== 'github' && opts.host !== 'gitlab') {
    die(`unknown host '${opts.host}' (expected github or gitlab)`, 2);
  }
  let provider;
  try {
    provider = getProvider(opts.host);
  } catch {
    die(`unknown host '${opts.host}' (expected github or gitlab)`, 2);
  }

  const claimNumbers = listClaims();
  if (claimNumbers.length === 0) {
    log('no claim refs on origin — nothing to sweep.');
    return 0;
  }

  let states;
  try {
    states = provider.issueStates(claimNumbers);
  } catch {
    // The github provider is best-effort and never throws; only the gitlab stub
    // does ("not yet implemented"). Treat any provider throw as host-unsupported.
    die(`host '${opts.host}' not yet supported`, 1);
  }

  const targets = classifySweepTargets(claimNumbers, states);
  if (targets.length === 0) {
    log(`${claimNumbers.length} claim ref(s) on origin, none resolve to CLOSED — nothing to sweep.`);
    return 0;
  }

  const listed = targets.map((t) => `#${t}`).join(' ');
  if (opts.dryRun) {
    log(`WOULD SWEEP ${targets.length} closed-issue claim ref(s): ${listed}`);
    for (const t of targets) log(`  git push origin :refs/claims/issue-${t}`);
    return 0;
  }

  for (const t of targets) deleteClaimRef(t, { log });

  const remaining = new Set(listClaims());
  const failures = targets.filter((t) => remaining.has(t));
  if (failures.length) {
    die(`could not delete: ${failures.map((f) => `#${f}`).join(' ')} ` +
        '(still on origin — check permissions)', 1);
  }
  log(`SWEEP OK removed ${targets.length} claim ref(s): ${listed}`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { parseArgs };
