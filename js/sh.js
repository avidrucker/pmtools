// sh.js — shared impure I/O helpers for the pmtools command CLIs (#41).
//
// One copy of sh / shCapture / shTrim + die/log factories, so the claim / close /
// release / … wrappers stop drifting. The drift this consolidates:
//   - close's shCapture returned { ok, out } while release's returned a trimmed
//     STRING under the same name — now { ok, out } owns `shCapture` and the
//     string variant is `shTrim`;
//   - claim's sh discarded stderr ('ignore') where close/release captured it
//     ('pipe') — now all share one stderr-captured sh.
// Twin of py/sh.py. These run shell STRINGS (the lccjs lineage builds command
// strings); the arg-array git/gh exec added in #37 stays in each wrapper.
'use strict';

const { execSync } = require('node:child_process');

// Run a shell command, returning stdout text. allowFail -> null on a non-zero
// exit (else the error throws). stderr is captured (pipe), so it never leaks to
// the terminal and is available on the thrown error.
function sh(cmd, allowFail = false) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

// Like sh() but always returns { ok, out } with stdout+stderr merged, never throws.
function shCapture(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out || '' };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// Like sh() but returns trimmed stdout, '' on any error (never throws). The
// string-returning variant release.js used to call `shCapture` — renamed so the
// { ok, out } contract above unambiguously owns the `shCapture` name (#41).
function shTrim(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

// die/log factories parameterized by the command tag — `const die = makeDie('close')`
// yields the per-command `[close] ✗ <msg>` / `[close] <msg>` dialect uniformly.
function makeDie(tag) {
  return (msg, code = 1) => {
    console.error(`[${tag}] ✗ ${msg}`);
    process.exit(code);
  };
}

function makeLog(tag) {
  return (msg) => { console.log(`[${tag}] ${msg}`); };
}

module.exports = { sh, shCapture, shTrim, makeDie, makeLog };
