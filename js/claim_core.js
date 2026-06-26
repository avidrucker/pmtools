// Pure claim-core functions, ported faithfully from lccjs scripts/claim.js.
//
// These are the I/O-free decision seams of the `claim` command: identity
// resolution, arg parsing, staleness guards, marker flipping, worktree-collision
// detection, and the cross-clone claim-push classifier. The git/gh side effects
// in claim.js's main() are NOT ported here — only the pure parts, graded against
// the shared fixtures/claim/*.cases.json (the SAME files py/claim_core.py loads).
//
// Parity: every function mirrors its Python twin in py/claim_core.py. No lccjs
// paths leak into this layer — the FRUITS roster is exposed but callers may pass
// their own where relevant.
'use strict';

const FRUITS = [
  'apple', 'banana', 'cherry', 'date', 'dragonfruit', 'elderberry', 'fig', 'grape',
  'honeydew', 'incaberry', 'jackfruit', 'kiwi', 'lemon', 'mango', 'nectarine', 'olive', 'peach',
  'quince', 'raspberry', 'strawberry', 'tangerine', 'ugli', 'vanilla',
  'watermelon', 'ximenia', 'yuzu', 'zucchini',
];

const SESSION_SENTINEL_MAX_AGE_S = 7 * 24 * 60 * 60; // 7 days
const CLAIM_REF_MAX_AGE_S = 2 * 24 * 60 * 60;        // 2 days

const todoKw = '@' + 'todo';
const inprogressKw = '@' + 'inprogress';

// --- injection safety (#37) ------------------------------------------------

// A value is safe to interpolate into a ref/identity position iff it is a
// non-empty string of ref-legal characters only: letters, digits, dot,
// underscore, slash, dash. Every shell metacharacter (`;`, whitespace, `$`,
// backtick, `|`, `&`, `>`, `<`, newline, …) is rejected. This is the
// load-bearing guard behind `--base` + agent identity (claim) and `--branch`
// (close/release); the arg-array exec migration is defense-in-depth on top.
const SAFE_REF_RE = /^[A-Za-z0-9._/-]+$/;
function isSafeRef(s) {
  return typeof s === 'string' && SAFE_REF_RE.test(s);
}

// --- slug / identity -------------------------------------------------------

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-');
}

function normalizeIdentity(s) {
  return String(s).trim().toLowerCase();
}

function inferFruitFromBranch(branch) {
  if (!branch) return null;
  // agent tolerates a `-<N>` collision-fallback suffix (claim's `${roster[0]}-2`), #49.
  const m = branch.match(/^(?:br-)?([a-z0-9]+(?:-[0-9]+)?)\/(?:[a-z0-9]+-[a-z0-9]+-)?issue-\d+/);
  return m ? m[1] : null;
}

// Parse `git ls-remote origin 'refs/claims/*'` output → sorted, unique claimed
// issue numbers. This is the cross-clone-safe in-flight signal: the claim ref
// lives on origin, so it is visible from any clone and independent of any
// clone's `git worktree list` or branch-naming scheme — the gap that let the
// orchestrator double-assign a claimed issue. Pure. (#70)
function parseClaimRefs(listing) {
  const issues = new Set();
  for (const line of String(listing || '').split('\n')) {
    const m = /refs\/claims\/issue-(\d+)\b/.exec(line);
    if (m) issues.add(Number(m[1]));
  }
  return [...issues].sort((a, b) => a - b);
}

function resolveIdentity(opts, env, branch = null) {
  if (opts.as) {
    return { name: normalizeIdentity(opts.as), source: 'as', modeLabel: 'reuse (--as)' };
  }
  const envName = normalizeIdentity(env.CLAUDE_AGENT_NAME || '');
  if (envName) {
    return { name: envName, source: 'env', modeLabel: 'human-directed (env)' };
  }
  const inferredFruit = inferFruitFromBranch(branch);
  if (inferredFruit) {
    return { name: inferredFruit, source: 'branch', modeLabel: 'branch-inferred' };
  }
  return { name: null, source: 'auto', modeLabel: 'auto' };
}

// JS claim.js calls die() on an unknown --flag; here we throw so the behavior
// stays testable for valid inputs while still rejecting unknown flags loudly.
function parseArgs(argv) {
  const opts = {
    issue: null, slug: null, as: null, base: 'main', dryRun: false,
    allowStaleMain: false, force: false, custom: false, allowUncategorized: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--as') opts.as = argv[++i] !== undefined ? argv[i] : null;
    else if (a === '--base') opts.base = argv[++i] !== undefined ? argv[i] : null;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--allow-stale-main') opts.allowStaleMain = true;
    else if (a === '--allow-uncategorized' || a === '--no-lane-check') opts.allowUncategorized = true;
    else if (a === '--custom') opts.custom = true;
    else if (a.startsWith('--')) throw new Error('unknown flag: ' + a);
    else positionals.push(a);
  }
  opts.issue = positionals[0] !== undefined ? positionals[0] : null;
  opts.slug = positionals[1] !== undefined ? positionals[1] : null;
  return opts;
}

