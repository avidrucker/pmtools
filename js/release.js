#!/usr/bin/env node
'use strict';
/*
 * release.js — abandon a claim + tear down its worktree WITHOUT closing the
 * issue (#22; "unclaim"). The cleanup half of close.js, minus land-on-main +
 * provider-close. Faithful twin of py/release.py; all pure decisions live in
 * ./close_core. Ported from lccjs scripts/release.js.
 *
 *   1. Delete the cross-clone claim ref (reuses close_core's refspec + classifier;
 *      best-effort + idempotent; --no-verify so a messy tree can't block its own
 *      cleanup — pmtools ships no hooks, but the flag keeps it portable).
 *   2. Remove the worktree + branch + prune (close.js's SYNCHRONOUS teardown —
 *      no npm getcwd footgun here). Reverts any uncommitted @inprogress flip free.
 *   3. Leave the issue OPEN — no commit, no push, no provider close.
 *   4. Data-loss guard FIRST: refuse if the branch has commits not on origin/main
 *      OR the worktree is dirty — unless --force — printing what would be lost.
 *
 * Usage:  pmtools release <issue> [--force]
 * Exit:   0 on success / nothing-to-do; 1 on bad args or a guard refusal.
 */

const { sh, shTrim, gitTrim, makeDie, makeLog } = require('./sh');
const { deleteClaimRef } = require('./claimref');
const {
  isSafeRef, parseWorktreePorcelain, findWorktreeForIssue, releaseGuardVerdict,
} = require('./close_core');

const log = makeLog('release');
const die = makeDie('release');

function parseArgs(argv) {
  const a = { issue: null, force: false };
  for (const t of argv) {
    if (t === '--force') a.force = true;
    else if (t === '--') continue;
    else if (/^\d+$/.test(t)) {
      if (a.issue !== null) die(`unexpected extra arg: ${t} (usage: release <N> [--force])`, 2);
      a.issue = t;
    } else die(`unknown arg: ${t} (usage: release <N> [--force])`, 2);
  }
  if (a.issue === null) die('usage: release <issue-number> [--force]', 2);
  return a;
}

function main() {
  const { issue, force } = parseArgs(process.argv.slice(2));
  const rows = parseWorktreePorcelain(shTrim('git worktree list --porcelain'));
  const root = rows.length ? rows[0].path : shTrim('git rev-parse --show-toplevel');
  const wt = findWorktreeForIssue(rows, issue);

  if (!wt) {
    // Orphan claim ref (no worktree — e.g. a dead session): free the ref so the
    // issue is re-claimable. Nothing to guard or tear down.
    deleteClaimRef(issue, { noVerify: true, log });
    log(`no worktree found for #${issue} — nothing to tear down.`);
    log(`#${issue} left as-is (OPEN unless already closed elsewhere).`);
    return;
  }
  const { path: wtPath, branch } = wt;
  // Injection guard (#37): the branch (parsed from `git worktree list`) is
  // interpolated into git rev-list / log / branch -D — refuse unsafe characters.
  if (branch && !isSafeRef(branch)) {
    die(`worktree branch "${branch}" contains unsafe characters — refusing to operate on it.`);
  }

  // --- data-loss guard FIRST — a refused release leaves the claim + worktree intact.
  if (!force) {
    sh('git fetch origin -q', true);
    const ahead = parseInt(gitTrim(['rev-list', '--count', `origin/main..${branch}`]), 10) || 0;
    const dirty = gitTrim(['-C', wtPath, 'status', '--porcelain']);
    const verdict = releaseGuardVerdict(ahead, !!dirty, false);
    if (verdict === 'unpushed') {
      die(`#${issue} branch ${branch} has ${ahead} commit(s) NOT on origin/main — release would discard them:\n`
        + gitTrim(['log', `origin/main..${branch}`, '--oneline'])
        + '\n  Land them on the right ticket first, or re-run with --force to discard.');
    }
    if (verdict === 'dirty') {
      die(`worktree ${wtPath} has uncommitted changes — release would discard them:\n`
        + dirty + '\n  Commit/stash what you want to keep, or re-run with --force to discard.');
    }
  }

  // --- claim ref (only now that the guard passed / --force) ---
  deleteClaimRef(issue, { noVerify: true, log });

  // --- teardown: synchronous from the main root (mirrors close.js; reverts any
  //     uncommitted @inprogress flip for free; leaves the issue OPEN). ---
  log(`releasing #${issue}: worktree ${wtPath} + branch ${branch} — issue stays OPEN.`);
  try { process.chdir(root); } catch (_) { /* best-effort */ }
  // arg-array exec (#37): the branch/path never reach a shell.
  gitTrim(['worktree', 'remove', '--force', wtPath]);
  if (branch) gitTrim(['branch', '-D', branch]);
  gitTrim(['worktree', 'prune']);
  if (gitTrim(['worktree', 'list', '--porcelain']).includes(wtPath)) {
    console.error('[release] warning: teardown may have failed — check: git worktree list');
  }
  log(`Shell re-root: cd "${root}"`);
}

if (require.main === module) main();

module.exports = { parseArgs };
