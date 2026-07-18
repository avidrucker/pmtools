// Host provider adapter — maps issue operations onto the host CLI.
// `github` -> `gh` (implemented). `gitlab` -> `glab` (stub).
// Best-effort: offline/missing CLI degrades to empty (UNKNOWN); never throws.
'use strict';

const { execFileSync } = require('node:child_process');

// A 5s timeout keeps a hung `gh` from blocking the caller — parity with the
// Python provider's _run() timeout (#40). On timeout execFileSync throws, which
// the catch degrades to null (best-effort, same as any other failure).
const RUN_TIMEOUT_MS = 5000;

// The `--limit` for the batched `gh issue list` that backs issueStates (#42).
// Generous enough to cover a typical board in one call; any requested number the
// batch misses (older than the window, or offline) falls back to a per-issue view,
// so this bounds the fast path, not correctness.
const BATCH_LIST_LIMIT = 200;

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

// Pure: map a BATCHED `gh issue list --state all --json number,state,labels,blockedBy`
// payload (a JSON array, or null offline) to reconcile-ready rows (#42). Unlike
// parseIssueListRows this KEEPS blockedByCount — the batched issueStates replaces the
// per-view path, so the BLOCKED overlay's relation signal (#87) must survive. Drops
// rows whose state is not OPEN|CLOSED. Shape-identical to parseIssueStateRow's rows.
function parseIssueStateRows(out) {
  if (out === null || out === undefined) return [];
  let data;
  try { data = JSON.parse(out); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const rows = [];
  for (const item of data) {
    if (!item) continue;
    const state = String(item.state || '').toUpperCase();
    if (state !== 'OPEN' && state !== 'CLOSED') continue;
    const labels = Array.isArray(item.labels) ? item.labels.map((l) => l && l.name) : [];
    const blockedByCount = (item.blockedBy && Number(item.blockedBy.totalCount)) || 0;
    rows.push({ number: item.number, state, labels, blockedByCount });
  }
  return rows;
}

// Pure: split the requested numbers against the batch rows (#42) — return the batch
// rows that were actually requested, plus the requested numbers the batch MISSED
// (offline, beyond --limit, or genuinely absent), which the caller then looks up one
// at a time. Keeps the impure issueStates orchestration thin and testable.
function selectStateRows(numbers, batchRows) {
  const requested = new Set(numbers);
  const rows = (batchRows || []).filter((r) => r && requested.has(r.number));
  const have = new Set(rows.map((r) => r.number));
  const missing = (numbers || []).filter((n) => !have.has(n));
  return { rows, missing };
}

// Pure: parse the new issue NUMBER from `gh issue create`'s stdout — it prints the
// created issue's URL, e.g. `https://github.com/o/r/issues/42`. Reads the last
// non-empty line and takes the `/issues/<N>` segment. null when unparseable /
// offline. (#111)
function parseCreatedIssueNumber(out) {
  if (out === null || out === undefined) return null;
  const line = String(out).trim().split('\n').filter(Boolean).pop() || '';
  const m = line.match(/\/issues\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

class GitHubProvider {
  constructor() { this.name = 'github'; }

  // [{number, state, labels:[<name>...], blockedByCount}] for the given issue
  // numbers (best-effort). Batched (#42): ONE `gh issue list --state all` replaces
  // the former N serial `gh issue view` round-trips. `--state all` (not open) so a
  // CLOSED issue is reported CLOSED — status's STALE reconcile and the stale-claim
  // sweep depend on that; --state open would leave it merely absent. Any requested
  // number the batch misses (older than the window, or offline) falls back to a
  // per-issue view, so no signal is lost. `labels` + `blockedBy` feed the BLOCKED
  // overlay (#78/#87). Empty input short-circuits — no gh call.
  issueStates(numbers) {
    if (!numbers || !numbers.length) return [];
    const batch = parseIssueStateRows(run('gh',
      ['issue', 'list', '--state', 'all', '--limit', String(BATCH_LIST_LIMIT),
        '--json', 'number,state,labels,blockedBy']));
    const { rows, missing } = selectStateRows(numbers, batch);
    for (const n of missing) {
      const row = parseIssueStateRow(
        run('gh', ['issue', 'view', String(n), '--json', 'state,labels,blockedBy']), n);
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

  // --- Write-seam born for `ice set-tier` (#112); reused by no-code close and
  //     `pmtools file`. Each returns true on success, false on ANY failure
  //     (offline / missing gh / permission) — fail-soft, never throws. ---

  // Apply a label (`gh issue edit <N> --add-label <L>`).
  addLabel(number, label) {
    try {
      execFileSync('gh', ['issue', 'edit', String(number), '--add-label', String(label)],
        { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch { return false; }
  }

  // Remove a label (`gh issue edit <N> --remove-label <L>`).
  removeLabel(number, label) {
    try {
      execFileSync('gh', ['issue', 'edit', String(number), '--remove-label', String(label)],
        { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch { return false; }
  }

  // Post a comment via stdin (`gh issue comment <N> --body-file -`).
  createComment(number, body) {
    try {
      execFileSync('gh', ['issue', 'comment', String(number), '--body-file', '-'],
        { input: body, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch { return false; }
  }

  // Close an issue outright (`gh issue close <N>`). Used by no-code close (#113) —
  // a comment-only ticket has no `Closes #N` commit to auto-close it.
  closeIssue(number) {
    try {
      execFileSync('gh', ['issue', 'close', String(number)],
        { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch { return false; }
  }

  // Create an issue (`gh issue create --title T --body-file - --label L …`, body
  // via stdin). Returns the new issue NUMBER (int), or null on any failure. The
  // serialized create + number read-back structurally prevents the concurrent-
  // create number race (pycats#541). Used by `pmtools file` (#111).
  createIssue(title, body, labels) {
    const args = ['issue', 'create', '--title', String(title), '--body-file', '-'];
    for (const l of (labels || [])) args.push('--label', String(l));
    try {
      const out = execFileSync('gh', args,
        { input: body || '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      return parseCreatedIssueNumber(out);
    } catch { return null; }
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
  addLabel() { return this._stub(); }
  removeLabel() { return this._stub(); }
  createComment() { return this._stub(); }
  closeIssue() { return this._stub(); }
  createIssue() { return this._stub(); }
}

function getProvider(host) {
  if (host === 'github') return new GitHubProvider();
  if (host === 'gitlab') return new GitLabProvider();
  throw new Error(`unknown host '${host}' (expected 'github' or 'gitlab')`);
}

module.exports = {
  getProvider, GitHubProvider, GitLabProvider,
  parseIssueStateRow, parseIssueListRows, parseIssueStateRows, selectStateRows,
  parseCreatedIssueNumber,
};
