#!/usr/bin/env node
'use strict';
/*
 * close.js — finish a puzzle safely: land the close commit on origin/main, then
 * (and ONLY then) tear down the worktree. The symmetric mirror of claim.js.
 *
 * Ported from lccjs scripts/close.js (the GENERIC core of the IMPURE
 * orchestration). All pure decisions live in ./close_core; this file does only
 * git/gh I/O and wiring, and is a faithful twin of py/close.py.
 *
 * Boundary: this tool does NOT author the closing commit. The agent commits the
 * marker deletion + `Closes #N` FIRST; close.js owns only the racy push + the
 * gated teardown.
 *
 * OMITTED from the lccjs original (lccjs-specific, out of scope): the velocity
 * CSV/SQLite guards, the learnings-README conflict resolver, union-file
 * auto-resolve, and the parent-tracker scan. Any rebase conflict is blocking.
 *
 * Usage (after committing `Closes #N`):
 *   node close.js <issue>                    # from inside the worktree
 *   node close.js <issue> --branch <name>    # from the main checkout
 *   node close.js <issue> --max 8            # more push-race retries (default 5)
 *   node close.js <issue> --dry-run          # show the plan, change nothing
 *   node close.js <issue> --keep             # land but DON'T tear down
 *   node close.js <issue> --no-verify-issue  # skip the gh post-close check
 *   node close.js <issue> --skip-marker-check / --skip-keyword-check / --skip-scope-audit
 *   node close.js <issue> --worktree-dir <dir>   # default .claude/worktrees
 */

const { execSync } = require('node:child_process');
const path = require('node:path');

const core = require('./close_core');
const {
  DEFAULT_MAX_RETRIES, classifyPushError, shouldCleanup,
  claimRefDeleteCommand, classifyClaimRefDelete,
  bodyClosesIssue, extractKeywords, keywordsOverlap, markerStillPresent,
  scopeAuditDiffCommand,
} = core;

function sh(cmd, allowFail = false) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

// Like sh() but always returns { ok, out } with stdout+stderr merged, never throws.
function shCapture(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out || '' };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    return { ok: false, out };
  }
}

function die(msg) {
  console.error(`[close] ✗ ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[close] ${msg}`);
}

// The MAIN checkout's root, NOT the worktree we're closing — the worktree is
// about to be removed, so the removal must run from a directory that survives.
function mainRoot() {
  let dir = sh('git rev-parse --path-format=absolute --git-common-dir', true);
  if (!dir) {
    const rel = sh('git rev-parse --git-common-dir', true); // older git fallback
    if (!rel) die('not inside a git repository.');
    dir = path.resolve(process.cwd(), rel.trim());
  }
  return path.dirname(dir.trim());
}

function parseArgs(argv) {
  const opts = {
    issue: null, max: DEFAULT_MAX_RETRIES, dryRun: false,
    keep: false, verifyIssue: true, skipKeywordCheck: false,
    skipMarkerCheck: false, skipScopeAudit: false,
    branch: null, worktreeDir: '.claude/worktrees',
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max') opts.max = parseInt(argv[++i], 10);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--no-verify-issue') opts.verifyIssue = false;
    else if (a === '--skip-keyword-check') opts.skipKeywordCheck = true;
    else if (a === '--skip-marker-check') opts.skipMarkerCheck = true;
    else if (a === '--skip-scope-audit') opts.skipScopeAudit = true;
    else if (a === '--branch') opts.branch = argv[++i];
    else if (a === '--worktree-dir') opts.worktreeDir = argv[++i];
    else if (a.startsWith('--')) die(`unknown flag: ${a}`);
    else positionals.push(a);
  }
  opts.issue = positionals[0];
  if (!Number.isInteger(opts.max) || opts.max < 1) opts.max = DEFAULT_MAX_RETRIES;
  return opts;
}

// ---- git I/O helpers (thin wrappers; close_core stays pure) ----------------

