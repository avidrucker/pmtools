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

// #79: a temp repo whose .claude/orchestrate.json holds `cfg` (null = no file).
function repoWithOrchestrate(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmtools-enrich-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@e.com');
  git(dir, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, '.claude'));
  if (cfg !== null) fs.writeFileSync(path.join(dir, '.claude', 'orchestrate.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const ENRICH_ALL_NULL = { statusCommand: null, clusterFile: null, claimCommand: null, closeCommand: null };

test('loadEnrichmentConfig: absent block → null defaults (#79)', () => {
  const repo = repoWithOrchestrate({ storage: {} });
  assert.deepEqual(config.loadEnrichmentConfig(repo), ENRICH_ALL_NULL);
});

test('loadEnrichmentConfig: reads statusCommand (#79)', () => {
  const repo = repoWithOrchestrate({ enrichment: { statusCommand: 'pmtools status' } });
  const cfg = config.loadEnrichmentConfig(repo);
  assert.equal(cfg.statusCommand, 'pmtools status');
  assert.equal(cfg.clusterFile, null);
});

test('loadEnrichmentConfig: reads clusterFile (#79)', () => {
  const repo = repoWithOrchestrate({ enrichment: { statusCommand: 'pmtools status', clusterFile: 'puzzle-clusters.csv' } });
  assert.equal(config.loadEnrichmentConfig(repo).clusterFile, 'puzzle-clusters.csv');
});

test('loadEnrichmentConfig: reads claimCommand/closeCommand (#63)', () => {
  const repo = repoWithOrchestrate({ enrichment: { claimCommand: 'pmtools claim', closeCommand: 'npm run close' } });
  const cfg = config.loadEnrichmentConfig(repo);
  assert.equal(cfg.claimCommand, 'pmtools claim');
  assert.equal(cfg.closeCommand, 'npm run close');
});

test('loadEnrichmentConfig: no orchestrate.json → null defaults (#79)', () => {
  const repo = repoWithOrchestrate(null);
  assert.deepEqual(config.loadEnrichmentConfig(repo), ENRICH_ALL_NULL);
});

const CREATE_DEFAULTS = {
  validAreas: [], requireArea: true, requireRole: true, severityOnlyOnDefects: true,
  requireBodyShape: false, bannedTitleWords: [], uncategorizedFallback: 'area:uncategorized',
};

test('loadCreateConfig: absent block → defaults (#111)', () => {
  const repo = repoWithOrchestrate({ storage: {} });
  assert.deepEqual(config.loadCreateConfig(repo), CREATE_DEFAULTS);
});

test('loadCreateConfig: reads validAreas + toggles + fallback, dropping bad entries (#111)', () => {
  const repo = repoWithOrchestrate({ create: {
    validAreas: ['config', 'lifecycle', 7], requireRole: false,
    bannedTitleWords: ['baked in', ''], uncategorizedFallback: 'needs:area',
  } });
  const cfg = config.loadCreateConfig(repo);
  assert.deepEqual(cfg.validAreas, ['config', 'lifecycle']); // non-string 7 dropped
  assert.equal(cfg.requireRole, false);
  assert.equal(cfg.requireArea, true);                       // untouched default
  assert.deepEqual(cfg.bannedTitleWords, ['baked in']);      // empty string dropped
  assert.equal(cfg.uncategorizedFallback, 'needs:area');
});

test('loadCreateConfig: no orchestrate.json → defaults (#111)', () => {
  const repo = repoWithOrchestrate(null);
  assert.deepEqual(config.loadCreateConfig(repo), CREATE_DEFAULTS);
});

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
