// Provider-seam parity tests (#40). node:test, mirrors py/test_provider.py.
//
// The two ports must expose the same provider surface. This pins issueTitle on
// both providers so the asymmetry #40 fixed (py lacked issue_title) cannot
// silently return.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { GitHubProvider, GitLabProvider, parseIssueStateRow } = require('./provider');

// parseIssueStateRow: pure mapping of a `gh issue view --json state,labels,blockedBy`
// payload to a reconcile-ready row (#87). Tested with canned JSON, no gh shell-out.
test('parseIssueStateRow: surfaces blockedByCount from the blockedBy.totalCount field', () => {
  const out = JSON.stringify({ state: 'OPEN', labels: [{ name: 'bug' }], blockedBy: { nodes: [], totalCount: 2 } });
  assert.deepStrictEqual(parseIssueStateRow(out, 7),
    { number: 7, state: 'OPEN', labels: ['bug'], blockedByCount: 2 });
});

test('parseIssueStateRow: blockedByCount defaults to 0 when blockedBy is absent', () => {
  const out = JSON.stringify({ state: 'CLOSED', labels: [] });
  assert.deepStrictEqual(parseIssueStateRow(out, 9),
    { number: 9, state: 'CLOSED', labels: [], blockedByCount: 0 });
});

test('parseIssueStateRow: null/garbage/non-open-closed → null (dropped, UNKNOWN)', () => {
  assert.strictEqual(parseIssueStateRow(null, 1), null);
  assert.strictEqual(parseIssueStateRow('not json', 1), null);
  assert.strictEqual(parseIssueStateRow(JSON.stringify({ state: 'DRAFT' }), 1), null);
});

test('GitHubProvider exposes issueTitle (parity with py issue_title)', () => {
  assert.strictEqual(typeof new GitHubProvider().issueTitle, 'function');
});

test('GitLabProvider stubs issueTitle (throws not-implemented)', () => {
  assert.throws(() => new GitLabProvider().issueTitle(123), /not yet implemented/);
});
