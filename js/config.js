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

// Per-project default. errors enabled by default; velocity opt-in (disabled).
const DEFAULTS = {
  dbPath: null,
  errors: { enabled: true, csvMirror: null, logCommand: null },
  velocity: { enabled: false, csvMirror: null, logCommand: null },
};

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Absolute git toplevel for `cwd` (default process.cwd()), or null.
function repoRoot(cwd = null) {
  const args = cwd
    ? ['-C', cwd, 'rev-parse', '--show-toplevel']
    : ['rev-parse', '--show-toplevel'];
  const top = (sh('git', args) || '').trim();
  return top || null;
}

function expanduser(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// The dbPath default: ~/.pmtools/<repo>/pmtools.db (<repo> = root basename).
function defaultDbPath(root = null) {
  const r = root === null ? repoRoot() : root;
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
function loadStorageConfig(cwd = null) {
  const root = repoRoot(cwd);
  let rawStorage = {};
  if (root) {
    const cfgPath = path.join(root, '.claude', 'orchestrate.json');
    if (fs.existsSync(cfgPath) && fs.statSync(cfgPath).isFile()) {
      try {
        const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data)
            && data.storage && typeof data.storage === 'object' && !Array.isArray(data.storage)) {
          rawStorage = data.storage;
        }
      } catch {
        rawStorage = {};
      }
    }
  }

  let dbPath = rawStorage.dbPath;
  if (!dbPath) {
    dbPath = defaultDbPath(root);
  } else {
    dbPath = expanduser(dbPath);
  }

  return {
    dbPath,
    errors: mergeStore(DEFAULTS.errors, rawStorage.errors),
    velocity: mergeStore(DEFAULTS.velocity, rawStorage.velocity),
  };
}

module.exports = {
  repoRoot, defaultDbPath, loadStorageConfig, expanduser,
};
