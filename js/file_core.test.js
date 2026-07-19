// Golden-fixture parity tests for the pure file core (#111). Run: node --test 'js/*.test.js'
//
// Loads the SAME fixtures/file/*.cases.json the Python harness (py/test_file_core.py)
// grades, and asserts deepEqual(fileGateVerdict(...args), expected). The dispatch
// map must match the fixture files 1:1 (same invariant as the other cores).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fileGateVerdict } = require('./file_core');

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'file');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const DISPATCH = { gate_verdict: fileGateVerdict };

test('file: fixture files and dispatch map match 1:1', () => {
  const stems = fs.readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.cases.json'))
    .map((f) => f.replace('.cases.json', ''))
    .sort();
  assert.deepEqual(stems, Object.keys(DISPATCH).sort());
});

for (const [stem, fn] of Object.entries(DISPATCH)) {
  const cases = load(`${stem}.cases.json`);
  for (const c of cases) {
    test(`file:${stem} — ${c.name}`, () => {
      assert.deepEqual(fn(...c.args), c.expected);
    });
  }
}
