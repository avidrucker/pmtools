#!/usr/bin/env node
// pmtools status — reconcile @todo/@inprogress markers vs worktrees + issues.
// Usage: status.js [--strict] [--json] [--host github|gitlab]
//                  [--branch-pattern <regex>] [--limit N]
// Exit 0 always, except --strict with >=1 STALE marker -> exit 1.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { reconcile } = require('./reconcile');
const { getProvider } = require('./provider');
const { parseCanonicalMarker, parsePddignore, isPddIgnored, filterOpenClaims,
  parseArgs: coreParseArgs } = require('./status_core');
const { parseClaimRefs } = require('./claim_core');
const { loadPddConfig } = require('./config');
const { makeDie } = require('./sh');
const { parseWorktreePorcelain } = require('./close_core');

// agent tolerates a `-<N>` collision-fallback suffix (claim's `${roster[0]}-2`), #49.
const DEFAULT_BRANCH_PATTERN = '^(?:br-)?(?<agent>[a-z0-9]+(?:-[0-9]+)?)/(?:[a-z0-9]+-[a-z0-9]+-)?issue-(?<issue>\\d+)';

// Match the other fleet CLIs (claim/close/error/velocity): a bad flag is a loud
// failure, not a silent no-op. exit 1 (the shared bad-arg code; #44 may later
// move all usage errors to 2 — keep both ports identical here, #39).
const die = makeDie('status');

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

// Impure: read the repo-root <ignoreFile> (gitignore-style globs) into a pattern
// list. Absent file → [] (+ a one-line stderr warn when warnIfAbsent, so an
// enabled-but-unconfigured repo knows it is scanning everything). #15 honors the
// ignore file; #16 makes the whole scan toggle-able via pdd.enabled.
function loadIgnorePatterns(ignoreFile = '.pddignore', warnIfAbsent = false) {
  const root = run('git', ['rev-parse', '--show-toplevel']).trim();
  if (!root) return [];
  try {
    return parsePddignore(fs.readFileSync(path.join(root, ignoreFile), 'utf8'));
  } catch {
    if (warnIfAbsent) {
      process.stderr.write(`[status] pdd enabled but no ${ignoreFile} — scanning all tracked files.\n`);
    }
    return [];
  }
}

// Scan for canonical PDD markers, honoring .pddignore. A grep hit counts only
// when (a) its file is not .pddignore-excluded and (b) its text is a canonical
// `@(todo|inprogress) #N:<estimate>` marker — incidental prose and estimate-less
// mentions are dropped (the #1458 flood fix).
// `rawOut` is injectable (#46): pass canned `git grep` output to unit-test the
// parsing + .pddignore filter without shelling out; null → run git for real.
function grepMarkers(ignorePatterns = [], rawOut = null) {
  const out = rawOut !== null ? rawOut : run('git', ['grep', '-nE', '@(todo|inprogress)']);
  const markers = [];
  for (const raw of out.split('\n')) {
    if (!raw) continue;
    const idx1 = raw.indexOf(':');
    const idx2 = raw.indexOf(':', idx1 + 1);
    if (idx1 < 0 || idx2 < 0) continue;
    const file = raw.slice(0, idx1);
    if (isPddIgnored(file, ignorePatterns)) continue;
    const parsed = parseCanonicalMarker(raw.slice(idx2 + 1));
    if (!parsed) continue;
    markers.push({
      file,
      line: parseInt(raw.slice(idx1 + 1, idx2), 10),
      keyword: parsed.keyword,
      issue: parsed.issue,
    });
  }
  return markers;
}

// `porcelain` is injectable (#46): pass canned `git worktree list --porcelain`
// to unit-test the branch-pattern extraction; null → run git for real.
function listWorktrees(branchPattern, porcelain = null) {
  const rx = new RegExp(branchPattern);
  // Reuse the canonical pure porcelain parser (#74); keep status's regex
  // extraction of issue/agent + null-safety (parser tolerates null/empty).
  if (porcelain === null) porcelain = run('git', ['worktree', 'list', '--porcelain']);
  const rows = [];
  for (const { branch } of parseWorktreePorcelain(porcelain)) {
    if (!branch) continue;
    const m = rx.exec(branch);
    if (!m) continue;
    rows.push({ branch, issue: parseInt(m.groups.issue, 10), agent: m.groups.agent });
  }
  return rows;
}

