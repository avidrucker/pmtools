// Host provider adapter — maps issue operations onto the host CLI.
// `github` -> `gh` (implemented). `gitlab` -> `glab` (stub).
// Best-effort: offline/missing CLI degrades to empty (UNKNOWN); never throws.
'use strict';

const { execFileSync } = require('node:child_process');

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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

  listOpenIssues(limit) {
    const out = run('gh', ['issue', 'list', '--state', 'open', '--limit', String(limit),
      '--json', 'number,title,labels']);
    return out ? JSON.parse(out) : [];
  }

  createLabel(name, color, description, repo) {
    const args = ['label', 'create', name, '--color', color, '--description', description, '--force'];
    if (repo) args.splice(2, 0, '-R', repo);
    return run('gh', args) !== null;
  }
}

class GitLabProvider {
  constructor() { this.name = 'gitlab'; }
  _stub() {
    throw new Error("gitlab adapter not yet implemented — only host:'github' is supported");
  }
  issueStates() { return this._stub(); }
  listOpenIssues() { return this._stub(); }
  createLabel() { return this._stub(); }
}

function getProvider(host) {
  if (host === 'github') return new GitHubProvider();
  if (host === 'gitlab') return new GitLabProvider();
  throw new Error(`unknown host '${host}' (expected 'github' or 'gitlab')`);
}

module.exports = { getProvider, GitHubProvider, GitLabProvider };
