#!/usr/bin/env node
'use strict';
/*
 * claim.js — claim an issue into a worktree under a self-assigned agent identity.
 *
 * Ported from lccjs scripts/claim.js (the IMPURE orchestration). All pure
 * decisions live in ./claim_core; this file does only git/gh I/O and wiring.
 *
 * The lccjs-isms are parameterized (this is the whole point of pmtools):
 *   --worktree-dir <dir>  default .claude/worktrees (relative to mainRoot)
 *   --roster a,b,c        default = FRUITS from claim_core; auto-claim walks it
 *   --lane-check          OFF by default (INVERTED from lccjs): only when passed
 *                         do we enforce the area:* lane gate
 *   --copy-env            OFF by default: only when passed do we copy <root>/.env
 *   --base <ref>          default main
 * Other flags: --as, --dry-run, --force, --allow-stale-main, --custom.
 *
 * Convention:
 *   branch   = <fruit>/issue-<N>[-<slug>]
 *   worktree = <worktreeDir>/<fruit>-issue-<N>
 *
 * Identity precedence: --as > CLAUDE_AGENT_NAME > branch-inferred > auto.
 * Auto (no identity) is a hard error — agents must be named (lccjs #386).
 */

const { execSync, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./claim_core');
const {
  FRUITS, SESSION_SENTINEL_MAX_AGE_S, isSafeRef,
  slugify, resolveIdentity, checkIdentityName,
  shouldBlockClaim, shouldBlockUncategorized, assessBaseStaleness,
  worktreesWithIssue, findLiveWorktreeForIssue, findSameIssueCollision,
  shouldBlockWorktreeGuard, sentinelBranch, isSentinelStaleByAge,
  applyMarkerFlip, buildBannerLines, classifyClaimPushResult,
  buildClaimMessage, claimPushAction,
} = core;

const todoKw = '@' + 'todo';
const inprogressKw = '@' + 'inprogress';

function sh(cmd, allowFail = false) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

// arg-array git exec (#37): values are passed as argv and never re-parsed by a
// shell, so an interpolated `;touch` can never execute. Used for every git call
// that interpolates a branch/base/path; constant-command calls stay on sh().
// Returns stdout on success, null on a non-zero exit (mirrors sh(..., true)).
function git(args, allowFail = false) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

// Like git() but returns combined stdout+stderr regardless of exit, never throws
// (for the claim-ref push, whose output the push-result classifier inspects).
function gitCapture(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

function die(msg) {
  console.error(`[claim] ✗ ${msg}`);
  process.exit(1);
}

// The MAIN checkout's root, NOT cwd. An agent reusing its identity runs from
// inside an existing worktree, but the new worktree must still land under the
// main repo — never nested inside the caller's worktree.
function mainRoot() {
  let dir = sh('git rev-parse --path-format=absolute --git-common-dir', true);
  if (!dir) {
    const rel = sh('git rev-parse --git-common-dir', true); // older git fallback
    if (!rel) die('not inside a git repository.');
    dir = path.resolve(process.cwd(), rel.trim());
  }
  return path.dirname(dir.trim());
}

// Resolve {project, lang} for the naming scheme from .claude/orchestrate.json,
// falling back to the repo basename + 'unk'. Both normalize to a single
// [a-z0-9] token (the scheme delimiter is '-'). Sensible default; override via
// an explicit "project" key and the existing "languages" array in the config.
function resolveNameParts(root) {
  let cfg = {};
  try {
    const p = path.join(root, '.claude', 'orchestrate.json');
    if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) { cfg = {}; }
  const rawProject = (cfg.project != null ? String(cfg.project) : path.basename(root)) || 'repo';
  const project = rawProject.toLowerCase().replace(/[^a-z0-9]/g, '') || 'repo';
  const langs = Array.isArray(cfg.languages) ? cfg.languages : [];
  return { project, lang: core.langTag(langs[0]) };
}

function listWorktreeBranches() {
  const out = sh('git worktree list --porcelain', true) || '';
  const branches = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('branch ')) {
      const branch = line.slice('branch '.length).replace('refs/heads/', '');
      const fruit = branch.includes('/') ? branch.split('/')[0] : null;
      branches.push({ branch, fruit });
    }
  }
  return branches;
}

