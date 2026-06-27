// Render tests for the JS status port. Mirrors py/test_status.py.
// Run: node --test js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderTable } = require('./status');

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
