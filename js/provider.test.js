// Provider-seam parity tests (#40). node:test, mirrors py/test_provider.py.
//
// The two ports must expose the same provider surface. This pins issueTitle on
// both providers so the asymmetry #40 fixed (py lacked issue_title) cannot
// silently return.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { GitHubProvider, GitLabProvider, parseIssueStateRow, parseIssueListRows } = require('./provider');

// parseIssueListRows: pure mapping of a `gh issue list --json number,state,labels`
// payload (a JSON array) to reconcile-ready rows (#88). Tested with canned JSON.
test('parseIssueListRows: maps a list payload to rows (labels flattened, count defaults 0)', () => {
  const out = JSON.stringify([
    { number: 5, state: 'OPEN', labels: [{ name: 'blocked' }, { name: 'bug' }] },
    { number: 6, state: 'OPEN', labels: [{ name: 'blocked' }] },
  ]);
  assert.deepStrictEqual(parseIssueListRows(out), [
    { number: 5, state: 'OPEN', labels: ['blocked', 'bug'], blockedByCount: 0 },
    { number: 6, state: 'OPEN', labels: ['blocked'], blockedByCount: 0 },
  ]);
});

test('parseIssueListRows: null / garbage / empty → [] (offline-tolerant)', () => {
  assert.deepStrictEqual(parseIssueListRows(null), []);
  assert.deepStrictEqual(parseIssueListRows('not json'), []);
  assert.deepStrictEqual(parseIssueListRows('[]'), []);
});

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
