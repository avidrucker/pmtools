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
 * The velocity-row guard (#5) IS ported, but DB-based and config-gated: it reads
 * SQLite (the source of truth), not the lccjs velocity CSV. Still OMITTED
 * (lccjs-specific, out of scope): the velocity-CSV diff parsers + auto-resolve,
 * the learnings-README conflict resolver, union-file auto-resolve, and the
 * parent-tracker scan. Any rebase conflict is blocking.
 *
 * Usage (after committing `Closes #N`):
 *   node close.js <issue>                    # from inside the worktree
 *   node close.js <issue> --branch <name>    # from the main checkout
 *   node close.js <issue> --max 8            # more push-race retries (default 5)
 *   node close.js <issue> --dry-run          # show the plan, change nothing
 *   node close.js <issue> --keep             # land but DON'T tear down
 *   node close.js <issue> --no-verify-issue  # skip the gh post-close check
 *   node close.js <issue> --skip-marker-check / --skip-keyword-check / --skip-scope-audit
 *   node close.js <issue> --skip-velocity-check  # bypass the velocity-row guard
 *   node close.js <issue> --worktree-dir <dir>   # default .claude/worktrees
 */

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./close_core');
const config = require('./config');
const store = require('./store');
const storeCore = require('./store_core');
const claimCore = require('./claim_core');
const {
  DEFAULT_MAX_RETRIES, isSafeRef, classifyPushError, shouldCleanup,
  claimRefDeleteCommand, classifyClaimRefDelete,
  bodyClosesIssue, extractKeywords, keywordsOverlap, markerStillPresent,
  scopeAuditDiffCommand, velocityRowPresent, computeVelocityMismatch,
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

// arg-array git exec (#37): values are passed as argv and never re-parsed by a
// shell. Returns { ok, out } like shCapture; used for teardown's `branch -D
// <branch>`, where --branch is attacker-influenced.
function gitCapture(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
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
    skipMarkerCheck: false, skipScopeAudit: false, skipVelocityCheck: false,
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
    else if (a === '--skip-velocity-check') opts.skipVelocityCheck = true;
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

// Velocity-row guard (#5; ported from lccjs scripts/close.js). Config-gated:
// when storage.velocity is disabled — or the DB is absent (first run / CI) — it
// no-ops. Otherwise SQLite is the source of truth: (Check A) refuse when no
// velocity row exists for this ticket, or (Guard 1) when the closing agent
// logged only a different ticket (the #278 digit-transposition). All blocking
// decisions live in the pure close_core seams; this wrapper only does I/O.
function checkVelocityGuard(issue, fruit) {
  let cfg;
  try {
    cfg = config.loadStorageConfig();
  } catch (_) {
    return; // config unreadable — never block on it.
  }
  if (!cfg.velocity || !cfg.velocity.enabled) return; // disabled → skip.
  const dbPath = cfg.dbPath;
  if (!dbPath || !fs.existsSync(dbPath)) {
    log(`warn: velocity store enabled but no DB at ${dbPath || '(unset)'} — skipping velocity-row check.`);
    return;
  }
  let rows;
  try {
    rows = store.selectAll(dbPath, 'velocity');
  } catch (e) {
    const first = String((e && e.message) || e).split('\n')[0];
    log(`warn: could not read velocity DB at ${dbPath} (${first}) — skipping velocity-row check.`);
    return;
  }
  const n = Number(issue);
  if (velocityRowPresent(rows.filter((r) => r.ticket != null && Number(r.ticket) === n))) return; // Check A (skip issueless null-ticket rows, #56).
  const mismatch = computeVelocityMismatch(rows, issue, fruit);
  if (mismatch.length) {
    die(`velocity-row guard: agent "${fruit}" logged ticket(s) #${mismatch.join(', #')} ` +
        `but is closing #${issue}. Align the velocity row's ticket (or the close) ` +
        'first, then re-run. Pass --skip-velocity-check to bypass.');
  }
  die(`velocity-row guard: no velocity row for #${issue} in ${dbPath}. Log your ` +
      `session first:\n  pmtools velocity log '{"ticket":${issue},"role":"DEV",` +
      `"agent":"${fruit}","started_iso":"<ISO>","finished_iso":"<ISO>","actual_min":<A>}'\n` +
      '  Then re-run close. Pass --skip-velocity-check to bypass (PM/triage closes).');
}

function deleteClaimRef(issue) {
  const out = sh(`${claimRefDeleteCommand(issue)} 2>&1 || true`, true) || '';
  const verdict = classifyClaimRefDelete(out);
  if (verdict === 'DELETED') log(`claim ref refs/claims/issue-${issue} deleted.`);
  else if (verdict === 'ABSENT') log(`claim ref refs/claims/issue-${issue} already absent — no-op.`);
  else log(`warn: could not delete claim ref refs/claims/issue-${issue} (best-effort; close continues).`);
}

// ---- land loop -------------------------------------------------------------

// Re-export the velocity CSV mirror from the SQLite store (the source of truth,
// which already holds both agents' rows) and stage it, to auto-resolve a
// velocity-CSV-only rebase conflict. The mirror is resolved against the current
// worktree's toplevel (where the rebase is happening), not the main checkout.
// On any failure, abort the rebase and die() — the caller's commit stays safe
// and local. (#57; ported from lccjs close.js #313)
function reexportAndStageVelocityCsv(cfg) {
  const top = (sh('git rev-parse --show-toplevel', true) || '').trim() || process.cwd();
  const csvAbs = path.join(top, cfg.velocity.csvMirror);
  try {
    store.exportCsv(cfg.dbPath, 'velocity', csvAbs, storeCore.VELOCITY_COLS);
  } catch (e) {
    sh('git rebase --abort', true);
    const first = String((e && e.message) || e).split('\n')[0];
    die(`velocity CSV conflict: re-export from the DB failed (${first}). ` +
        'Aborted the rebase; your commit is safe and local.');
  }
  const staged = shCapture(`git add "${csvAbs}"`);
  if (!staged.ok) {
    sh('git rebase --abort', true);
    die('velocity CSV conflict: re-export succeeded but git add failed. ' +
        'Aborted the rebase; your commit is safe and local.');
  }
}

// One fetch/rebase/push round. Returns 'ok' | 'race' | 'rejected-other', or
// die()s on a blocking rebase conflict (not retryable). A conflict whose ONLY
// path is the velocity CSV mirror auto-resolves via re-export (#57).
function tryLand() {
  sh('git fetch origin main', true);
  const rebase = shCapture('git rebase origin/main');
  if (!rebase.ok) {
    const conflicted = conflictedPaths();
    let cfg = null;
    try { cfg = config.loadStorageConfig(); } catch (_) { cfg = null; }
    const csvMirror = cfg && cfg.velocity && cfg.velocity.enabled ? cfg.velocity.csvMirror : null;
    if (csvMirror && core.isVelocityCsvOnlyConflict(conflicted, csvMirror)) {
      // Two agents committed divergent full-table CSV exports. Re-export from the
      // DB (already holds both rows) and continue — the only resolvable conflict.
      reexportAndStageVelocityCsv(cfg);
      const cont = shCapture('GIT_EDITOR=true git rebase --continue');
      if (!cont.ok) {
        sh('git rebase --abort', true);
        die('velocity CSV conflict: re-export + stage succeeded but rebase ' +
            `--continue failed: ${cont.out.trim()}. Your commit is safe and local.`);
      }
      log('velocity CSV conflict auto-resolved (re-exported from the DB).');
    } else {
      sh('git rebase --abort', true);
      die('rebase hit a real conflict in: ' +
          `${conflicted.join(', ') || rebase.out.trim()}. ` +
          'Aborted the rebase. Resolve manually, then re-run close. ' +
          'Your commit is safe and local.');
    }
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
  // arg-array exec, short-circuited to mirror the old `&&` chain (#37).
  let res = gitCapture(['worktree', 'remove', wtPath]);
  if (res.ok) res = gitCapture(['branch', '-D', branch]);
  if (res.ok) gitCapture(['worktree', 'prune']);
  if (!res.ok) {
    console.error('[close] warning: teardown may have failed — check: git worktree list');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.issue || !/^\d+$/.test(opts.issue)) {
    die('usage: close <issue-number> [--branch <name>] [--max N] [--dry-run] [--keep] ' +
        '[--no-verify-issue] [--skip-marker-check] [--skip-keyword-check] [--skip-scope-audit] ' +
        '[--skip-velocity-check] [--worktree-dir <dir>]');
  }
  const issue = opts.issue;

  // --- pre-flight: refuse to start unless the close is real and the tree sane.
  const branch = opts.branch || currentBranch();
  // Injection guard (#37): --branch is interpolated into teardown's `git branch
  // -D <branch>`. Reject shell metacharacters, then require an ANCHORED branch
  // shape bound to the issue token (the old guards were unanchored substring
  // .test()s, so `x/issue-17; touch …` slipped through). The anchored shape
  // tolerates the br-/<project>-<lang>- self-describing scheme (#17) as well as
  // legacy <fruit>/issue-N names — and, by anchoring, refuses a slug-embedded
  // `-issue-M` from masquerading as the issue token.
  if (!branch || !isSafeRef(branch)) {
    die(`branch "${branch || '?'}" contains unsafe characters — ` +
        'only letters, digits, and . _ / - are allowed.');
  }
  if (!/^(?:br-)?[A-Za-z0-9._-]+\/(?:[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-)?issue-\d+(?:-[A-Za-z0-9._-]+)?$/.test(branch)) {
    die(`current branch "${branch}" is not a [br-]<agent>/[<project>-<lang>-]issue-<N> worktree branch. ` +
        'Run this from inside the puzzle\'s worktree, not the main checkout.');
  }
  if (!new RegExp(`^(?:br-)?[A-Za-z0-9._-]+/(?:[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-)?issue-${issue}(?:-[A-Za-z0-9._-]+)?$`).test(branch)) {
    die(`branch "${branch}" does not match issue #${issue}. Wrong worktree?`);
  }

  const root = mainRoot();
  const fruit = claimCore.inferFruitFromBranch(branch) || branch.split('/')[0];
  const wtPath = path.join(root, opts.worktreeDir, claimCore.branchToWorktreeName(branch));
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

  // Velocity-row guard (#5, skippable): config-gated; SQLite is source of truth.
  if (!opts.skipVelocityCheck) checkVelocityGuard(issue, fruit);

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
      // arg-array exec (#37): the only gh WRITE call — argv, never shell-parsed.
      spawnSync('gh', ['issue', 'close', String(issue), '-c', comment], { encoding: 'utf8' });
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
