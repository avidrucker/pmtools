// Tests for the shared sh.js I/O helpers (#41). node:test, twin of py/test_sh.py.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { sh, shCapture, shTrim, gitCapture, gitTrim, makeDie, makeLog } = require('./sh');

test('sh returns stdout on success', () => {
  assert.strictEqual(sh('printf hi'), 'hi');
});

test('sh returns null on failure when allowFail', () => {
  assert.strictEqual(sh('exit 3', true), null);
});

test('sh throws on failure without allowFail', () => {
  assert.throws(() => sh('exit 3'));
});

test('shCapture returns { ok:true, out } on success', () => {
  assert.deepStrictEqual(shCapture('printf hi'), { ok: true, out: 'hi' });
});

test('shCapture returns { ok:false, out } on failure and never throws', () => {
  const r = shCapture('echo boom >&2; exit 1');
  assert.strictEqual(r.ok, false);
  assert.match(r.out, /boom/);
});

test('shCapture(timeoutSec) kills an over-limit command → { ok:false, timedOut:true } (#107)', () => {
  const t0 = Date.now();
  const r = shCapture('sleep 5', undefined, 1);
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.match(r.out, /timed out after 1s/);
  assert.ok(elapsed < 3000, `killed promptly, got ${elapsed}ms`);
  // Strict group-kill (no orphaned grandchild) is guaranteed by the Python twin
  // (start_new_session + killpg); the JS spawnSync path SIGKILLs the shell child —
  // see CONTRACT.md §close and py/test_sh.py test_sh_capture_timeout_kills_whole_process_group.
});

test('shCapture(timeoutSec) under the limit returns normally, no timedOut (#107)', () => {
  assert.deepStrictEqual(shCapture('printf hi', undefined, 5), { ok: true, out: 'hi' });
});

test('shTrim returns a trimmed string, "" on failure', () => {
  assert.strictEqual(shTrim('echo "  hi  "'), 'hi');
  assert.strictEqual(shTrim('exit 1'), '');
});

test('gitCapture returns { ok:true, out } for a succeeding git command', () => {
  const r = gitCapture(['--version']);
  assert.strictEqual(r.ok, true);
  assert.match(r.out, /git version/);
});

test('gitCapture returns { ok:false } for a failing git command and never throws', () => {
  assert.strictEqual(gitCapture(['not-a-real-subcommand-xyz']).ok, false);
});

test('gitTrim returns trimmed stdout on success, "" on failure', () => {
  assert.match(gitTrim(['--version']), /^git version/);
  assert.strictEqual(gitTrim(['not-a-real-subcommand-xyz']), '');
});

test('makeLog tags its output', () => {
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(m);
  try { makeLog('demo')('hello'); } finally { console.log = orig; }
  assert.deepStrictEqual(logs, ['[demo] hello']);
});

test('makeDie returns a function', () => {
  assert.strictEqual(typeof makeDie('demo'), 'function');
});
