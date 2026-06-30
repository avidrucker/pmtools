// Host provider adapter — maps issue operations onto the host CLI.
// `github` -> `gh` (implemented). `gitlab` -> `glab` (stub).
// Best-effort: offline/missing CLI degrades to empty (UNKNOWN); never throws.
'use strict';

const { execFileSync } = require('node:child_process');

// A 5s timeout keeps a hung `gh` from blocking the caller — parity with the
// Python provider's _run() timeout (#40). On timeout execFileSync throws, which
// the catch degrades to null (best-effort, same as any other failure).
const RUN_TIMEOUT_MS = 5000;

function run(cmd, args) {
  try {
    return execFileSync(cmd, args,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: RUN_TIMEOUT_MS });
  } catch {
    return null;
  }
}

// Pure: map one `gh issue view --json state,labels,blockedBy` payload (the raw
// stdout string, or null when offline) to a reconcile-ready row, or null when the
// issue is absent / unparseable / not OPEN|CLOSED (→ UNKNOWN). `blockedByCount`
// is the `blockedBy.totalCount` (the active blocked-by relation count, #87).
function parseIssueStateRow(out, number) {
  if (out === null || out === undefined) return null;
  let data;
  try { data = JSON.parse(out); } catch { return null; }
  const state = String(data.state || '').toUpperCase();
  if (state !== 'OPEN' && state !== 'CLOSED') return null;
  const labels = Array.isArray(data.labels) ? data.labels.map((l) => l && l.name) : [];
  const blockedByCount = (data.blockedBy && Number(data.blockedBy.totalCount)) || 0;
  return { number, state, labels, blockedByCount };
}

// Pure: map a `gh issue list --json number,state,labels` payload (a JSON array,
// or null when offline) to reconcile-ready rows (#88). Drops rows whose state is
// not OPEN|CLOSED. `blockedByCount` defaults to 0 (the list query does not fetch
// the relation; label-discovered rows are blocked via their label).
function parseIssueListRows(out) {
  if (out === null || out === undefined) return [];
  let data;
  try { data = JSON.parse(out); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const rows = [];
  for (const item of data) {
    const state = String((item && item.state) || '').toUpperCase();
    if (state !== 'OPEN' && state !== 'CLOSED') continue;
    const labels = Array.isArray(item.labels) ? item.labels.map((l) => l && l.name) : [];
    rows.push({ number: item.number, state, labels, blockedByCount: 0 });
  }
  return rows;
}

class GitHubProvider {
  constructor() { this.name = 'github'; }

  // [{number, state, labels:[<name>...]}] for the given issue numbers
  // (best-effort). `labels` drives the BLOCKED overlay (#78); it rides the same
  // per-issue lookup status already makes, so adding it costs no extra gh calls.
  issueStates(numbers) {
    const rows = [];
    for (const n of numbers) {
      // `blockedBy` rides the same per-issue lookup — one extra json field, no
      // extra gh call — feeding the BLOCKED overlay's relation signal (#87).
      const out = run('gh', ['issue', 'view', String(n), '--json', 'state,labels,blockedBy']);
      const row = parseIssueStateRow(out, n);
      if (row) rows.push(row); // null → offline / not found / non-OPEN|CLOSED → UNKNOWN
    }
    return rows;
  }

  // Open issues carrying a given label — the discovery query for marker-less
  // blocked rows (#88). One `gh issue list` call regardless of count. [] offline.
  listIssuesByLabel(label) {
    return parseIssueListRows(
      run('gh', ['issue', 'list', '--label', String(label), '--state', 'open',
        '--json', 'number,state,labels']),
    );
  }

  // Open issues incl. each issue body — used by the parent-tracker scan
  // (#36 guard 3) to find unchecked checkbox lines. Best-effort: [] offline.
  listOpenIssuesWithBodies(limit) {
    const out = run('gh', ['issue', 'list', '--state', 'open', '--limit', String(limit),
      '--json', 'number,title,body']);
    return out ? JSON.parse(out) : [];
  }

  // Open issues with title + label names — the `ice --auto` sweep source (#102).
  // Returns [{number, title, labels:[name,...]}]. Best-effort: [] offline.
  listOpenIssuesWithLabels(limit) {
    const out = run('gh', ['issue', 'list', '--state', 'open', '--limit', String(limit),
      '--json', 'number,title,labels']);
    if (!out) return [];
    return JSON.parse(out).map((i) => ({
      number: i.number,
      title: i.title,
      labels: (i.labels || []).filter((l) => l && typeof l === 'object').map((l) => l.name),
    }));
  }

  // Write a new issue body via stdin (`gh issue edit <N> --body-file -`). Returns
  // true on success, false on any failure (offline / missing gh / permission).
  // The only provider WRITE; used by the parent-tracker auto-check (#36 guard 3).
  editIssueBody(number, body) {
    try {
      execFileSync('gh', ['issue', 'edit', String(number), '--body-file', '-'],
        { input: body, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  }

  // Best-effort `gh issue view <N> --json title -q .title`. null on failure
  // (offline / missing gh / not found). Mirrors py/velocity.py fetch_title.
  issueTitle(number) {
    const out = run('gh', ['issue', 'view', String(number), '--json', 'title', '-q', '.title']);
    if (out === null) return null;
    const t = out.trim();
    return t || null;
  }
}

class GitLabProvider {
  constructor() { this.name = 'gitlab'; }
  _stub() {
    throw new Error("gitlab adapter not yet implemented — only host:'github' is supported");
  }
  issueStates() { return this._stub(); }
  listIssuesByLabel() { return this._stub(); }
  listOpenIssuesWithBodies() { return this._stub(); }
  editIssueBody() { return this._stub(); }
  issueTitle() { return this._stub(); }
}

function getProvider(host) {
  if (host === 'github') return new GitHubProvider();
  if (host === 'gitlab') return new GitLabProvider();
  throw new Error(`unknown host '${host}' (expected 'github' or 'gitlab')`);
}

module.exports = {
  getProvider, GitHubProvider, GitLabProvider, parseIssueStateRow, parseIssueListRows,
};
