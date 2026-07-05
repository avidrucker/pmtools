// config.js — load the per-project `storage` block from .claude/orchestrate.json.
//
// JS twin of py/config.py. SQLite is per-store, per-project configurable. The
// `storage` block:
//
//     "storage": {
//       "dbPath": null,                  // null => ~/.pmtools/<repo>/pmtools.db
//       "velocity": { "enabled": false, "csvMirror": null, "logCommand": null },
//       "errors":   { "enabled": true,  "csvMirror": null, "logCommand": null }
//     }
//
// loadStorageConfig() finds the repo root, reads orchestrate.json if present,
// and returns the storage block merged over the defaults. Tolerant of a missing
// file, a missing `storage` key, or partial per-store blocks.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Per-project default. errors enabled by default; velocity + ice opt-in (disabled).
const DEFAULTS = {
  dbPath: null,
  errors: { enabled: true, csvMirror: null, logCommand: null },
  velocity: { enabled: false, csvMirror: null, logCommand: null },
  ice: { enabled: false, csvMirror: null, logCommand: null },
};

// PDD marker scanning defaults ON (preserves status's historical behavior); a
// repo opts out with `"pdd": { "enabled": false }`. ignoreFile names the
// gitignore-style exclude list (default .pddignore).
const DEFAULTS_PDD = { enabled: true, ignoreFile: '.pddignore' };
const DEFAULTS_ENRICHMENT = { statusCommand: null, clusterFile: null };

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Absolute git toplevel for `cwd` (default process.cwd()), or null.
// NOTE: in a worktree this is the WORKTREE, not the main checkout — correct for
// finding the committed .claude/orchestrate.json; for per-project STATE identity
// use mainRepoRoot() instead (#26).
function repoRoot(cwd = null) {
  const args = cwd
    ? ['-C', cwd, 'rev-parse', '--show-toplevel']
    : ['rev-parse', '--show-toplevel'];
  const top = (sh('git', args) || '').trim();
  return top || null;
}

// Absolute path of the MAIN checkout's root (NOT a worktree), or null. Per-project
// STATE (DB path, scratch dir, the `repo` data column) keys off this so every
// worktree of one repo shares one identity. Uses --git-common-dir (from a
// worktree it points at the main repo's .git) and takes its parent; mirrors
// close.js's mainRoot(). Falls back to a relative --git-common-dir resolved
// against cwd for older git without --path-format.
function mainRepoRoot(cwd = null) {
  const base = cwd ? ['-C', cwd] : [];
  let common = (sh('git', [...base, 'rev-parse', '--path-format=absolute', '--git-common-dir']) || '').trim();
  if (!common) {
    const rel = (sh('git', [...base, 'rev-parse', '--git-common-dir']) || '').trim();
    if (!rel) return null;
    common = path.resolve(cwd || process.cwd(), rel);
  }
  return path.dirname(common);
}

function expanduser(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// The dbPath default: ~/.pmtools/<repo>/pmtools.db (<repo> = root basename).
function defaultDbPath(root = null) {
  const r = root === null ? mainRepoRoot() : root;
  const repo = r ? path.basename(r) : 'repo';
  return path.join(os.homedir(), '.pmtools', repo, 'pmtools.db');
}

function mergeStore(defaultStore, override) {
  const merged = { ...defaultStore };
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    for (const k of ['enabled', 'csvMirror', 'logCommand']) {
      if (Object.prototype.hasOwnProperty.call(override, k)) {
        merged[k] = override[k];
      }
    }
  }
  return merged;
}

// Return the merged storage config object. Keys: dbPath (resolved to a concrete
// path — never null on the way out), errors {enabled, csvMirror, logCommand},
// velocity {...}. Always tolerant: a missing repo / file / key falls back.
// Read .claude/orchestrate.json under the repo root and return its top-level
// `<block>` object — or {} for a missing repo / file, a parse error, or a
// non-object block. The shared read+parse+guard behind the load*Config loaders (#74).
function readOrchestrateBlock(block, cwd = null) {
  const root = repoRoot(cwd);
  if (!root) return {};
  const cfgPath = path.join(root, '.claude', 'orchestrate.json');
  if (!(fs.existsSync(cfgPath) && fs.statSync(cfgPath).isFile())) return {};
  try {
    const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)
        && data[block] && typeof data[block] === 'object' && !Array.isArray(data[block])) {
      return data[block];
    }
  } catch { /* fall through to {} */ }
  return {};
}

