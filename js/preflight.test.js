// Unit tests for preflight's pure functions. Run: node --test 'js/*.test.js'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { preflightIssueGate, preflightEvidence } = require('./preflight');

test('issue gate: OPEN proceeds, CLOSED blocks, offline warns', () => {
  assert.equal(preflightIssueGate('OPEN').ok, true);
  assert.equal(preflightIssueGate('open').ok, true);

  const closed = preflightIssueGate('CLOSED');
  assert.equal(closed.ok, false);
  assert.match(closed.error, /not OPEN/);

  const offline = preflightIssueGate(null);
  assert.equal(offline.ok, true);
  assert.match(offline.warn, /gh unavailable/);
});

test('evidence match is anchored to <N>- prefix (no substring false hits)', () => {
  const files = ['docs/logs/76-investigation.md', 'docs/logs/1076-other.md'];
  const hits = preflightEvidence('see #76 for context', files);
  assert.deepEqual(hits, ['docs/logs/76-investigation.md']); // not 1076-*
});

test('evidence dirs are parameterized (custom dir honored)', () => {
  const files = ['notes/42-spike.md'];
  const hits = preflightEvidence('ref #42', files, ['notes']);
  assert.deepEqual(hits, ['notes/42-spike.md']);
});

test('default evidence dirs ignore files outside docs/logs|research', () => {
  const files = ['src/42-thing.md'];
  assert.deepEqual(preflightEvidence('ref #42', files), []);
});
