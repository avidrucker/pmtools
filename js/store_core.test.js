// Golden-fixture parity tests for the pure store core. Run: node --test 'js/*.test.js'
//
// Loads the SAME fixtures/{error,velocity}/<fn>.cases.json files the Python
// harness (py/test_store_core.py) grades. Dispatches each fixture stem
// (snake_case) to the corresponding camelCase function. For cases marked
// "expected_error": true it asserts the call throws; otherwise it asserts
// deepEqual(fn(...args), expected). The dispatch map must match the fixture
// files 1:1 (same invariant as the Python harness).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./store_core');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const ERROR_FIXTURES = path.join(FIXTURES, 'error');
const VELOCITY_FIXTURES = path.join(FIXTURES, 'velocity');
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// fixture stem (snake_case) -> pure callable (camelCase)
const ERROR_DISPATCH = {
  validate_error_row: core.validateErrorRow,
  csv_encode_row: core.csvEncodeRow,
};
const VELOCITY_DISPATCH = {
  validate_velocity_row: core.validateVelocityRow,
  derive_delta: core.deriveDelta,
  csv_encode_row: core.csvEncodeRow,
};

function fixtureStems(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.cases.json'))
    .map((f) => f.replace('.cases.json', ''))
    .sort();
}

function runSuite(label, dir, dispatch) {
  test(`${label}: fixture files and dispatch map match 1:1`, () => {
    assert.deepEqual(fixtureStems(dir), Object.keys(dispatch).sort());
  });

  for (const [stem, fn] of Object.entries(dispatch)) {
    const cases = load(path.join(dir, `${stem}.cases.json`));
    for (const c of cases) {
      test(`${label}:${stem} — ${c.name}`, () => {
        if (c.expected_error) {
          assert.throws(() => fn(...c.args));
        } else {
          assert.deepEqual(fn(...c.args), c.expected);
        }
      });
    }
  }
}

runSuite('error', ERROR_FIXTURES, ERROR_DISPATCH);
runSuite('velocity', VELOCITY_FIXTURES, VELOCITY_DISPATCH);

// Constant-shape invariants (mirror py TestStoreCoreConstants).
test('store_core constants match the schema vocabularies', () => {
  assert.equal(core.ERROR_COLS[0], 'id');
  assert.ok(core.ERROR_COLS.includes('occurred_iso'));
  assert.equal(core.ERROR_COLS.length, 10);

  assert.equal(core.VELOCITY_COLS[0], 'id');
  assert.ok(core.VELOCITY_COLS.includes('delta_h_min'));
  assert.equal(core.VELOCITY_COLS.length, 16);

  assert.ok(core.ERROR_TYPES.includes('CLAIM_FAIL'));
  assert.ok(core.ERROR_TYPES.includes('BEHAVIORAL_FAIL'));
  assert.equal(core.ERROR_TYPES.length, 17);

  assert.ok(core.VALID_ROLES.includes('DEV'));
  assert.ok(core.VALID_ROLES.includes('REVIEW'));
  assert.equal(core.VALID_ROLES.length, 11);

  assert.ok(core.csvPreamble('/x/y.db').includes('AUTO-GENERATED'));
  assert.ok(core.csvPreamble('/x/y.db').includes('/x/y.db'));
});
