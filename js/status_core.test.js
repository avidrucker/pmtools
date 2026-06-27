// Golden-fixture parity tests for the pure status core (#15). Run: node --test 'js/*.test.js'
//
// Loads the SAME fixtures/status/<fn>.cases.json files the Python harness grades,
// dispatches each snake_case stem to the camelCase function, and asserts
// deepEqual(fn(...args), expected). 1:1 dispatch ↔ fixture invariant enforced.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./status_core');

const ROOT = path.resolve(__dirname, '..');
const STATUS_FIXTURES = path.join(ROOT, 'fixtures', 'status');
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const DISPATCH = {
  parse_canonical_marker: core.parseCanonicalMarker,
  parse_pddignore: core.parsePddignore,
  is_pdd_ignored: core.isPddIgnored,
  filter_open_claims: core.filterOpenClaims,
  is_blocked: core.isBlocked,
  parse_args: core.parseArgs,
};

test('every status fixture file has a dispatch entry (1:1)', () => {
  const stems = fs.readdirSync(STATUS_FIXTURES)
    .filter((f) => f.endsWith('.cases.json'))
    .map((f) => f.replace('.cases.json', ''))
    .sort();
  assert.deepEqual(stems, Object.keys(DISPATCH).sort());
});

for (const [stem, fn] of Object.entries(DISPATCH)) {
  const cases = load(path.join(STATUS_FIXTURES, `${stem}.cases.json`));
  for (const c of cases) {
    test(`status:${stem} — ${c.name}`, () => {
      if (c.expected_error) assert.throws(() => fn(...c.args));
      else assert.deepEqual(fn(...c.args), c.expected);
    });
  }
}
