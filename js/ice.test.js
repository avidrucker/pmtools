// Wrapper-level tests for the ice CLI (#102), twin of py/test_ice.py: score
// (batch + --auto + dry-run), list, export — gh provider FAKED, store_cfg passed
// directly (no gh, no orchestrate.json). Run: node --test 'js/*.test.js'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ice = require('./ice');
const iceCore = require('./ice_core');
const store = require('./store');

const ENABLED = { enabled: true, csvMirror: null };
const die = (msg) => { throw new Error(msg); };

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmtools-icecli-')), 'ice.db');
}

class FakeProvider {
  constructor({ titles = {}, states = {}, listing = [] } = {}) {
    this._titles = titles; this._states = states; this._listing = listing;
    this.added = []; this.removed = []; this.comments = []; // set-tier write log (#112)
  }
  issueTitle(n) { return this._titles[n] ?? null; }
  issueStates(nums) { const o = {}; for (const n of nums) o[n] = this._states[n] || {}; return o; }
  listOpenIssuesWithLabels() { return this._listing; }
  addLabel(n, l) { this.added.push([n, l]); return true; }
  removeLabel(n, l) { this.removed.push([n, l]); return true; }
  createComment(n, body) { this.comments.push([n, body]); return true; }
}

function run(argv, db, provider, cfg = ENABLED) {
  const a = ice.parse(argv);
  if (a.cmd === 'score') return ice.cmdScore(a, db, cfg, die, provider);
  if (a.cmd === 'list') return ice.cmdList(a, db, cfg, die);
  if (a.cmd === 'set-tier') return ice.cmdSetTier(a, db, cfg, die, provider);
  return ice.cmdExport(a, db, cfg, die);
}

test('ice score: batch upsert + re-score replaces (no append)', () => {
  const db = tmpDb();
  const prov = new FakeProvider({ titles: { 5: 'Five' }, states: { 5: { labels: ['severity:low'] } } });
  run(['score', '{"5":{"I":1,"C":0.8,"E":5}}'], db, prov);
  let rows = store.selectAll(db, 'ice');
  assert.equal(store.count(db, 'ice'), 1);
  assert.equal(rows[0].issue, 5);
  assert.equal(rows[0].ice_score, 4.0);
  assert.equal(rows[0].title, 'Five');
  assert.equal(rows[0].labels, 'severity:low');
  assert.equal(rows[0].provisional, 0);
  run(['score', '{"5":{"I":2,"C":0.8,"E":5}}'], db, prov);
  rows = store.selectAll(db, 'ice');
  assert.equal(store.count(db, 'ice'), 1);
  assert.equal(rows[0].ice_score, 8.0);
});

test('ice score: priority label sets tier', () => {
  const db = tmpDb();
  const prov = new FakeProvider({ states: { 9: { labels: ['priority:critical'] } } });
  run(['score', '{"9":{"I":1,"C":1.0,"E":10}}'], db, prov);
  assert.equal(store.selectAll(db, 'ice')[0].tier, 'critical');
});

test('ice score --auto: provisional from labels', () => {
  const db = tmpDb();
  const prov = new FakeProvider({ listing: [{ number: 7, title: 'Seven', labels: ['severity:high'] }] });
  run(['score', '--auto'], db, prov);
  const rows = store.selectAll(db, 'ice');
  assert.equal(rows[0].issue, 7);
  assert.equal(rows[0].provisional, 1);
  assert.equal(rows[0].ice_score, 8.0); // I=2,C=0.8,E=5
});

test('ice score --auto: skips already-scored', () => {
  const db = tmpDb();
  store.upsert(db, 'ice', { issue: 7, ice_score: 1.0 });
  const prov = new FakeProvider({ listing: [{ number: 7, title: 'x', labels: ['severity:high'] }] });
  run(['score', '--auto'], db, prov);
  assert.equal(store.selectAll(db, 'ice')[0].ice_score, 1.0);
});

test('ice score --auto --dry-run: writes nothing', () => {
  const db = tmpDb();
  const prov = new FakeProvider({ listing: [{ number: 7, title: 'x', labels: ['research'] }] });
  run(['score', '--auto', '--dry-run'], db, prov);
  assert.equal(store.count(db, 'ice'), 0);
});

test('ice export: ranked CSV with ICE_CSV_COLS header + preamble', () => {
  const db = tmpDb();
  store.upsert(db, 'ice', { issue: 10, ice_score: 2.0 });
  store.upsert(db, 'ice', { issue: 20, ice_score: 5.0 });
  const csv = tmpDb().replace('.db', '.csv');
  run(['export', '--csv', csv], db, new FakeProvider());
  const lines = fs.readFileSync(csv, 'utf8').split('\n');
  assert.ok(lines[0].includes('AUTO-GENERATED'));
  assert.equal(lines[1], iceCore.ICE_CSV_COLS.join(','));
  assert.ok(lines[2].startsWith('20,')); // higher score ranks first
});

