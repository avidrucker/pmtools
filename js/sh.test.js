// Tests for the shared sh.js I/O helpers (#41). node:test, twin of py/test_sh.py.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { sh, shCapture, shTrim, makeDie, makeLog } = require('./sh');

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

test('shTrim returns a trimmed string, "" on failure', () => {
  assert.strictEqual(shTrim('echo "  hi  "'), 'hi');
  assert.strictEqual(shTrim('exit 1'), '');
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
