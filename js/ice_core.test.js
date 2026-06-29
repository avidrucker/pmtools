// Golden-fixture parity tests for the pure ICE core. Run: node --test 'js/*.test.js'
//
// Loads the SAME fixtures/ice/<fn>.cases.json the Python harness
// (py/test_ice_core.py) grades. Dispatches each snake_case stem to the camelCase
// function; "expected_error": true asserts a throw, else deepEqual. The dispatch
// map must match the fixture files 1:1 (same invariant as the Python harness).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./ice_core');

const ROOT = path.resolve(__dirname, '..');
const ICE_FIXTURES = path.join(ROOT, 'fixtures', 'ice');
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const ICE_DISPATCH = {
  compute_ice: core.computeIce,
  rank_rows: core.rankRows,
  derive_auto_score: core.deriveAutoScore,
  validate_ice_row: core.validateIceRow,
};

function fixtureStems(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.cases.json'))
    .map((f) => f.replace('.cases.json', ''))
    .sort();
}

test('ice: fixture files and dispatch map match 1:1', () => {
  assert.deepEqual(fixtureStems(ICE_FIXTURES), Object.keys(ICE_DISPATCH).sort());
});

for (const [stem, fn] of Object.entries(ICE_DISPATCH)) {
  const cases = load(path.join(ICE_FIXTURES, `${stem}.cases.json`));
  for (const c of cases) {
    test(`ice:${stem} — ${c.name}`, () => {
      if (c.expected_error) {
        assert.throws(() => fn(...c.args));
      } else {
        assert.deepEqual(fn(...c.args), c.expected);
      }
    });
  }
}

test('ice_core constants shape', () => {
  assert.equal(core.ICE_COLS[0], 'id');
  assert.equal(core.ICE_COLS[1], 'issue');
  assert.ok(core.ICE_CSV_COLS.includes('ice_rank'));
  assert.ok(!core.ICE_COLS.includes('ice_rank'));
  assert.ok(!core.ICE_CSV_COLS.includes('id'));
});