function isSentinelStale(fruit) {
  const raw = git(['log', '-1', '--format=%ct', `refs/heads/${sentinelBranch(fruit)}`], true);
  if (!raw || !raw.trim()) return false;
  const ts = parseInt(raw.trim(), 10);
  return isSentinelStaleByAge(ts, Math.floor(Date.now() / 1000));
}

function branchExists(branch) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], true) !== null;
}

function createSessionSentinel(fruit) {
  const b = sentinelBranch(fruit);
  if (branchExists(b)) return;
  git(['branch', b, 'HEAD'], true);
}

function takenFruits() {
  const taken = new Set(listWorktreeBranches().map((b) => b.fruit).filter(Boolean));
  const allBranches = sh('git branch --list', true) || '';
  for (const line of allBranches.split('\n')) {
    const branch = line.trim().replace(/^\*\s+/, '');
    if (!branch) continue;
    const slash = branch.indexOf('/');
    if (slash < 0) continue;
    const fruit = branch.slice(0, slash);
    const rest = branch.slice(slash + 1);
    if (rest === 'session' && isSentinelStale(fruit)) continue;
    if (fruit) taken.add(fruit);
  }
  return taken;
}

function currentBranch() {
  const b = sh('git rev-parse --abbrev-ref HEAD', true);
  return b ? b.trim() : null;
}

function readIssue(issue) {
  const out = sh(`gh issue view ${issue} --json title,state,comments,labels`, true);
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    return {
      title: j.title || null,
      state: String(j.state || '').toUpperCase(),
      commentCount: Array.isArray(j.comments) ? j.comments.length : 0,
      labels: Array.isArray(j.labels) ? j.labels.map((l) => l && l.name).filter(Boolean) : [],
    };
  } catch {
    return null;
  }
}

function flipMarker(issue, wtPath) {
  const inprogress = git(['-C', wtPath, 'grep', '-lE', `${inprogressKw} #${issue}:[0-9]`], true);
  if (inprogress && inprogress.trim()) {
    console.log(`[claim] ${inprogressKw} #${issue} already present — skipping flip`);
    return;
  }
  const grep = git(['-C', wtPath, 'grep', '-nIE', `${todoKw} #${issue}:[0-9]`], true);
  if (!grep || !grep.trim()) {
    console.log(`[claim] no ${todoKw} #${issue} marker found — skipping flip`);
    return;
  }
  const firstLine = grep.trim().split('\n')[0];
  const relFile = firstLine.split(':')[0];
  const absFile = path.join(wtPath, relFile);
  let content;
  try { content = fs.readFileSync(absFile, 'utf8'); } catch (e) {
    console.error(`[claim] warn: could not read ${relFile}: ${e.message}`);
    return;
  }
  const { updated, flipped, line } = applyMarkerFlip(content, issue);
  if (!flipped) {
    console.log(`[claim] no ${todoKw} #${issue} marker found — skipping flip`);
    return;
  }
  try { fs.writeFileSync(absFile, updated, 'utf8'); } catch (e) {
    console.error(`[claim] warn: could not write ${relFile}: ${e.message}`);
    return;
  }
  console.log(`[claim] flipped ${todoKw} #${issue} → ${inprogressKw} in ${relFile}:${line}`);
}

