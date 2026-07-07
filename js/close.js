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
 *   node close.js <issue>                    # from the MAIN checkout (recommended, #104):
 *                                            #   worktree + branch resolve from the issue
 *                                            #   number, so the caller's cwd is never the
 *                                            #   dir being torn down. Also works from inside
 *                                            #   the worktree (back-compat).
 *   node close.js <issue> --branch <name>    # override the resolved branch explicitly
 *   node close.js <issue> --max 8            # more push-race retries (default 5)
 *   node close.js <issue> --dry-run          # show the plan, change nothing
 *   node close.js <issue> --keep             # land but DON'T tear down
 *   node close.js <issue> --no-verify-issue  # skip the gh post-close check
 *   node close.js <issue> --skip-marker-check / --skip-keyword-check / --skip-scope-audit
 *   node close.js <issue> --skip-velocity-check  # bypass the velocity-row guard
 *   node close.js <issue> --skip-verify          # bypass the config-driven pre-close verify gate
 *   node close.js <issue> --worktree-dir <dir>   # DEPRECATED: back-compat only, ignored post-#51 (close self-discovers)
 *
 *   node close.js <issue> --no-code [--comment "…" | --comment-file F | --no-comment]
 *                                            # (#113) close a COMMENT-ONLY ticket (spike/decision/triage):
 *                                            #   no `Closes #N` commit; skip every code guard; post the
 *                                            #   comment, close the issue, sweep + log; tear down a
 *                                            #   worktree if one was claimed (works with or without one).
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { sh, shCapture, gitCapture, makeDie, makeLog } = require('./sh');
const { deleteClaimRef } = require('./claimref');
const core = require('./close_core');
const config = require('./config');
const { getProvider } = require('./provider');
const store = require('./store');
const storeCore = require('./store_core');
const claimCore = require('./claim_core');
const {
  DEFAULT_MAX_RETRIES, isSafeRef, classifyPushError, shouldCleanup,
  claimRefDeleteCommand, classifyClaimRefDelete,
  bodyClosesIssue, pushedCommitReferencesIssue, unsupportedFlagHint, extractKeywords, keywordsOverlap, markerStillPresent,
  scopeAuditDiffCommand, velocityRowPresent, computeVelocityMismatch,
} = core;

const die = makeDie('close');
const log = makeLog('close');

// The MAIN checkout's root, NOT the worktree we're closing — the worktree is
// about to be removed, so the removal must run from a directory that survives.
// git-common-dir resolution lives once in config.mainRepoRoot (#74); this wrapper
// keeps close's die-on-failure behavior (config returns null).
function mainRoot() {
  const root = config.mainRepoRoot();
  if (!root) die('not inside a git repository.');
  return root;
}