test('ice list --json: ranked', () => {
  const db = tmpDb();
  store.upsert(db, 'ice', { issue: 10, ice_score: 2.0 });
  store.upsert(db, 'ice', { issue: 20, ice_score: 5.0 });
  const orig = console.log;
  let captured = '';
  console.log = (s) => { captured += s; };
  try { run(['list', '--json'], db, new FakeProvider()); } finally { console.log = orig; }
  const ranked = JSON.parse(captured);
  assert.equal(ranked[0].issue, 20);
  assert.equal(ranked[0].ice_rank, 1);
});

test('ice: disabled store is a no-op', () => {
  const db = tmpDb();
  run(['score', '{"5":{"I":1,"C":0.8,"E":5}}'], db, new FakeProvider(), { enabled: false, csvMirror: null });
  assert.equal(store.count(db, 'ice'), 0);
});

test('ice: unknown flag throws (usage)', () => {
  assert.throws(() => ice.parse(['score', '--bogus']));
});

// --- set-tier (#112) ---

function silent(fn) {
  const orig = console.log; let out = '';
  console.log = (s) => { out += `${s}\n`; };
  try { fn(); } finally { console.log = orig; }
  return out;
}

test('ice set-tier critical: applies label, stores tier, posts audit comment', () => {
  const db = tmpDb();
  const prov = new FakeProvider({ states: { 42: { labels: [] } } });
  silent(() => run(['set-tier', 'critical', '--issue', '42', '--as', 'honeydew',
    '--why', 'SLA breach', '--until', '2026-08-01'], db, prov));
  assert.deepEqual(prov.added, [[42, 'priority:critical']]);
  assert.deepEqual(prov.removed, []);
  assert.equal(prov.comments.length, 1);
  assert.match(prov.comments[0][1], /Who:\*\* honeydew/);
  assert.match(prov.comments[0][1], /Why:\*\* SLA breach/);
  const row = store.selectAll(db, 'ice').find((r) => r.issue === 42);
  assert.equal(row.tier, 'critical');
});

test('ice set-tier critical: swaps out an existing elevated label', () => {
  const db = tmpDb();
  const prov = new FakeProvider({ states: { 7: { labels: ['priority:elevated'] } } });
  silent(() => run(['set-tier', 'critical', '--issue', '7', '--as', 'a',
    '--why', 'w', '--until', 'u'], db, prov));
  assert.deepEqual(prov.added, [[7, 'priority:critical']]);
  assert.deepEqual(prov.removed, [[7, 'priority:elevated']]);
});

test('ice set-tier none: clears the override and stores empty tier', () => {
  const db = tmpDb();
  const prov = new FakeProvider({ states: { 9: { labels: ['priority:critical'] } } });
  silent(() => run(['set-tier', 'none', '--issue', '9'], db, prov));
  assert.deepEqual(prov.removed, [[9, 'priority:critical']]);
  assert.deepEqual(prov.added, []);
  assert.equal(store.selectAll(db, 'ice').find((r) => r.issue === 9).tier, '');
});

test('ice set-tier: preserves an existing row I/C/E (read-merge-write)', () => {
  const db = tmpDb();
  const prov = new FakeProvider({ titles: { 5: 'Five' }, states: { 5: { labels: ['severity:low'] } } });
  silent(() => run(['score', '{"5":{"I":2,"C":0.8,"E":5}}'], db, prov));
  silent(() => run(['set-tier', 'critical', '--issue', '5', '--as', 'a',
    '--why', 'w', '--until', 'u'], db, prov));
  const row = store.selectAll(db, 'ice').find((r) => r.issue === 5);
  assert.equal(row.tier, 'critical');
  assert.equal(row.ice_score, 8.0);  // I=2,C=0.8,E=5 preserved
  assert.equal(row.title, 'Five');
});

test('ice set-tier critical: missing --why is a usage error', () => {
  const db = tmpDb();
  assert.throws(() => run(['set-tier', 'critical', '--issue', '1', '--as', 'a', '--until', 'u'],
    db, new FakeProvider({ states: { 1: { labels: [] } } })));
});

test('ice set-tier: missing --issue is a usage error', () => {
  const db = tmpDb();
  assert.throws(() => run(['set-tier', 'critical', '--as', 'a', '--why', 'w', '--until', 'u'],
    db, new FakeProvider()));
});

test('ice set-tier: invalid tier is a usage error', () => {
  const db = tmpDb();
  assert.throws(() => run(['set-tier', 'urgent', '--issue', '1'],
    db, new FakeProvider({ states: { 1: { labels: [] } } })));
});