function currentBranch() {
  const b = sh('git rev-parse --abbrev-ref HEAD', true);
  return b ? b.trim() : null;
}

function headSha() {
  const s = sh('git rev-parse HEAD', true);
  return s ? s.trim() : null;
}

function findClosingCommitSha(issue) {
  const out = sh('git log origin/main..HEAD --format=%H', true) || '';
  const shas = out.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  for (const sha of shas) {
    const body = sh(`git show -s --format=%B ${sha}`, true) || '';
    if (bodyClosesIssue(body, issue)) return sha;
  }
  return null;
}

function findClosingCommitOnMain(issue) {
  const out = sh('git log origin/main -100 --format=%H', true) || '';
  const shas = out.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  for (const sha of shas) {
    const body = sh(`git show -s --format=%B ${sha}`, true) || '';
    if (bodyClosesIssue(body, issue)) return sha;
  }
  return null;
}

function treeIsClean() {
  const s = sh('git status --porcelain', true);
  return s !== null && s.trim() === '';
}

function rebaseOrMergeInProgress() {
  const rm = sh('git rev-parse --git-path rebase-merge', true);
  const ra = sh('git rev-parse --git-path rebase-apply', true);
  const mh = sh('git rev-parse --git-path MERGE_HEAD', true);
  const exists = (p) => p && sh(`test -e "${p.trim()}" && echo yes`, true);
  return !!(exists(rm) || exists(ra) || exists(mh));
}

function conflictedPaths() {
  const s = sh('git diff --name-only --diff-filter=U', true) || '';
  return s.split('\n').map((x) => x.trim()).filter(Boolean);
}

function onOriginMain(sha) {
  const out = sh(`git branch -r --contains ${sha}`, true) || '';
  return out.split('\n').some((l) => l.trim() === 'origin/main');
}

// ---- guards (skippable) ----------------------------------------------------

function checkKeywordMatch(issue, closingCommitSha) {
  const title = sh(`gh issue view ${issue} --json title -q .title`, true);
  if (!title || !title.trim()) {
    log('warn: could not fetch issue title (gh unavailable?) — skipping keyword check.');
    return;
  }
  const sha = closingCommitSha || 'HEAD';
  const subject = sh(`git show -s --format=%s ${sha}`, true) || '';
  const titleKws = extractKeywords(title.trim());
  if (titleKws.length === 0) {
    log('warn: issue title has no extractable keywords — skipping keyword check.');
    return;
  }
  if (keywordsOverlap(titleKws, extractKeywords(subject.trim()))) return;
  const allSubjectsOut = sh('git log origin/main..HEAD --format=%s', true) || '';
  const allSubjects = allSubjectsOut.trim().split('\n').filter(Boolean);
  if (allSubjects.some((s) => keywordsOverlap(titleKws, extractKeywords(s)))) return;
  const allSubjectKws = [...new Set(allSubjects.flatMap((s) => extractKeywords(s)))].sort();
  die(`keyword check: no keyword from issue #${issue} title matched any unpushed commit subject.\n` +
      `  title:            "${title.trim()}"\n` +
      `  title keywords:   [${titleKws.join(', ')}]\n` +
      `  subjects scanned: ${allSubjects.length}\n` +
      `  subject keywords: [${allSubjectKws.join(', ')}]\n` +
      `  Paraphrased title? Add --skip-keyword-check to your close command.`);
}

function checkMarkerDeleted(issue) {
  // LANGUAGE-AGNOSTIC: search ALL tracked files, not just *.js/*.ts/*.mjs. Split
  // marker keywords so a PDD scanner doesn't treat these grep patterns as markers.
  const tPat = '@' + `todo #${issue}`;
  const iPat = '@' + `inprogress #${issue}`;
  const result = shCapture(`git grep -rn -e "${tPat}" -e "${iPat}"`);
  const { found, lines } = markerStillPresent(issue, result.out);
  if (found) {
    die(`puzzle marker for #${issue} still present — delete it in the closing commit first.\n` +
        lines.map((l) => `  Found: ${l}`).join('\n') + '\n' +
        '  Pass --skip-marker-check to bypass (no source marker ever existed).');
  }
}

