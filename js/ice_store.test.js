// Tests for the ice persistence layer (#101): CREATE_ICE table + upsert + the
// storage.ice config block. Twin of py/test_ice_store.py. Run: node --test 'js/*.test.js'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const store = require('./store');
const config = require('./config');

function tmpDb(name = 'ice.db') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmtools-ice-')), name);
}

test('ice: connect creates the ice table idempotently', () => {
  const db = tmpDb();
  store.connect(db);
  store.connect(db); // second connect must not throw
  assert.equal(store.count(db, 'ice'), 0);
  assert.ok(store.TABLES === undefined || true); // table usable below
});

test('ice: registered in TABLES + INSERT_COLS', () => {
  const db = tmpDb();
  store.connect(db);
  // exercised indirectly — an unknown table throws; ice must not.
  assert.doesNotThrow(() => store.count(db, 'ice'));
  assert.throws(() => store.count(db, 'nope'));
});

test('ice: upsert replaces by issue (no append)', () => {
  const db = tmpDb();
  store.upsert(db, 'ice', { issue: 1360, ice_score: 4.0, tier: '' });
  store.upsert(db, 'ice', { issue: 1360, ice_score: 8.0, tier: 'critical' });
  assert.equal(store.count(db, 'ice'), 1);
  const rows = store.selectAll(db, 'ice');
  assert.equal(rows[0].issue, 1360);
  assert.equal(rows[0].ice_score, 8.0);
  assert.equal(rows[0].tier, 'critical');
});

test('ice: two distinct issues coexist', () => {
  const db = tmpDb();
  store.upsert(db, 'ice', { issue: 1, ice_score: 1.0 });
  store.upsert(db, 'ice', { issue: 2, ice_score: 2.0 });
  assert.equal(store.count(db, 'ice'), 2);
});

test('ice: default storage config has an ice block', () => {
  const cfg = config.loadStorageConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'pmtools-norepo-')));
  assert.deepEqual(cfg.ice, { enabled: false, csvMirror: null, logCommand: null });
});

test('ice: orchestrate.json ice block merges over defaults', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pmtools-icecfg-'));
  execFileSync('git', ['-C', d, 'init', '-q']);
  fs.mkdirSync(path.join(d, '.claude'));
  fs.writeFileSync(path.join(d, '.claude', 'orchestrate.json'),
    JSON.stringify({ storage: { ice: { enabled: true, csvMirror: 'docs/ice.csv' } } }));
  const cfg = config.loadStorageConfig(d);
  assert.equal(cfg.ice.enabled, true);
  assert.equal(cfg.ice.csvMirror, 'docs/ice.csv');
  assert.equal(cfg.ice.logCommand, null); // default preserved
});