function checkIdentityName(identity, opts, fruits = FRUITS) {
  if (!identity.name || fruits.includes(identity.name.toLowerCase())) return null;
  return { warn: `"${identity.name}" is not in the known fruit list — using it anyway.` };
}

// --- staleness / base guards ----------------------------------------------

function assessBaseStaleness(base, behind) {
  const checksRemote = base === 'main' || base === 'refs/heads/main';
  const n = Number(behind) || 0;
  return { checksRemote, behind: n, stale: checksRemote && n > 0 };
}

function sentinelBranch(fruit) {
  return `${fruit}/session`;
}

function isSentinelStaleByAge(commitTs, nowS, maxAgeS = SESSION_SENTINEL_MAX_AGE_S) {
  if (!Number.isFinite(commitTs)) return true;
  return (nowS - commitTs) > maxAgeS;
}

// --- marker flip -----------------------------------------------------------

function applyMarkerFlip(content, issue) {
  const re = new RegExp(`${todoKw}(\\s+#${issue}:\\s*\\d+\\w*\\/[A-Z]+)`);
  const match = content.match(re);
  if (!match) return { updated: content, flipped: false, line: 0 };
  const updated = content.replace(re, `${inprogressKw}$1`);
  const line = content.slice(0, content.indexOf(match[0])).split('\n').length;
  return { updated, flipped: true, line };
}

// --- worktree collision seams ---------------------------------------------

function worktreesWithIssue(branches) {
  const result = [];
  for (const entry of (branches || [])) {
    const branch = entry.branch;
    const fruit = entry.fruit;
    const m = branch && branch.match(/[-/]issue-(\d+)/);
    if (m) result.push({ branch, fruit, issue: Number(m[1]) });
  }
  return result;
}

function findLiveWorktreeForIssue(entries, issueNum) {
  return entries.find((w) => w.issue === issueNum) || null;
}

function findSameIssueCollision(entries, issueNum, ownBranch) {
  return (entries || []).find((w) => w.issue === issueNum && w.branch !== ownBranch) || null;
}

function shouldBlockWorktreeGuard(existingWt, opts) {
  if (!existingWt) return false;
  return !opts.force && !opts.dryRun;
}

// --- issue-state guards ----------------------------------------------------

function shouldBlockClaim(info, force) {
  if (force) return false;
  return !!(info && info.state === 'CLOSED');
}

function needsAreaLabel(labels) {
  if (!Array.isArray(labels)) return false;
  const areas = labels.filter((l) => typeof l === 'string' && l.startsWith('area:'));
  if (areas.length === 0) return true;
  return areas.includes('area:uncategorized');
}

function shouldBlockUncategorized(info, allow) {
  if (allow) return false;
  return !!(info && needsAreaLabel(info.labels));
}

// --- cross-clone claim push ------------------------------------------------

function classifyClaimPushResult(output) {
  const s = String(output || '');
  if (/\[new reference\]|Everything up-to-date|\bnew branch\b/i.test(s)) return 'OK';
  const CONFLICT = [
    /\[rejected\]/i,
    /non-fast-forward/i,
    /\bfetch first\b/i,
    /cannot lock ref/i,
    /failed to push some refs/i,
    /tip of your current branch is behind/i,
  ];
  if (CONFLICT.some((re) => re.test(s))) return 'CONFLICT';
  const TRANSIENT = [
    /could not resolve host/i,
    /couldn't resolve host/i,
    /connection refused/i,
    /connection timed out/i,
    /operation timed out/i,
    /\btimed out\b/i,
    /network is unreachable/i,
    /unable to access/i,
    /could not read from remote/i,
    /permission denied/i,
    /authentication failed/i,
    /\b403\b/,
    /no such remote|does not appear to be a git repository|no configured push destination/i,
  ];
  if (TRANSIENT.some((re) => re.test(s))) return 'TRANSIENT';
  if (s.trim() === '') return 'OK';
  return 'TRANSIENT';
}

function buildClaimMessage(issue, branch, pid, stamp) {
  return `claim issue-${issue} ${branch} pid=${pid} ${stamp}`;
}

function claimPushAction(verdict, force) {
  if (force) return 'PROCEED';
  if (verdict === 'CONFLICT') return 'ROLLBACK_DIE';
  if (verdict === 'TRANSIENT') return 'WARN_PROCEED';
  return 'PROCEED';
}