function deleteClaimRef(issue) {
  const out = sh(`${claimRefDeleteCommand(issue)} 2>&1 || true`, true) || '';
  const verdict = classifyClaimRefDelete(out);
  if (verdict === 'DELETED') log(`claim ref refs/claims/issue-${issue} deleted.`);
  else if (verdict === 'ABSENT') log(`claim ref refs/claims/issue-${issue} already absent — no-op.`);
  else log(`warn: could not delete claim ref refs/claims/issue-${issue} (best-effort; close continues).`);
}

// ---- land loop -------------------------------------------------------------

// One fetch/rebase/push round. Returns 'ok' | 'race' | 'rejected-other', or
// die()s on a blocking rebase conflict (not retryable).
function tryLand() {
  sh('git fetch origin main', true);
  const rebase = shCapture('git rebase origin/main');
  if (!rebase.ok) {
    const conflicted = conflictedPaths();
    // velocity/learnings auto-resolve is OUT of scope — any conflict is blocking.
    sh('git rebase --abort', true);
    die('rebase hit a real conflict in: ' +
        `${conflicted.join(', ') || rebase.out.trim()}. ` +
        'Aborted the rebase. Resolve manually, then re-run close. ' +
        'Your commit is safe and local.');
  }
  const push = shCapture('git push origin HEAD:main');
  if (push.ok) return 'ok';
  return classifyPushError(push.out);
}

function report({ issue, branch, wtPath, closingSha, landedSha, kept, dry }) {
  const short = wtPath ? wtPath.replace(process.env.HOME || '\0', '~') : '(unknown)';
  const bar = '─'.repeat(58);
  console.log(bar);
  console.log(`  ${dry ? 'WOULD CLOSE' : kept ? 'LANDED (kept worktree)' : 'CLOSED'}  ·  issue: #${issue}`);
  console.log(bar);
  console.log(`  branch    ${branch || '(detached)'}`);
  console.log(`  worktree  ${short}`);
  if (closingSha) {
    console.log(`  commit    ${closingSha.slice(0, 12)}  (on origin/main)`);
    if (landedSha && landedSha !== closingSha) {
      console.log(`  tip       ${landedSha.slice(0, 12)}  (post-rebase HEAD)`);
    }
  }
  console.log(bar);
  const tipField = landedSha && landedSha !== closingSha ? ` tip=${landedSha}` : '';
  console.log(`CLOSE ${dry ? 'DRYRUN' : 'OK'} issue=${issue} branch=${branch || ''} sha=${closingSha || ''}${tipField}${kept ? ' kept=1' : ''}`);
}

function logCommentPrompt(issue, closingSha) {
  const s = closingSha ? closingSha.slice(0, 12) : '(sha)';
  log(`Post your closing comment:\n  gh issue comment ${issue} --body "Closed in ${s}. <your summary here>"`);
}