function warnOrphanedWorktrees(worktreeDir) {
  const entries = worktreesWithIssue(listWorktreeBranches());
  if (!entries.length) return;
  const root = mainRoot();
  for (const { branch, fruit, issue } of entries) {
    const state = sh(`gh issue view ${issue} --json state -q .state`, true);
    if (!state || !state.trim()) continue;
    if (state.trim().toUpperCase() !== 'CLOSED') continue;
    const wtPath = path.join(root, worktreeDir, core.branchToWorktreeName(branch));
    console.error(
      `[claim] ⚠ stale worktree: "${branch}" references CLOSED issue #${issue}.\n` +
      `         Deferred teardown may have failed. To clean up:\n` +
      `           git worktree remove "${wtPath}" --force\n` +
      `           git branch -D ${branch}`
    );
  }
}

function warnStaleClaimRefs() {
  const listing = sh(`git ls-remote origin 'refs/claims/*' 2>/dev/null`, true);
  if (!listing || !listing.trim()) return;
  for (const line of listing.trim().split('\n')) {
    const [, ref] = line.split('\t');
    const m = /refs\/claims\/issue-(\d+)\b/.exec(ref || '');
    if (!m) continue;
    const issueNum = m[1];
    const stateRaw = sh(`gh issue view ${issueNum} --json state -q .state`, true);
    const issueState = stateRaw && stateRaw.trim() ? stateRaw.trim().toUpperCase() : null;
    if (issueState === 'CLOSED' || issueState === 'MERGED') {
      console.error(
        `[claim] ⚠ stale claim ref refs/claims/issue-${issueNum} (issue #${issueNum} is ${issueState}).\n` +
        `         To sweep:  git push origin :refs/claims/issue-${issueNum}`
      );
    }
  }
}

// --- arg parsing (extends claim_core.parseArgs with pmtools-only flags) ------

function parseArgs(argv) {
  const opts = {
    issue: null, slug: null, as: null, base: 'main', dryRun: false,
    allowStaleMain: false, force: false, custom: false,
    laneCheck: false, copyEnv: false,
    worktreeDir: '.claude/worktrees', roster: null,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--as') opts.as = argv[++i];
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--allow-stale-main') opts.allowStaleMain = true;
    else if (a === '--custom') opts.custom = true;
    else if (a === '--lane-check') opts.laneCheck = true;
    else if (a === '--copy-env') opts.copyEnv = true;
    else if (a === '--worktree-dir') opts.worktreeDir = argv[++i];
    else if (a === '--roster') opts.roster = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--')) die(`unknown flag: ${a}`);
    else positionals.push(a);
  }
  opts.issue = positionals[0];
  opts.slug = positionals[1] || null;
  return opts;
}

