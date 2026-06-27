// Golden-fixture test for the JS reconcile port. See ../CONTRACT.md.
// Run: node --test js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { reconcile } = require('./reconcile');

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

test('basic fixture matches golden output', () => {
  const input = load('basic.input.json');
  const expected = load('basic.expected.json');
  const result = reconcile(input.grep, input.worktrees, input.issues);
  assert.deepEqual(result, expected);
});

test('inprogress fixture: @inprogress + live worktree → IN-PROGRESS (#77)', () => {
  // Distinct from a @todo CLAIMED; @inprogress with no worktree stays STALE.
  const input = load('inprogress.input.json');
  const expected = load('inprogress.expected.json');
  const result = reconcile(input.grep, input.worktrees, input.issues);
  assert.deepEqual(result, expected);
});

test('blocked fixture: `blocked` label → blocked:true overlay, orthogonal to status (#78)', () => {
  // 202 is IN-PROGRESS *and* blocked:true — the overlay is independent of the
  // lifecycle status; a non-blocked row carries blocked:false (not the true case only).
  const input = load('blocked.input.json');
  const expected = load('blocked.expected.json');
  const result = reconcile(input.grep, input.worktrees, input.issues);
  assert.deepEqual(result, expected);
});

test('blocked-by fixture: a `blocked-by` relation (blockedByCount>0) sets blocked:true with no label (#87)', () => {
  // 300 has no `blocked` label but blockedByCount:2 → blocked:true; 301 has
  // neither → blocked:false. The overlay now reflects the relation, not just the label.
  const input = load('blocked-by-relation.input.json');
  const expected = load('blocked-by-relation.expected.json');
  const result = reconcile(input.grep, input.worktrees, input.issues);
  assert.deepEqual(result, expected);
});

test('markerless-blocked fixture: blocked issues with no marker append as synthetic BLOCKED rows (#88)', () => {
  // 300 already has a marker → no synthetic dupe; 400 (with worktree) and 401
  // (no worktree) are marker-less blocked → synthetic rows appended after markers,
  // status BLOCKED, null file/line/keyword.
  const input = load('markerless-blocked.input.json');
  const expected = load('markerless-blocked.expected.json');
  const result = reconcile(input.grep, input.worktrees, input.issues, input.blockedIssues);
  assert.deepEqual(result, expected);
});

test('strict helper counts stale', () => {
  const input = load('basic.input.json');
  const result = reconcile(input.grep, input.worktrees, input.issues);
  assert.equal(result.stale.length, 2);
});
