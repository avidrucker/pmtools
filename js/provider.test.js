// Provider-seam parity tests (#40). node:test, mirrors py/test_provider.py.
//
// The two ports must expose the same provider surface. This pins issueTitle on
// both providers so the asymmetry #40 fixed (py lacked issue_title) cannot
// silently return.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  GitHubProvider, GitLabProvider,
  parseIssueStateRow, parseIssueListRows, parseIssueStateRows, selectStateRows,
} = require('./provider');

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

// parseIssueStateRows: the BATCHED plural mapping of a `gh issue list --state all
// --json number,state,labels,blockedBy` array to reconcile-ready rows (#42). Unlike
// parseIssueListRows it KEEPS blockedByCount (the batched issueStates replaces the
// per-view path, so the BLOCKED overlay's relation signal must survive, #87).
test('parseIssueStateRows: maps a list payload, keeping blockedByCount + both states', () => {
  const out = JSON.stringify([
    { number: 5, state: 'OPEN', labels: [{ name: 'blocked' }], blockedBy: { totalCount: 3 } },
    { number: 6, state: 'CLOSED', labels: [{ name: 'bug' }] },
  ]);
  assert.deepStrictEqual(parseIssueStateRows(out), [
    { number: 5, state: 'OPEN', labels: ['blocked'], blockedByCount: 3 },
    { number: 6, state: 'CLOSED', labels: ['bug'], blockedByCount: 0 },
  ]);
});

test('parseIssueStateRows: drops non-OPEN|CLOSED rows; null/garbage/empty → [] (offline)', () => {
  const out = JSON.stringify([
    { number: 1, state: 'OPEN', labels: [] },
    { number: 2, state: 'DRAFT', labels: [] },
  ]);
  assert.deepStrictEqual(parseIssueStateRows(out),
    [{ number: 1, state: 'OPEN', labels: [], blockedByCount: 0 }]);
  assert.deepStrictEqual(parseIssueStateRows(null), []);
  assert.deepStrictEqual(parseIssueStateRows('not json'), []);
  assert.deepStrictEqual(parseIssueStateRows('{}'), []);
});

// selectStateRows: pure filter+fallback decision for the batched issueStates (#42).
// Given the requested numbers and the batch rows, return the rows that matched and
// the requested numbers the batch MISSED (which get a per-view fallback lookup).
test('selectStateRows: filters batch to requested, reports the missing set for fallback', () => {
  const batch = [
    { number: 5, state: 'OPEN', labels: [], blockedByCount: 0 },
    { number: 6, state: 'CLOSED', labels: [], blockedByCount: 0 },
    { number: 8, state: 'OPEN', labels: [], blockedByCount: 0 }, // not requested → excluded
  ];
  const { rows, missing } = selectStateRows([5, 7, 6], batch);
  assert.deepStrictEqual(rows, [
    { number: 5, state: 'OPEN', labels: [], blockedByCount: 0 },
    { number: 6, state: 'CLOSED', labels: [], blockedByCount: 0 },
  ]);
  assert.deepStrictEqual(missing, [7]);
});

test('selectStateRows: empty batch → nothing matched, everything missing (offline path)', () => {
  assert.deepStrictEqual(selectStateRows([3, 4], []), { rows: [], missing: [3, 4] });
});

test('GitHubProvider exposes issueTitle (parity with py issue_title)', () => {
  assert.strictEqual(typeof new GitHubProvider().issueTitle, 'function');
});

test('GitLabProvider stubs issueTitle (throws not-implemented)', () => {
  assert.throws(() => new GitLabProvider().issueTitle(123), /not yet implemented/);
});

// parseCreatedIssueNumber: pure mapping of `gh issue create` stdout (a URL) → the
// new issue number (#111). null on unparseable/offline.
const { parseCreatedIssueNumber } = require('./provider');

test('parseCreatedIssueNumber: reads /issues/<N> from the created-issue URL', () => {
  assert.strictEqual(parseCreatedIssueNumber('https://github.com/o/r/issues/42'), 42);
  assert.strictEqual(parseCreatedIssueNumber('Creating issue\nhttps://github.com/o/r/issues/1360\n'), 1360);
});

test('parseCreatedIssueNumber: null / garbage → null (offline-tolerant)', () => {
  assert.strictEqual(parseCreatedIssueNumber(null), null);
  assert.strictEqual(parseCreatedIssueNumber(''), null);
  assert.strictEqual(parseCreatedIssueNumber('no url here'), null);
});

test('GitHubProvider exposes createIssue + closeIssue (parity with py)', () => {
  const p = new GitHubProvider();
  assert.strictEqual(typeof p.createIssue, 'function');
  assert.strictEqual(typeof p.closeIssue, 'function');
});

test('GitLabProvider stubs createIssue (throws not-implemented)', () => {
  assert.throws(() => new GitLabProvider().createIssue('t', 'b', []), /not yet implemented/);
});