// Remove the worktree + branch + prune. Run synchronously from root (the
// detached-subprocess trick in close.js dodges an npm getcwd bug we don't have).
function teardown(wtPath, branch, root) {
  const res = shCapture(`git worktree remove "${wtPath}" && git branch -D ${branch} && git worktree prune`);
  if (!res.ok) {
    console.error('[close] warning: teardown may have failed — check: git worktree list');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.issue || !/^\d+$/.test(opts.issue)) {
    die('usage: close <issue-number> [--branch <name>] [--max N] [--dry-run] [--keep] ' +
        '[--no-verify-issue] [--skip-marker-check] [--skip-keyword-check] [--skip-scope-audit] ' +
        '[--worktree-dir <dir>]');
  }
  const issue = opts.issue;

  // --- pre-flight: refuse to start unless the close is real and the tree sane.
  const branch = opts.branch || currentBranch();
  if (!branch || !/\/issue-\d+/.test(branch)) {
    die(`current branch "${branch || '?'}" is not a <fruit>/issue-<N> worktree branch. ` +
        'Run this from inside the puzzle\'s worktree, not the main checkout.');
  }
  if (!new RegExp(`/issue-${issue}\\b`).test(branch)) {
    die(`branch "${branch}" does not match issue #${issue}. Wrong worktree?`);
  }

  const root = mainRoot();
  const fruit = branch.split('/')[0];
  const wtPath = path.join(root, opts.worktreeDir, `${fruit}-issue-${issue}`);
  if (opts.branch) {
    try {
      process.chdir(wtPath);
    } catch (_) {
      die(`--branch supplied but worktree not found at ${wtPath}. Is it still present?`);
    }
  }

  const closingCommitSha = findClosingCommitSha(issue);
  if (!closingCommitSha) {
    // Recovery path: agent may have pushed before running close.
    sh('git fetch origin main', true);
    const alreadyLandedSha = findClosingCommitOnMain(issue);
    if (alreadyLandedSha) {
      const state = sh(`gh issue view ${issue} --json state -q .state`, true);
      if (state && state.trim().toUpperCase() !== 'OPEN') {
        log(`commit ${alreadyLandedSha.slice(0, 12)} already on origin/main and #${issue} is ${state.trim()} — treating as clean close.`);
        deleteClaimRef(issue);
        if (opts.keep) {
          report({ issue, branch, wtPath, closingSha: alreadyLandedSha, landedSha: alreadyLandedSha, kept: true, dry: false });
          logCommentPrompt(issue, alreadyLandedSha);
          return;
        }
        process.chdir(root);
        const pull = shCapture('git pull --ff-only origin main');
        if (pull.ok) log('main checkout synced.');
        else log(`warn: ff pull of main skipped (${pull.out.trim().split('\n')[0].slice(0, 80)}). ` +
                 `Sync manually: git -C "${root}" pull --ff-only origin main`);
        report({ issue, branch, wtPath, closingSha: alreadyLandedSha, landedSha: alreadyLandedSha, kept: false, dry: false });
        log(`Shell re-root: cd "${root}"`);
        logCommentPrompt(issue, alreadyLandedSha);
        teardown(wtPath, branch, root);
        return;
      }
    }
    die(`No unpushed commit references "Closes #${issue}". Commit the close ` +
        '(marker deletion + `Closes #N`) FIRST, then run close. ' +
        'This tool lands an existing close commit; it does not author one.');
  }

  // Scope audit (informational, non-blocking, skippable).
  if (!opts.skipScopeAudit) {
    sh('git fetch origin main', true);
    const base = (sh('git merge-base HEAD origin/main', true) || '').trim();
    const stat = sh(scopeAuditDiffCommand(base), true);
    if (stat && stat.trim()) {
      const label = base ? 'merge-base..HEAD' : 'origin/main (fallback)';
      console.log(`[close] scope audit (git diff --stat ${label}):`);
      console.log(stat.trimEnd());
    }
  }

  // velocity-row guard integrates once pmtools velocity lands (issue tracked separately)

  // Guard 2 (keyword): closing commit subject vs issue title.
  if (!opts.skipKeywordCheck) checkKeywordMatch(issue, closingCommitSha);
  // Guard (marker): the puzzle marker must have been deleted before closing.
  if (!opts.skipMarkerCheck) checkMarkerDeleted(issue);

  if (rebaseOrMergeInProgress()) {
    die('a rebase/merge is already in progress here — finish or abort it first.');
  }
  if (!treeIsClean()) {
    die('working tree is not clean. Commit or stash everything into the close ' +
        'commit first (this tool only pushes what is already committed).');
  }

  const sha = headSha();

  if (opts.dryRun) {
    log(`would loop fetch/rebase/push (max ${opts.max}), verify ${sha && sha.slice(0, 12)} on origin/main, then ${opts.keep ? 'KEEP' : 'remove'} the worktree.`);
    report({ issue, branch, wtPath, closingSha: null, landedSha: null, kept: opts.keep, dry: true });
    return;
  }

  // --- land: loop fetch/rebase/push until it sticks or we give up.
  let landed = false;
  for (let attempt = 1; attempt <= opts.max; attempt++) {
    const verdict = tryLand();
    if (verdict === 'ok') { landed = true; break; }
    if (verdict === 'rejected-other') {
      die(`push was rejected for a non-racy reason (hook, auth, or protected ` +
          `branch) on attempt ${attempt}. Your commit is SAFE and local — ` +
          'fix the cause and re-run close. Worktree left intact.');
    }
    log(`push lost the race (attempt ${attempt}/${opts.max}) — re-fetching and retrying.`);
  }
  if (!landed) {
    die(`push lost the race ${opts.max} times — main is hot right now. Your ` +
        `commit ${sha && sha.slice(0, 12)} is SAFE and local; re-run ` +
        'close (or raise --max). Worktree left intact, NOT removed.');
  }

  const landedSha = headSha();
  const closingCommitOnMainSha = findClosingCommitOnMain(issue);

  // --- the gate: verify on origin/main before ANY teardown.
  sh('git fetch origin main', true);
  if (!shouldCleanup({ onOriginMain: onOriginMain(landedSha) })) {
    die(`push reported success but ${landedSha && landedSha.slice(0, 12)} is NOT on ` +
        'origin/main — refusing to remove the worktree. Investigate before ' +
        'cleaning up; your work is intact.');
  }
  if (closingCommitOnMainSha) {
    log(`commit ${closingCommitOnMainSha.slice(0, 12)} confirmed on origin/main.`);
    if (landedSha && landedSha !== closingCommitOnMainSha) {
      log(`tip ${landedSha.slice(0, 12)} is the post-rebase HEAD.`);
    }
  } else {
    log(`commit ${landedSha.slice(0, 12)} confirmed on origin/main.`);
  }

  deleteClaimRef(issue);

  // --- best-effort: confirm the issue actually closed (the keyword can lag).
  if (opts.verifyIssue) {
    const st = sh(`gh issue view ${issue} --json state -q .state`, true);
    if (st && st.trim().toUpperCase() === 'OPEN') {
      log(`#${issue} still shows OPEN — closing it explicitly.`);
      const comment = `Closed via pmtools close (commit ${landedSha.slice(0, 12)} on main).`;
      sh(`gh issue close ${issue} -c "${comment}"`, true);
    } else if (st) {
      log(`#${issue} is ${st.trim()}.`);
    }
  }

  if (opts.keep) {
    report({ issue, branch, wtPath, closingSha: closingCommitOnMainSha, landedSha, kept: true, dry: false });
    logCommentPrompt(issue, closingCommitOnMainSha || landedSha);
    return;
  }

  // --- teardown: only reachable past the gate. Run from main root.
  process.chdir(root);
  const pull = shCapture('git pull --ff-only origin main');
  if (pull.ok) log('main checkout synced.');
  else log(`warn: ff pull of main skipped (${pull.out.trim().split('\n')[0].slice(0, 80)}). ` +
           `Sync manually: git -C "${root}" pull --ff-only origin main`);

  report({ issue, branch, wtPath, closingSha: closingCommitOnMainSha, landedSha, kept: false, dry: false });
  log(`Shell re-root: cd "${root}"`);
  logCommentPrompt(issue, closingCommitOnMainSha || landedSha);
  teardown(wtPath, branch, root);
}

if (require.main === module) main();

module.exports = { parseArgs, mainRoot };
