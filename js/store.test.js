// Regression tests for the IMPURE sqlite engine's connect() dedup-gating (#10).
//
// A pre-existing ("legacy") DB whose velocity table holds duplicate
// (ticket, agent, started_iso) rows must NOT be rendered unloggable: connect()
// runs on every write to EITHER store, so the velocity unique index must be
// dedup-gated (detect dups -> skip + warn) rather than abort all logging.
//
//   node --test 'js/*.test.js'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const store = require('./store');

function tmpDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmtools-store-'));
  return path.join(dir, name);
}

function sqlite(db, sql) {
  return execFileSync('sqlite3', [db], { input: sql, encoding: 'utf8' }).trim();
}

function hasUqIndex(db) {
  return sqlite(db,
    "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_velocity_session';");
}

// A *legacy* velocity DB: the velocity table WITHOUT the unique index, holding
// duplicate (ticket, agent, started_iso) rows — the exact #10 starting state.
function seedLegacyDupDb() {
  const db = tmpDb('legacy.db');
  sqlite(db, store.CREATE_VELOCITY + '\n'
    + "INSERT INTO velocity (ticket, agent, started_iso) "
    + "VALUES (1,'X','2026-01-01T00:00:00-1000');\n"
    + "INSERT INTO velocity (ticket, agent, started_iso) "
    + "VALUES (1,'X','2026-01-01T00:00:00-1000');");
  return db;
}

function captureWarn(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

test('#10 errors logging is NOT aborted by a legacy DB with duplicate velocity rows', () => {
  const db = seedLegacyDupDb();
  let id;
  captureWarn(() => {
    id = store.insert(db, 'errors', { occurred_iso: '2026-01-01T00:00:00-1000', message: 'x' });
  });
  assert.ok(Number.isFinite(id) && id > 0, 'errors insert must succeed against a legacy dup DB');
});

test('#10 velocity logging still inserts against a legacy dup DB (no abort)', () => {
  const db = seedLegacyDupDb();
  let id;
  captureWarn(() => {
    id = store.insert(db, 'velocity', { ticket: 2, agent: 'Y', started_iso: '2026-02-02T00:00:00-1000' });
  });
  assert.ok(Number.isFinite(id) && id > 0, 'velocity insert must succeed against a legacy dup DB');
});

test('#10 connect() dedup-gates: skips uq_velocity_session while dups exist, and warns', () => {
  const db = seedLegacyDupDb();
  const warnings = captureWarn(() => store.connect(db));
  assert.equal(hasUqIndex(db), '', 'unique index must stay absent while dups exist');
  assert.ok(warnings.some((w) => /uq_velocity_session/.test(w)),
    'must warn that the index was skipped');
});

test('connect() on a fresh DB DOES create uq_velocity_session (no regression)', () => {
  const db = tmpDb('fresh.db');
  store.connect(db);
  assert.equal(hasUqIndex(db), 'uq_velocity_session');
});

test('connect() on a fresh DB still enforces the unique session constraint', () => {
  const db = tmpDb('fresh2.db');
  const row = { ticket: 3, agent: 'Z', started_iso: '2026-03-03T00:00:00-1000' };
  store.insert(db, 'velocity', row);
  assert.throws(() => store.insert(db, 'velocity', row), /UNIQUE/,
    'a fresh DB carries the index, so a duplicate session must be rejected');
});
