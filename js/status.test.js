// Render tests for the JS status port. Mirrors py/test_status.py.
// Run: node --test js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderTable, grepMarkers, listWorktrees } = require('./status');
const { reconcile } = require('./reconcile');

// Canned `git grep -nE @(todo|inprogress)` output (format "file:line:content").
// The injected 2nd arg lets us exercise grepMarkers' parsing + .pddignore filter
// without shelling out to git (#46).
const CANNED_GREP =
  'js/foo.js:10:  // @todo #42:30 do the thing\n'
  + 'docs/skip.md:3:  // @todo #99:15m should be ignored\n'
  + 'bar.py:5:  not a canonical marker here\n'
  + 'baz.js:20:// @inprogress #7:45 wip\n';

test('grepMarkers (canned git output): keeps canonical markers, drops prose, honors .pddignore', () => {
  const markers = grepMarkers(['docs/**'], CANNED_GREP);
  assert.deepEqual(markers, [
    { file: 'js/foo.js', line: 10, keyword: '@todo', issue: 42 },
    { file: 'baz.js', line: 20, keyword: '@inprogress', issue: 7 },
  ]);
});

test('grepMarkers (canned git output): empty output → no markers', () => {
  assert.deepEqual(grepMarkers([], ''), []);
});

// Canned `git worktree list --porcelain`: a main checkout (no issue- branch), an
// agent worktree, and a detached one (null branch). Only the agent worktree
// whose branch matches the pattern should survive.
const CANNED_PORCELAIN =
  'worktree /repo/main\nHEAD aaa\nbranch refs/heads/main\n\n'
  + 'worktree /repo/.claude/worktrees/grape-issue-22\nHEAD bbb\nbranch refs/heads/grape/issue-22\n\n'
  + 'worktree /repo/detached\nHEAD ccc\ndetached\n';

test('listWorktrees (canned porcelain): extracts agent/issue from matching branches only', () => {
  const rows = listWorktrees('^(?<agent>[a-z]+)/issue-(?<issue>\\d+)', CANNED_PORCELAIN);
  assert.deepEqual(rows, [{ branch: 'grape/issue-22', issue: 22, agent: 'grape' }]);
});

// Schema snapshot for `status --json` (#46): locks the serialized report shape
// (reconcile output + the claims field status.main attaches) so a field rename
// or drop is caught. Builds the report the way main() does, then round-trips it
// through JSON to assert the documented top-level + per-marker key sets.
test('status --json schema: top-level keys are {markers, stale, claims} with documented per-marker fields', () => {
  const report = reconcile(
    [{ file: 'a.js', line: 1, keyword: '@todo', issue: 5 }],
    [{ branch: 'grape/issue-5', issue: 5, agent: 'grape' }],
    [{ number: 5, state: 'OPEN', labels: ['blocked'] }],
  );
  report.claims = [5]; // the cross-clone in-flight signal main() appends (#70/#81)

  const json = JSON.parse(JSON.stringify(report, null, 2));
  assert.deepEqual(Object.keys(json).sort(), ['claims', 'markers', 'stale']);
  assert.deepEqual(
    Object.keys(json.markers[0]).sort(),
    ['blocked', 'file', 'issue', 'keyword', 'line', 'state', 'status', 'worktree'],
  );
  assert.equal(typeof json.claims[0], 'number');
  assert.ok(Array.isArray(json.stale));
});

test('renderTable: a blocked row carries the ⛔ overlay glyph; a non-blocked row does not (#78)', () => {
  const report = {
    markers: [
      { issue: 5, file: 'a.py', line: 1, keyword: '@todo', state: 'OPEN', worktree: null, status: 'IDLE', blocked: true },
      { issue: 6, file: 'b.py', line: 2, keyword: '@todo', state: 'OPEN', worktree: null, status: 'IDLE', blocked: false },
    ],
    stale: [],
  };
  const lines = renderTable(report).split('\n');
  assert.match(lines[0], /⛔/, 'blocked row should show the ⛔ overlay');
  assert.doesNotMatch(lines[1], /⛔/, 'non-blocked row should not show ⛔');
});
