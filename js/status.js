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
const { parseCanonicalMarker, parsePddignore, isPddIgnored } = require('./status_core');
const { loadPddConfig } = require('./config');

const DEFAULT_BRANCH_PATTERN = '^(?:br-)?(?<agent>[a-z0-9]+)/(?:[a-z0-9]+-[a-z0-9]+-)?issue-(?<issue>\\d+)';

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
function grepMarkers(ignorePatterns = []) {
  const out = run('git', ['grep', '-nE', '@(todo|inprogress)']);
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

function listWorktrees(branchPattern) {
  const rx = new RegExp(branchPattern);
  const out = run('git', ['worktree', 'list', '--porcelain']);
  const rows = [];
  for (const raw of out.split('\n')) {
    if (!raw.startsWith('branch ')) continue;
    const branch = raw.slice('branch '.length).trim().replace('refs/heads/', '');
    const m = rx.exec(branch);
    if (!m) continue;
    rows.push({ branch, issue: parseInt(m.groups.issue, 10), agent: m.groups.agent });
  }
  return rows;
}

function renderTable(report) {
  const glyph = { IDLE: '·', CLAIMED: '▶', STALE: '✗' };
  const lines = report.markers.map((m) => {
    const wt = m.worktree ? ` [${m.worktree}]` : '';
    return `${glyph[m.status] || '?'} #${String(m.issue).padEnd(5)} ${m.status.padEnd(8)} `
      + `${m.state.padEnd(8)} ${m.file}:${m.line} (${m.keyword})${wt}`;
  });
  if (report.stale.length) {
    lines.push('', `${report.stale.length} STALE marker(s) — clean up.`);
  }
  return lines.length ? lines.join('\n') : '(no issue-linked markers found)';
}

function parseArgs(argv) {
  const a = { strict: false, json: false, host: 'github',
    branchPattern: DEFAULT_BRANCH_PATTERN, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--strict') a.strict = true;
    else if (t === '--json') a.json = true;
    else if (t === '--host') a.host = argv[++i];
    else if (t === '--branch-pattern') a.branchPattern = argv[++i];
    else if (t === '--limit') a.limit = parseInt(argv[++i], 10);
  }
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
  const provider = getProvider(args.host);
  const numbers = [...new Set(grep.map((m) => m.issue))].sort((x, y) => x - y);
  const issues = provider.issueStates(numbers);

  const report = reconcile(grep, worktrees, issues);
  console.log(args.json ? JSON.stringify(report, null, 2) : renderTable(report));
  return args.strict && report.stale.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
module.exports = { main, grepMarkers, listWorktrees };