function claimRefIsStale({ issueState, claimCommitTs, nowS, ttl = CLAIM_REF_MAX_AGE_S }) {
  const state = issueState == null ? '' : String(issueState).trim().toUpperCase();
  if (state === '') return false;
  if (state === 'CLOSED' || state === 'MERGED') return true;
  if (state === 'OPEN') {
    return Number.isFinite(claimCommitTs) ? (nowS - claimCommitTs) > ttl : false;
  }
  return false;
}

// --- banner ----------------------------------------------------------------

// `home` parameterizes the HOME path used to shorten wtPath to `~` (claim.js
// reads process.env.HOME). When home is null/undefined, no shortening is done.
function buildBannerLines(fruit, branch, wtPath, base, mode, dry, commentCount, issue, home) {
  const short = home ? wtPath.split(home).join('~') : wtPath;
  const bar = '─'.repeat(58);
  const lines = [
    bar,
    `  ${dry ? 'WOULD CLAIM' : 'CLAIMED'}  ·  agent: ${fruit}  (${mode})`,
    bar,
    `  branch    ${branch}`,
    `  worktree  ${short}`,
    `  base      ${base}`,
  ];
  if (commentCount != null && commentCount > 0) {
    lines.push(`  comments  ${commentCount} — read them: gh issue view ${issue} --comments`);
  }
  if (!dry) {
    lines.push('');
    lines.push('  next:');
    lines.push(`    cd ${short}`);
    lines.push(`    # (claim already flipped the ${todoKw} #N marker to ${inprogressKw} #N if one was found)`);
    lines.push('    # reuse this identity for later worktrees:  pmtools claim <issue> --as ' + fruit);
  }
  lines.push(bar);
  lines.push(`CLAIM ${dry ? 'DRYRUN' : 'OK'} agent=${fruit} branch=${branch} path=${wtPath}`);
  return lines;
}

// --- self-describing naming scheme (br-/wt- prefixes) -----------------------
// Short language tags for the <lang> field. Sensible default map; unknown
// languages pass through lowercased + alnum-only; empty/null -> 'unk'. Extend freely.
const LANG_TAGS = {
  javascript: 'js', typescript: 'ts', python: 'py', clojure: 'clj',
  java: 'java', ruby: 'rb', go: 'go', rust: 'rs', c: 'c', 'c++': 'cpp',
  cpp: 'cpp', csharp: 'cs', php: 'php', shell: 'sh', bash: 'sh',
};

function langTag(language) {
  const key = String(language || '').trim().toLowerCase();
  if (!key) return 'unk';
  if (LANG_TAGS[key]) return LANG_TAGS[key];
  const slug = key.replace(/[^a-z0-9]/g, '');
  return slug || 'unk';
}

// branch       = br-<agent>/<project>-<lang>-issue-<N>[-<slug>]
function buildBranch({ agent, project, lang, issue, slug }) {
  const tail = slug ? `-${slug}` : '';
  return `br-${agent}/${project}-${lang}-issue-${issue}${tail}`;
}

// worktree dir = wt-<agent>-<project>-<lang>-issue-<N>  (slug never in the dir name)
function buildWorktreeName({ agent, project, lang, issue }) {
  return `wt-${agent}-${project}-${lang}-issue-${issue}`;
}

// Map a branch (new OR legacy) to its worktree dir name — the back-compat bridge
// close uses to find the worktree it must tear down. New `br-…/…` -> `wt-…`;
// legacy `<fruit>/issue-N…` -> `<fruit>-issue-N` (no prefix). Drops the theme tail.
function branchToWorktreeName(branch) {
  if (!branch) return null;
  const isNew = branch.startsWith('br-');
  const core = isNew ? branch.slice(3) : branch;
  const flat = core.replace('/', '-').replace(/(issue-\d+).*$/, '$1');
  return isNew ? `wt-${flat}` : flat;
}

module.exports = {
  FRUITS, SESSION_SENTINEL_MAX_AGE_S, CLAIM_REF_MAX_AGE_S,
  isSafeRef,
  langTag, buildBranch, buildWorktreeName, branchToWorktreeName,
  slugify, normalizeIdentity, inferFruitFromBranch, parseClaimRefs, resolveIdentity, parseArgs,
  checkIdentityName, assessBaseStaleness, sentinelBranch, isSentinelStaleByAge,
  applyMarkerFlip, worktreesWithIssue, findLiveWorktreeForIssue, findSameIssueCollision,
  shouldBlockWorktreeGuard, shouldBlockClaim, needsAreaLabel, shouldBlockUncategorized,
  classifyClaimPushResult, buildClaimMessage, claimPushAction, claimRefIsStale,
  buildBannerLines,
};
