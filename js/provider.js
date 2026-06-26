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

class GitHubProvider {
  constructor() { this.name = 'github'; }

  issueStates(numbers) {
    const rows = [];
    for (const n of numbers) {
      const out = run('gh', ['issue', 'view', String(n), '--json', 'state', '-q', '.state']);
      if (out === null) continue; // offline / not found -> UNKNOWN
      const state = out.trim().toUpperCase();
      if (state === 'OPEN' || state === 'CLOSED') rows.push({ number: n, state });
    }
    return rows;
  }

  // Open issues incl. each issue body — used by the parent-tracker scan
  // (#36 guard 3) to find unchecked checkbox lines. Best-effort: [] offline.
  listOpenIssuesWithBodies(limit) {
    const out = run('gh', ['issue', 'list', '--state', 'open', '--limit', String(limit),
      '--json', 'number,title,body']);
    return out ? JSON.parse(out) : [];
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
  listOpenIssuesWithBodies() { return this._stub(); }
  editIssueBody() { return this._stub(); }
  issueTitle() { return this._stub(); }
}

function getProvider(host) {
  if (host === 'github') return new GitHubProvider();
  if (host === 'gitlab') return new GitLabProvider();
  throw new Error(`unknown host '${host}' (expected 'github' or 'gitlab')`);
}

module.exports = { getProvider, GitHubProvider, GitLabProvider };