function report(roster, fruit, branch, wtPath, base, mode, dry, commentCount, issue) {
  buildBannerLines(fruit, branch, wtPath, base, mode, dry, commentCount, issue, process.env.HOME)
    .forEach((l) => console.log(l));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.issue || !/^\d+$/.test(opts.issue)) {
    die('usage: claim <issue-number> [slug] [--as <fruit>] [--base <ref>] [--dry-run] [--force] ' +
        '[--custom] [--lane-check] [--copy-env] [--worktree-dir <dir>] [--roster a,b,c] [--allow-stale-main]');
  }
  const issue = opts.issue;
  const roster = (opts.roster && opts.roster.length) ? opts.roster : FRUITS;

  const identity = resolveIdentity(opts, process.env, currentBranch());

  if (identity.source === 'auto') {
    die(
      'no agent identity set.\n' +
      '  Corrected command:  claim ' + issue + ' --as <fruit>\n' +
      '  or export CLAUDE_AGENT_NAME=<fruit> before running.\n' +
      '  Auto-naming is disabled — agent names must be assigned by the human orchestrator.'
    );
  }

  // Injection guard (#37): the identity becomes the branch/worktree name and is
  // interpolated into git commands — reject anything but ref-legal characters.
  if (identity.name && !isSafeRef(identity.name)) {
    die(`agent identity "${identity.name}" contains unsafe characters — ` +
        'only letters, digits, and . _ / - are allowed.');
  }

  const nameCheck = checkIdentityName(identity, opts, roster);
  if (nameCheck) console.error(`[claim] note: ${nameCheck.warn}`);

  const info = readIssue(issue);
  if (shouldBlockClaim(info, opts.force)) {
    die(`#${issue} is CLOSED -- nothing to claim. Pass --force to claim it anyway.`);
  }

  // Lane gate (INVERTED from lccjs): OFF by default, only enforced with --lane-check.
  if (opts.laneCheck && shouldBlockUncategorized(info, false)) {
    die(
      `#${issue} has no real area:* label (only area:uncategorized or none). ` +
      `Assign a lane before claiming:\n` +
      `  gh issue edit ${issue} --add-label "area:<name>" --remove-label area:uncategorized\n` +
      `then re-run the claim. To work it uncategorized, drop --lane-check.`);
  }

  let slug = opts.slug ? slugify(opts.slug) : null;
  if (!slug && info && info.title) slug = slugify(info.title);

  const base = opts.base;
  // Injection guard (#37): base is interpolated into git rev-parse / worktree add.
  if (!isSafeRef(base)) {
    die(`base ref "${base}" contains unsafe characters — ` +
        'only letters, digits, and . _ / - are allowed.');
  }
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], true) === null) {
    die(`base ref "${base}" does not resolve — pass --base <ref> (e.g. origin/main).`);
  }

  if (!opts.allowStaleMain) {
    sh('git fetch origin main --quiet', true);
    const behind = Number((sh('git rev-list --count main..origin/main', true) || '').trim()) || 0;
    if (assessBaseStaleness(base, behind).stale) {
      die(`local main is ${behind} commit(s) behind origin/main — run \`git pull --ff-only origin main\` first, then re-claim (pass --allow-stale-main to override).`);
    }
  }

  warnOrphanedWorktrees(opts.worktreeDir);
  warnStaleClaimRefs();

  const existingWt = findLiveWorktreeForIssue(worktreesWithIssue(listWorktreeBranches()), Number(issue));
  if (existingWt) {
    const detail =
      `issue #${issue} is already live in worktree "${existingWt.branch}" (agent: ${existingWt.fruit || 'unknown'}).\n` +
      `  cd into the existing worktree, or pass --force to claim anyway.`;
    if (shouldBlockWorktreeGuard(existingWt, opts)) die(detail);
    console.error(`[claim] ⚠ live worktree detected: ${detail}`);
  }

  const root = mainRoot();
  const { project, lang } = resolveNameParts(root);
  const mkBranch = (fruit) => core.buildBranch({ agent: fruit, project, lang, issue, slug });
  const mkPath = (fruit) => path.join(root, opts.worktreeDir, core.buildWorktreeName({ agent: fruit, project, lang, issue }));

  // Candidate order: forced identity = single candidate; auto walks the roster
  // minus takenFruits, with a `${roster[0]}-2` fallback when all are taken.
  let candidates;
  if (identity.name) {
    candidates = [identity.name];
  } else {
    const taken = takenFruits();
    candidates = roster.filter((f) => !taken.has(f));
    if (candidates.length === 0) {
      const fallback = `${roster[0]}-2`;
      console.error(`[claim] all ${roster.length} roster names are checked out — falling back to "${fallback}".`);
      candidates = [fallback];
    }
  }

  if (opts.dryRun) {
    const fruit = candidates[0];
    const dryCommentCount = (info && info.commentCount) || 0;
    console.log('[claim] --dry-run — nothing staked.');
    report(roster, fruit, mkBranch(fruit), mkPath(fruit), base, identity.modeLabel, true, dryCommentCount, issue);
    return;
  }

  for (const fruit of candidates) {
    const branch = mkBranch(fruit);
    const wtPath = mkPath(fruit);

    if (branchExists(branch)) {
      if (identity.name) {
        die(`branch ${branch} already exists — issue #${issue} is already claimed under "${fruit}". ` +
            `cd into ${wtPath}, or claim a different issue.`);
      }
      continue; // auto: lost the (fruit,issue) race, try next
    }

    const ok = git(['worktree', 'add', wtPath, '-b', branch, base], true);
    if (ok === null) {
      if (identity.name) die(`git worktree add failed for ${branch} (see git output).`);
      continue;
    }

    // auto-mode same-fruit rollback: a different <fruit>/* branch now exists.
    if (!identity.name) {
      const sameFruit = listWorktreeBranches().filter((b) => b.fruit === fruit);
      if (sameFruit.length > 1) {
        console.error(`[claim] race: "${fruit}" was taken by another agent — rolling back and retrying.`);
        git(['worktree', 'remove', wtPath, '--force'], true);
        git(['branch', '-D', branch], true);
        continue;
      }
    }

    // Same-issue TOCTOU rollback (applies even to --as / --force-able). --force bypasses.
    if (!opts.force) {
      const collision = findSameIssueCollision(
        worktreesWithIssue(listWorktreeBranches()), Number(issue), branch);
      if (collision) {
        git(['worktree', 'remove', wtPath, '--force'], true);
        git(['branch', '-D', branch], true);
        die(`issue #${issue} was claimed concurrently in worktree "${collision.branch}" ` +
            `(agent: ${collision.fruit || 'unknown'}) — rolled back "${branch}". ` +
            `cd into the existing worktree, or claim a different issue (pass --force to override).`);
      }
    }

    // Cross-clone claim ref: fabricate a per-agent-unique commit off the base
    // tree and push it to refs/claims/issue-<N>. classifyClaimPushResult →
    // claimPushAction decides CONFLICT(rollback+die) / TRANSIENT(warn) / OK.
    const baseTree = (git(['rev-parse', `${base}^{tree}`], true) || '').trim();
    if (baseTree) {
      const stamp = `${new Date().toISOString()}.${process.hrtime.bigint()}`;
      const claimMsg = buildClaimMessage(issue, branch, process.pid, stamp);
      const claimSha = (git(['commit-tree', baseTree, '-m', claimMsg], true) || '').trim();
      if (claimSha) {
        const pushOut = gitCapture(['push', 'origin', `${claimSha}:refs/claims/issue-${issue}`]);
        const action = claimPushAction(classifyClaimPushResult(pushOut), opts.force);
        if (action === 'ROLLBACK_DIE') {
          git(['worktree', 'remove', wtPath, '--force'], true);
          git(['branch', '-D', branch], true);
          die(`issue #${issue} is already claimed in another clone ` +
              `(cross-clone collision on refs/claims/issue-${issue}) — rolled back "${branch}". ` +
              `cd into that clone's worktree, claim a different issue, or pass --force to override.`);
        } else if (action === 'WARN_PROCEED') {
          console.error(`[claim] ⚠ could not confirm a cross-clone claim for #${issue} ` +
                        `(remote unreachable/auth — best-effort) — proceeding.`);
        }
      }
    }

    // .env copy is opt-in (--copy-env), unlike lccjs which always copies.
    if (opts.copyEnv) {
      const rootEnv = path.join(root, '.env');
      if (fs.existsSync(rootEnv)) {
        try { fs.copyFileSync(rootEnv, path.join(wtPath, '.env')); } catch (_) { /* best-effort */ }
      }
    }

    if (!identity.name) createSessionSentinel(fruit);

    flipMarker(issue, wtPath);
    report(roster, fruit, branch, wtPath, base, identity.modeLabel, false, (info && info.commentCount) || 0, issue);
    return;
  }

  die('could not claim a worktree — every candidate was taken or staking failed.');
}

if (require.main === module) main();

module.exports = { parseArgs, mainRoot, listWorktreeBranches, takenFruits, readIssue };