function renderTable(report) {
  const glyph = { IDLE: '·', CLAIMED: '▶', 'IN-PROGRESS': '↻', STALE: '✗' };
  const lines = report.markers.map((m) => {
    const wt = m.worktree ? ` [${m.worktree}]` : '';
    const blocked = m.blocked ? ' ⛔' : ''; // overlay glyph (#78), orthogonal to status
    return `${glyph[m.status] || '?'} #${String(m.issue).padEnd(5)} ${m.status.padEnd(8)} `
      + `${m.state.padEnd(8)} ${m.file}:${m.line} (${m.keyword})${wt}${blocked}`;
  });
  if (report.stale.length) {
    lines.push('', `${report.stale.length} STALE marker(s) — clean up.`);
  }
  return lines.length ? lines.join('\n') : '(no issue-linked markers found)';
}

// Thin impure wrapper over the shared pure parser (status_core, #46): an unknown
// flag throws there; here we turn it into a usage die (exit 2) and substitute
// this port's DEFAULT_BRANCH_PATTERN when none was supplied (the default's
// named-group syntax is port-specific, so it lives here, not in the core).
function parseArgs(argv) {
  let a;
  try { a = coreParseArgs(argv); }
  catch (e) { return die(e.message, 2); }
  if (!a.branchPattern) a.branchPattern = DEFAULT_BRANCH_PATTERN;
  return a;
}

function main(argv) {
  const args = parseArgs(argv);
  // PDD marker scanning is config-gated (#16). When disabled, skip the scan
  // entirely; worktree + issue reconciliation still run.
  const pdd = loadPddConfig();
  let grep = [];
  if (pdd.enabled) {
    grep = grepMarkers(loadIgnorePatterns(pdd.ignoreFile, true));
  } else {
    process.stderr.write('[status] pdd disabled — skipping marker scan.\n');
  }
  const worktrees = listWorktrees(args.branchPattern);
  // An unknown host fails getProvider (usage error, 2); a not-yet-implemented
  // host (gitlab) reaches a stub whose methods throw (operational, 1). Either
  // way: a clean die, never a raw stack trace (#43).
  let provider;
  try {
    provider = getProvider(args.host);
  } catch {
    die(`unknown host '${args.host}' (expected github or gitlab)`, 2);
  }
  const numbers = [...new Set(grep.map((m) => m.issue))].sort((x, y) => x - y);
  let issues;
  try {
    issues = provider.issueStates(numbers);
  } catch {
    die(`host '${args.host}' not yet supported`, 1);
  }

  const report = reconcile(grep, worktrees, issues);
  // Active claims (refs/claims/* on origin): the cross-clone-safe in-flight
  // signal an orchestrator should consume instead of git-worktree-list heuristics,
  // which miss sibling-clone worktrees and the br-/wt- naming scheme (#70).
  const claimNumbers = parseClaimRefs(run('git', ['ls-remote', 'origin', 'refs/claims/*']));
  // Drop stale CLOSED claim refs so the in-flight signal is claims ∩ ¬CLOSED
  // (#81): a hand-closed issue leaves a dangling ref the sweep (#71) only clears
  // on the next claim. Reuse the marker-issue states already fetched; look up
  // only the claim issues whose state we don't yet know. Host is guaranteed
  // github here (a gitlab/unknown host already died above).
  let claimStates = issues;
  const knownStates = new Set(issues.map((s) => s.number));
  const unknownClaims = claimNumbers.filter((n) => !knownStates.has(n));
  if (unknownClaims.length) claimStates = issues.concat(provider.issueStates(unknownClaims));
  report.claims = filterOpenClaims(claimNumbers, claimStates);
  console.log(args.json ? JSON.stringify(report, null, 2) : renderTable(report));
  return args.strict && report.stale.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
module.exports = { main, grepMarkers, listWorktrees, renderTable };