function parseArgs(argv) {
  const opts = {
    issue: null, max: DEFAULT_MAX_RETRIES, dryRun: false,
    keep: false, verifyIssue: true, skipKeywordCheck: false,
    skipMarkerCheck: false, skipScopeAudit: false, skipVelocityCheck: false,
    skipVerify: false,
    updateTrackers: false, branch: null, worktreeDir: '.claude/worktrees',
    noCode: false, comment: null, commentFile: null, noComment: false,
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
    else if (a === '--skip-verify') opts.skipVerify = true;
    else if (a === '--update-trackers') opts.updateTrackers = true;
    else if (a === '--branch') opts.branch = argv[++i];
    // no-code close (#113): close a comment-only ticket without a `Closes #N` commit.
    else if (a === '--no-code') opts.noCode = true;
    else if (a === '--comment') opts.comment = argv[++i];
    else if (a === '--comment-file') opts.commentFile = argv[++i];
    else if (a === '--no-comment') opts.noComment = true;
    // --worktree-dir: accepted for back-compat but intentionally IGNORED post-#51
    // (close self-discovers the worktree via `git worktree list`). Do not use. (#73)
    else if (a === '--worktree-dir') opts.worktreeDir = argv[++i];
    else if (a.startsWith('--')) {
      // A flag recognized on a sibling command but unsupported here (#9, e.g.
      // `--as`) gets a teaching message; truly unknown flags keep the generic one.
      // Both are usage errors → exit 2.
      const hint = unsupportedFlagHint(a);
      die(hint || `unknown flag: ${a}`, 2);
    }
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

// Recovery diagnostic (#7): scan origin/main -100 for a commit that REFERENCES
// #issue (e.g. `(#N)`) but lacks a close keyword. Returns { sha, subject } or null.
// The impure twin of pushedCommitReferencesIssue.
function findPushedReferenceOnMain(issue) {
  const out = sh('git log origin/main -100 --format=%H', true) || '';
  const shas = out.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  for (const sha of shas) {
    const body = sh(`git show -s --format=%B ${sha}`, true) || '';
    if (pushedCommitReferencesIssue(body, issue)) {
      const subject = (sh(`git show -s --format=%s ${sha}`, true) || '').trim();
      return { sha, subject };
    }
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

// Pre-close verify gate (#106): run project-defined commands from `close.verify`
// (lint/test/typecheck) and REFUSE to land if any exits non-zero. Config-gated:
// no `close.verify.commands` → no-op (byte-identical to today). Runs LAST — after
// the fast built-in gates, immediately before the land loop (ruling Q2) — so a
// wrong-marker close fails in ~1s, not after a slow test run. Each command runs in
// the worktree (default) or repo root; the first non-zero exit prints the output
// and dies exit 1, leaving the worktree intact and NOTHING pushed. `--dry-run`
// reports the commands without executing them.
function runPreCloseVerify(opts, wtPath, root) {
  let closeCfg;
  try { closeCfg = config.loadCloseConfig(); } catch (_) { return; }
  const plan = core.preclosePlan(closeCfg && closeCfg.verify);
  if (!plan.run) return;
  const verifyDir = plan.cwd === 'root' ? root : wtPath;
  for (const cmd of plan.commands) {
    if (opts.dryRun) { log(`verify (dry-run): would run "${cmd}" in the ${plan.cwd}`); continue; }
    const limit = plan.timeoutSec ? ` (timeout ${plan.timeoutSec}s)` : '';
    log(`verify: ${cmd} (in the ${plan.cwd})${limit}`);
    const res = shCapture(cmd, verifyDir, plan.timeoutSec);
    if (res.out) process.stdout.write(res.out.endsWith('\n') ? res.out : res.out + '\n');
    if (!res.ok) {
      const why = res.timedOut ? `timed out after ${plan.timeoutSec}s (killed)` : 'exited non-zero';
      die(`pre-close verify failed: \`${cmd}\` ${why}. Nothing pushed, worktree ` +
          'left intact — fix and re-run close, or bypass with --skip-verify.', 1);
    }
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

// Union-merge an append-only file that conflicted on BOTH sides of a rebase,
// keeping every line from each side (git's merge=union semantics) — driven by
// config so the consumer needs no committed .gitattributes (#36 guard 2 / #290).
// During the conflict the three versions live in the index: :1: base, :2: ours
// (origin/main), :3: theirs (the replayed commit); `merge-file --union` folds them.
function unionMergeAndStage(file) {
  const dir = path.dirname(file) || '.';
  const tmp = (k) => path.join(dir, `.pmtools-union.${path.basename(file)}.${k}`);
  const b = tmp('base'), o = tmp('ours'), t = tmp('theirs');
  try {
    fs.writeFileSync(b, sh(`git show ":1:${file}"`, true) || '');
    fs.writeFileSync(o, sh(`git show ":2:${file}"`, true) || '');
    fs.writeFileSync(t, sh(`git show ":3:${file}"`, true) || '');
    const merged = sh(`git merge-file -p --union "${o}" "${b}" "${t}"`, true);
    if (merged === null) {
      sh('git rebase --abort', true);
      die(`union-file conflict: merge-file failed for ${file}. ` +
          'Aborted the rebase; your commit is safe and local.');
    }
    fs.writeFileSync(file, merged);
    const staged = shCapture(`git add "${file}"`);
    if (!staged.ok) {
      sh('git rebase --abort', true);
      die(`union-file conflict: merged ${file} but git add failed. ` +
          'Aborted the rebase; your commit is safe and local.');
    }
  } finally {
    for (const f of [b, o, t]) { try { fs.unlinkSync(f); } catch (_) { /* best-effort */ } }
  }
}

// Resolve an append-only markdown index that conflicted (each side appended a
// row) by stripping the git conflict markers in place — keeping both rows, and
// collapsing an adjacent identical row — then stage it. The decision logic is
// the pure `resolveAppendOnlyMarkdownConflict`; this wraps it with file I/O.
// (#36 guard 4 / #971)
function resolveMarkdownIndexAndStage(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    sh('git rebase --abort', true);
    die(`learnings-index conflict: could not read ${file} (${e.message}). ` +
        'Aborted the rebase; your commit is safe and local.');
  }
  try {
    fs.writeFileSync(file, core.resolveAppendOnlyMarkdownConflict(text));
  } catch (e) {
    sh('git rebase --abort', true);
    die(`learnings-index conflict: could not write ${file} (${e.message}). ` +
        'Aborted the rebase; your commit is safe and local.');
  }
  const staged = shCapture(`git add "${file}"`);
  if (!staged.ok) {
    sh('git rebase --abort', true);
    die(`learnings-index conflict: resolved ${file} but git add failed. ` +
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
    let closeCfg = { autoResolve: { unionFiles: [], markdownIndexes: [] } };
    try { closeCfg = config.loadCloseConfig(); } catch (_) { /* defaults */ }
    const unionFiles = closeCfg.autoResolve.unionFiles;
    const markdownIndexes = closeCfg.autoResolve.markdownIndexes;
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
    } else if (unionFiles.length && core.classifyRebaseConflict(conflicted, unionFiles) === 'union-only') {
      // Consumer-configured append-only logs diverged on both sides — union-merge
      // each (keep every line), stage, and continue. Config-driven, so no committed
      // .gitattributes is required (#36 guard 2 / #290).
      for (const f of conflicted) unionMergeAndStage(f);
      const cont = shCapture('GIT_EDITOR=true git rebase --continue');
      if (!cont.ok) {
        sh('git rebase --abort', true);
        die('union-file conflict: merge + stage succeeded but rebase --continue ' +
            `failed: ${cont.out.trim()}. Your commit is safe and local.`);
      }
      log('union-file conflict auto-resolved (merge=union, kept both sides).');
    } else if (markdownIndexes.length && core.isMarkdownIndexOnlyConflict(conflicted, markdownIndexes)) {
      // Consumer-configured append-only markdown indexes diverged (each agent
      // appended a row) — strip the conflict markers (keep both rows, dedup an
      // adjacent identical row), stage, and continue. (#36 guard 4 / #971)
      for (const f of conflicted) resolveMarkdownIndexAndStage(f);
      const cont = shCapture('GIT_EDITOR=true git rebase --continue');
      if (!cont.ok) {
        sh('git rebase --abort', true);
        die('learnings-index conflict: resolve + stage succeeded but rebase --continue ' +
            `failed: ${cont.out.trim()}. Your commit is safe and local.`);
      }
      log('learnings-index conflict auto-resolved (kept both rows).');
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
    console.error('[close] note: teardown may have failed — check: git worktree list');
  }
}

// The shared post-deleteClaimRef tail of close — identical between the recovery
// (already-pushed) and normal land paths (#76). keep → report + the closing-comment
// prompt only; otherwise chdir to the main root, ff-pull main, report, re-root note,
// prompt, and tear down the worktree. The comment-prompt sha falls back
// closing→landed. Twin of py finalize_close.
function finalizeClose({ issue, branch, wtPath, root, closingSha, landedSha, keep }) {
  const promptSha = closingSha || landedSha;
  if (keep) {
    report({ issue, branch, wtPath, closingSha, landedSha, kept: true, dry: false });
    logCommentPrompt(issue, promptSha);
    return;
  }
  process.chdir(root);
  const pull = shCapture('git pull --ff-only origin main');
  if (pull.ok) log('main checkout synced.');
  else log(`warn: ff pull of main skipped (${pull.out.trim().split('\n')[0].slice(0, 80)}). ` +
           `Sync manually: git -C "${root}" pull --ff-only origin main`);
  report({ issue, branch, wtPath, closingSha, landedSha, kept: false, dry: false });
  log(`Shell re-root: cd "${root}"`);
  logCommentPrompt(issue, promptSha);
  teardown(wtPath, branch, root);
}

// After a successful close, tick the parent tracker issue's checkbox for this
// child (#36 guard 3 / lccjs #907). Opt-in: config `close.updateParentTrackers`
// or the --update-trackers flag. Best-effort — every failure warns and skips; it
// never blocks or fails the close. Only a box whose SOLE issue ref is this child
// is ticked (the pure tickCheckboxForIssue), so an umbrella line is never
// prematurely checked.
function scanParentTrackers(issue, opts) {
  let enabled = !!opts.updateTrackers;
  if (!enabled) {
    try { enabled = config.loadCloseConfig().updateParentTrackers === true; } catch (_) { enabled = false; }
  }
  if (!enabled) return;
  let provider;
  try { provider = getProvider('github'); } catch (_) { return; }
  let issues;
  try { issues = provider.listOpenIssuesWithBodies(500); } catch (_) {
    log('warn: could not fetch open issues for parent-tracker scan — skipping.');
    return;
  }
  const seen = new Set();
  for (const { trackerNumber } of core.findParentTrackers(issues, issue)) {
    if (seen.has(trackerNumber)) continue;
    seen.add(trackerNumber);
    const full = (issues || []).find((i) => i.number === trackerNumber);
    if (!full) continue;
    const newBody = core.tickCheckboxForIssue(full.body, issue);
    if (newBody === String(full.body || '')) {
      log(`warn: parent tracker #${trackerNumber} box replacement had no effect — skipping.`);
      continue;
    }
    if (provider.editIssueBody(trackerNumber, newBody)) {
      log(`Parent tracker #${trackerNumber}: checked the box for #${issue}.`);
    } else {
      log(`warn: could not update parent tracker #${trackerNumber} — left as-is.`);
    }
  }
}

// No-code close (#113): close a comment-only ticket (research spike / decision /
// triage) whose deliverable is a COMMENT, not a `Closes #N` commit. Skips every
// code guard (commit scan / marker / keyword / verify gate / land loop), posts the
// closing comment, closes the issue, then still logs velocity + sweeps the claim
// ref, tearing down a worktree if one was claimed (else just closes). Comment-first,
// fail-closed: a failed comment post leaves the issue OPEN (deliverable never lost).
function runNoCodeClose(opts, issue, root) {
  const plan = core.noCodeClosePlan({
    comment: opts.comment, commentFile: opts.commentFile, noComment: opts.noComment,
  });
  if (!plan.ok) die(plan.error, 2);

  let body = null;
  if (plan.source === 'inline') body = opts.comment;
  else if (plan.source === 'file') {
    try { body = fs.readFileSync(opts.commentFile, 'utf8'); }
    catch (e) { die(`could not read --comment-file ${opts.commentFile}: ${e.message}`, 2); }
  }

  // Resolve a worktree if one exists — OPTIONAL for a no-code close (unlike a
  // normal close, which requires one to land against).
  const wtRow = core.findWorktreeForIssue(
    core.parseWorktreePorcelain(sh('git worktree list --porcelain', true) || ''), issue);
  const wtPath = wtRow ? wtRow.path : null;
  const branch = core.resolveCloseBranch(wtRow, opts.branch, currentBranch());
  const fruit = branch ? claimCore.inferFruitFromBranch(branch) : null;

  // The issue must be OPEN (a non-OPEN issue is a soft-fail no-op).
  const provider = getProvider('github');
  const st = sh(`gh issue view ${issue} --json state -q .state`, true);
  if (st && st.trim().toUpperCase() !== 'OPEN') {
    log(`#${issue} is ${st.trim()}, not OPEN — nothing to close (no-code).`);
    return;
  }

  // Velocity-row guard (same invariant as a normal close; skippable). Only when the
  // agent is known (a worktree/branch resolved) — a bare no-worktree close can't
  // attribute the row, so it skips with a note.
  if (!opts.skipVelocityCheck) {
    if (fruit) checkVelocityGuard(issue, fruit);
    else log('note: no worktree/branch to infer the agent — skipping the velocity-row guard.');
  }

  if (opts.dryRun) {
    const commentPlan = plan.source === 'none' ? 'post NO comment' : `post the ${plan.source} comment`;
    const wtPlan = wtPath ? ', and tear down the worktree' : ' (no worktree)';
    log(`no-code close (dry-run): would ${commentPlan}, close #${issue}, sweep the claim ref${wtPlan}.`);
    report({ issue, branch, wtPath, closingSha: null, landedSha: null, kept: false, dry: true });
    return;
  }

  // Post the comment FIRST — fail-closed: a failed comment leaves the issue OPEN so
  // the deliverable is never silently dropped.
  if (plan.source !== 'none') {
    if (!provider.createComment(issue, body)) {
      die(`failed to post the closing comment on #${issue} (gh unavailable?) — ` +
          'issue left OPEN, nothing closed.', 1);
    }
  }
  if (!provider.closeIssue(issue)) {
    die(`comment posted but failed to close #${issue} (gh unavailable?) — ` +
        `close it manually: gh issue close ${issue}`, 1);
  }
  log(`#${issue} closed (no-code${plan.source === 'none' ? ', no comment' : ''}).`);

  // Sweep the claim ref (same as a normal close).
  deleteClaimRef(issue, { log });

  // Tear down the worktree if one was claimed (reuse close's teardown, run from
  // root — no chdir dance, since a no-code close never entered the worktree).
  if (wtPath && fs.existsSync(wtPath)) {
    if (branch && isSafeRef(branch)) { teardown(wtPath, branch, root); log('worktree torn down.'); }
    else log(`note: worktree at ${wtPath} left in place (branch unsafe/unresolved).`);
  } else {
    log('no worktree to tear down.');
  }

  report({ issue, branch, wtPath, closingSha: null, landedSha: null, kept: false, dry: false });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.issue || !/^\d+$/.test(opts.issue)) {
    die('usage: close <issue-number> [--branch <name>] [--max N] [--dry-run] [--keep] ' +
        '[--no-verify-issue] [--skip-marker-check] [--skip-keyword-check] [--skip-scope-audit] ' +
        '[--skip-velocity-check] [--skip-verify] [--worktree-dir <dir> (deprecated, ignored)]\n' +
        '  no-code close (comment-only ticket): close <N> --no-code ' +
        '[--comment "…" | --comment-file F | --no-comment]', 2);
  }
  const issue = opts.issue;
  const root = mainRoot();

  // No-code close (#113): a comment-only ticket — dispatch BEFORE the worktree-
  // required guards, since it works with or without a worktree.
  if (opts.noCode) return runNoCodeClose(opts, issue, root);

  // --- resolve the worktree + branch for issue #N CWD-INDEPENDENTLY (#104), so
  // `close <N>` runs from the MAIN checkout — not only from inside the worktree it
  // deletes (which strands the caller's shell in a removed cwd). Discover the
  // worktree from git's own porcelain (as status/sweep/release do) rather than
  // rebuilding the dir name — robust under a non-default --worktree-dir and odd
  // branch shapes, and the single source of truth for where the worktree is (#51).
  const wtRow = core.findWorktreeForIssue(
    core.parseWorktreePorcelain(sh('git worktree list --porcelain', true) || ''), issue);
  const wtPath = wtRow ? wtRow.path : null;
  // Identity/branch inferred from the RESOLVED worktree's branch, not cwd:
  // explicit --branch wins, else the worktree branch, else the cwd branch.
  const branch = core.resolveCloseBranch(wtRow, opts.branch, currentBranch());

  // A real worktree must exist to land against and tear down. Fail here — before
  // the branch-shape guards — so a from-main run with no worktree gets an accurate
  // message instead of the stale "run from inside the worktree" one.
  if (!wtPath || !fs.existsSync(wtPath)) {
    if (opts.branch) {
      die(`--branch supplied but no worktree for issue #${issue} found via ` +
          '`git worktree list`. Is it still present?');
    }
    die(`no worktree for issue #${issue} found via \`git worktree list\` — claim it ` +
        `first (pmtools claim ${issue} --as <name>), or run close from inside its worktree.`);
  }

  // Injection guard (#37): the resolved branch is interpolated into teardown's
  // `git branch -D <branch>`. Reject shell metacharacters, then require an ANCHORED
  // branch shape bound to the issue token (the old guards were unanchored substring
  // .test()s, so `x/issue-17; touch …` slipped through). The anchored shape
  // tolerates the br-/<project>-<lang>- self-describing scheme (#17) as well as
  // legacy <fruit>/issue-N names — and, by anchoring, refuses a slug-embedded
  // `-issue-M` from masquerading as the issue token.
  if (!branch || !isSafeRef(branch)) {
    die(`branch "${branch || '?'}" contains unsafe characters — ` +
        'only letters, digits, and . _ / - are allowed.');
  }
  if (!/^(?:br-)?[A-Za-z0-9._-]+\/(?:[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-)?issue-\d+(?:-[A-Za-z0-9._-]+)?$/.test(branch)) {
    die(`branch "${branch}" is not a [br-]<agent>/[<project>-<lang>-]issue-<N> worktree branch. ` +
        'Wrong --branch, or a mislabeled worktree?');
  }
  if (!new RegExp(`^(?:br-)?[A-Za-z0-9._-]+/(?:[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-)?issue-${issue}(?:-[A-Za-z0-9._-]+)?$`).test(branch)) {
    die(`branch "${branch}" does not match issue #${issue}. Wrong worktree?`);
  }

  const fruit = claimCore.inferFruitFromBranch(branch);
  // Operate from INSIDE the worktree (git land/rebase/push target its branch);
  // finalizeClose then chdirs back to `root` before teardown. When the caller ran
  // from the main checkout, its shell cwd was never inside the deleted worktree, so
  // it is never stranded — the whole point of #104. A child process cannot chdir
  // its parent, so this "run from a stable cwd" design, not a post-teardown repair,
  // is the durable fix.
  process.chdir(wtPath);

  const closingCommitSha = findClosingCommitSha(issue);
  if (!closingCommitSha) {
    // Recovery path: agent may have pushed before running close.
    sh('git fetch origin main', true);
    const alreadyLandedSha = findClosingCommitOnMain(issue);
    if (alreadyLandedSha) {
      const state = sh(`gh issue view ${issue} --json state -q .state`, true);
      if (state && state.trim().toUpperCase() !== 'OPEN') {
        log(`commit ${alreadyLandedSha.slice(0, 12)} already on origin/main and #${issue} is ${state.trim()} — treating as clean close.`);
        deleteClaimRef(issue, { log });
        finalizeClose({ issue, branch, wtPath, root,
          closingSha: alreadyLandedSha, landedSha: alreadyLandedSha, keep: opts.keep });
        return;
      }
    }
    // Diagnostic (#7): a close commit may already be on origin/main but lack the
    // `Closes #N` keyword (e.g. pushed as `(#N)`). Name it instead of the generic
    // "commit FIRST" message, which misdiagnoses an already-pushed commit.
    const ref = findPushedReferenceOnMain(issue);
    if (ref) {
      die(`Found pushed commit ${ref.sha.slice(0, 12)} "${ref.subject}" that references ` +
          `#${issue} but lacks the \`Closes #${issue}\` keyword — GitHub will not auto-close ` +
          `it and close cannot verify/teardown. Either amend the message to include ` +
          `\`Closes #${issue}\` before pushing (if unshared), or close manually: gh issue close ${issue}`);
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

  // Pre-close verify gate (#106, ruling Q2: runs LAST, just before land; skippable).
  if (!opts.skipVerify) runPreCloseVerify(opts, wtPath, root);

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

  deleteClaimRef(issue, { log });

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

  // --- best-effort: tick the parent tracker's checkbox for this child (#36 guard 3).
  scanParentTrackers(issue, opts);

  // --- finalize: keep-vs-teardown tail, shared with the recovery path (#76).
  finalizeClose({ issue, branch, wtPath, root,
    closingSha: closingCommitOnMainSha, landedSha, keep: opts.keep });
}

if (require.main === module) main();

module.exports = { parseArgs, mainRoot };
