// Golden-fixture parity tests for the pure preflight core. Run: node --test 'js/*.test.js'
//
// Loads the SAME fixtures/preflight/{issue_gate,evidence}.cases.json the Python
// harness grades, and asserts deepEqual(fn(...args), expected).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { preflightIssueGate, preflightEvidence } = require('./preflight');

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'preflight');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const DISPATCH = {
  issue_gate: preflightIssueGate,
  evidence: preflightEvidence,
};

for (const [stem, fn] of Object.entries(DISPATCH)) {
  const cases = load(`${stem}.cases.json`);
  for (const c of cases) {
    test(`preflight:${stem} — ${c.name}`, () => {
      assert.deepEqual(fn(...c.args), c.expected);
    });
  }
}
