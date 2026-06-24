// Tests for main-repo identity resolution (#26). Run: node --test 'js/*.test.js'
//
// Per-project STATE (DB path, scratch dir, the `repo` data column) must key off
// the MAIN checkout, so every worktree of one repo shares one identity. The bug:
// resolving via `--show-toplevel` returns the *worktree* in a worktree. These
// tests build a real repo + worktree and pin the corrected resolution.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const config = require('./config');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// A temp repo whose main checkout basename is 'myrepo', plus a worktree whose
// own dir basename is 'wt-issue-99' (the misleading identity).
function repoWithWorktree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmtools-mainroot-'));
  const main = path.join(dir, 'myrepo');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 't@e.com');
  git(main, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(main, 'f.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  const wt = path.join(dir, 'wt-issue-99');
  git(main, 'worktree', 'add', '-q', wt, 'HEAD');
  return { main, wt };
}

test('repoRoot from a worktree returns the worktree (the misleading identity)', () => {
  const { wt } = repoWithWorktree();
  assert.equal(path.basename(config.repoRoot(wt)), 'wt-issue-99');
});

test('mainRepoRoot from a worktree resolves the MAIN checkout', () => {
  const { wt } = repoWithWorktree();
  assert.equal(path.basename(config.mainRepoRoot(wt)), 'myrepo');
});

test('mainRepoRoot in a plain checkout equals repoRoot (no-op outside a worktree)', () => {
  const { main } = repoWithWorktree();
  assert.equal(path.basename(config.mainRepoRoot(main)), 'myrepo');
  assert.equal(path.basename(config.repoRoot(main)), 'myrepo');
});

test('defaultDbPath keys off the main repo identity from a worktree', () => {
  const { wt } = repoWithWorktree();
  const db = config.defaultDbPath(config.mainRepoRoot(wt));
  assert.equal(path.basename(path.dirname(db)), 'myrepo');
});