function loadStorageConfig(cwd = null) {
  const rawStorage = readOrchestrateBlock('storage', cwd);

  let dbPath = rawStorage.dbPath;
  if (!dbPath) {
    // State identity = MAIN checkout, so all worktrees share one DB (#26).
    dbPath = defaultDbPath(mainRepoRoot(cwd));
  } else {
    dbPath = expanduser(dbPath);
  }

  return {
    dbPath,
    errors: mergeStore(DEFAULTS.errors, rawStorage.errors),
    velocity: mergeStore(DEFAULTS.velocity, rawStorage.velocity),
    ice: mergeStore(DEFAULTS.ice, rawStorage.ice),
  };
}

// Return the merged `pdd` config: { enabled, ignoreFile }. Reads the top-level
// `pdd` block of orchestrate.json (sibling to `storage`); tolerant of a missing
// repo / file / key (falls back to DEFAULTS_PDD → scanning ON).
function loadPddConfig(cwd = null) {
  const rawPdd = readOrchestrateBlock('pdd', cwd);
  const merged = { ...DEFAULTS_PDD };
  for (const k of ['enabled', 'ignoreFile']) {
    if (Object.prototype.hasOwnProperty.call(rawPdd, k)) merged[k] = rawPdd[k];
  }
  return merged;
}

// Return the merged `close` config: { autoResolve: { unionFiles: [...] } }. Reads
// the top-level `close` block of orchestrate.json (sibling to `storage`). The
// union-file list is consumer-supplied (the #23 generic rule — no paths baked
// into the shared harness) and defaults to EMPTY (union auto-resolve OFF).
// Tolerant of a missing repo / file / key / malformed value.
function loadCloseConfig(cwd = null) {
  const rawClose = readOrchestrateBlock('close', cwd);
  const ar = (rawClose.autoResolve && typeof rawClose.autoResolve === 'object'
              && !Array.isArray(rawClose.autoResolve)) ? rawClose.autoResolve : {};
  const unionFiles = Array.isArray(ar.unionFiles)
    ? ar.unionFiles.filter((s) => typeof s === 'string' && s)
    : [];
  const markdownIndexes = Array.isArray(ar.markdownIndexes)
    ? ar.markdownIndexes.filter((s) => typeof s === 'string' && s)
    : [];
  const updateParentTrackers = rawClose.updateParentTrackers === true;
  // Pre-close verify gate (#106): pass the raw `verify` block through — the pure
  // closeCore.preclosePlan seam owns normalization (enabled/commands/cwd).
  const verify = (rawClose.verify && typeof rawClose.verify === 'object'
                  && !Array.isArray(rawClose.verify)) ? rawClose.verify : {};
  return { autoResolve: { unionFiles, markdownIndexes }, updateParentTrackers, verify };
}

// Merged `enrichment` config: {statusCommand, clusterFile}. Read by external
// rankers (e.g. the puzzle-triage skill) to resolve the status reconciler
// (statusCommand, e.g. "pmtools status") and the cluster soft-lock map
// (clusterFile, reserved for #80/LOCKED). Both consumer-supplied (#23 generic
// rule), default null — absent → no reconciler / no cluster locking. Tolerant of
// a missing repo / file / key / non-string value. (#79)
function loadEnrichmentConfig(cwd = null) {
  const raw = readOrchestrateBlock('enrichment', cwd);
  const merged = { ...DEFAULTS_ENRICHMENT };
  for (const k of ['statusCommand', 'clusterFile']) {
    if (typeof raw[k] === 'string' && raw[k]) merged[k] = raw[k];
  }
  return merged;
}

module.exports = {
  repoRoot, mainRepoRoot, defaultDbPath, loadStorageConfig, loadPddConfig, loadCloseConfig,
  loadEnrichmentConfig, expanduser,
};
