#!/usr/bin/env node
// pmtools status — reconcile @todo/@inprogress markers vs worktrees + issues.
// Usage: status.js [--strict] [--json] [--host github|gitlab]
//                  [--branch-pattern <regex>] [--limit N]
// Exit 0 always, except --strict with >=1 STALE marker -> exit 1.
'use strict';

const { execFileSync } = require('node:child_process');
const { reconcile } = require('./reconcile');
const { getProvider } = require('./provider');

const DEFAULT_BRANCH_PATTERN = '^(?<agent>[a-z]+)/issue-(?<issue>\\d+)';
const MARKER_RE = /@(todo|inprogress)\b/i;
const ISSUE_RE = /#(\d+)/;

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function grepMarkers() {
  const out = run('git', ['grep', '-nE', '@(todo|inprogress)']);
  const markers = [];
  for (const raw of out.split('\n')) {
    if (!raw) continue;
    const idx1 = raw.indexOf(':');
    const idx2 = raw.indexOf(':', idx1 + 1);
    if (idx1 < 0 || idx2 < 0) continue;
    const file = raw.slice(0, idx1);
    const line = raw.slice(idx1 + 1, idx2);
    const content = raw.slice(idx2 + 1);
    const km = MARKER_RE.exec(content);
    const im = ISSUE_RE.exec(content);
    if (!km || !im) continue; // only issue-linked markers
    markers.push({
      file,
      line: parseInt(line, 10),
      keyword: '@' + km[1].toLowerCase(),
      issue: parseInt(im[1], 10),
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
  const grep = grepMarkers();
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
