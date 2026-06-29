"""config.py — load the per-project `storage` block from .claude/orchestrate.json.

SQLite is per-store, per-project configurable. The `storage` block:

    "storage": {
      "dbPath": null,                  // null => ~/.pmtools/<repo>/pmtools.db
      "velocity": { "enabled": false, "csvMirror": null, "logCommand": null },
      "errors":   { "enabled": true,  "csvMirror": null, "logCommand": null }
    }

`load_storage_config()` finds the repo root, reads orchestrate.json if present,
and returns the storage block merged over the defaults. Tolerant of a missing
file, a missing `storage` key, or partial per-store blocks. The dbPath default
reuses the same `~/.pmtools/<repo>/` convention as preflight's scratch dir.
"""

import json
import os
import subprocess


# Per-project default. errors enabled by default; velocity + ice opt-in (disabled).
_DEFAULTS = {
    "dbPath": None,
    "errors": {"enabled": True, "csvMirror": None, "logCommand": None},
    "velocity": {"enabled": False, "csvMirror": None, "logCommand": None},
    "ice": {"enabled": False, "csvMirror": None, "logCommand": None},
}

# PDD marker scanning defaults ON (preserves status's historical behavior); a
# repo opts out with `"pdd": {"enabled": false}`. ignoreFile names the
# gitignore-style exclude list (default .pddignore).
_DEFAULTS_PDD = {"enabled": True, "ignoreFile": ".pddignore"}
_DEFAULTS_ENRICHMENT = {"statusCommand": None, "clusterFile": None}


def _sh(cmd):
    try:
        out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, check=True)
        return out.stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def repo_root(cwd=None):
    """Absolute git toplevel for `cwd` (default os.getcwd()), or None.

    NOTE: in a worktree this is the WORKTREE, not the main checkout. Correct for
    finding the (committed) `.claude/orchestrate.json`; for per-project STATE
    identity use main_repo_root() instead (#26)."""
    args = ["git", "rev-parse", "--show-toplevel"]
    if cwd:
        args = ["git", "-C", cwd, "rev-parse", "--show-toplevel"]
    top = (_sh(args) or "").strip()
    return top or None


def main_repo_root(cwd=None):
    """Absolute path of the MAIN checkout's root (NOT a worktree), or None.

    Per-project STATE (DB path, scratch dir, the `repo` data column) keys off this
    so every worktree of one repo shares one identity. Uses --git-common-dir
    (which, from a worktree, points at the main repo's .git) and takes its parent;
    mirrors close.py's main_root(). Falls back to a relative --git-common-dir
    resolved against cwd for older git without --path-format."""
    base = ["git"] + (["-C", cwd] if cwd else [])
    common = (_sh(base + ["rev-parse", "--path-format=absolute",
                          "--git-common-dir"]) or "").strip()
    if not common:
        rel = (_sh(base + ["rev-parse", "--git-common-dir"]) or "").strip()
        if not rel:
            return None
        common = os.path.abspath(os.path.join(cwd or os.getcwd(), rel))
    return os.path.dirname(common)


def default_db_path(root=None):
    """The dbPath default: ~/.pmtools/<repo>/pmtools.db (<repo> = root basename).

    Mirrors preflight.default_scratch_dir()'s ~/.pmtools/<repo>/ pattern.
    """
    if root is None:
        root = main_repo_root()
    repo = os.path.basename(root) if root else "repo"
    return os.path.join(os.path.expanduser("~"), ".pmtools", repo, "pmtools.db")


def _merge_store(default_store, override):
    merged = dict(default_store)
    if isinstance(override, dict):
        for k in ("enabled", "csvMirror", "logCommand"):
            if k in override:
                merged[k] = override[k]
    return merged


def _read_orchestrate_block(block, cwd=None):
    """Read .claude/orchestrate.json under the repo root and return its top-level
    `block` dict, or {} for a missing repo / file / parse error / non-dict block.
    The shared read+parse+guard behind the load_*_config loaders (#74)."""
    root = repo_root(cwd)
    if not root:
        return {}
    cfg_path = os.path.join(root, ".claude", "orchestrate.json")
    if not os.path.isfile(cfg_path):
        return {}
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get(block), dict):
            return data[block]
    except (ValueError, OSError):
        pass
    return {}


def load_storage_config(cwd=None):
    """Return the merged storage config dict.

    Keys: dbPath (resolved to a concrete path — never None on the way out),
    errors {enabled, csvMirror, logCommand}, velocity {...}. Always tolerant:
    a missing repo / file / key falls back to defaults.
    """
    raw_storage = _read_orchestrate_block("storage", cwd)

    db_path = raw_storage.get("dbPath")
    if not db_path:
        # State identity = MAIN checkout, so all worktrees share one DB (#26).
        db_path = default_db_path(main_repo_root(cwd))
    else:
        db_path = os.path.expanduser(db_path)

    return {
        "dbPath": db_path,
        "errors": _merge_store(_DEFAULTS["errors"], raw_storage.get("errors")),
        "velocity": _merge_store(_DEFAULTS["velocity"], raw_storage.get("velocity")),
        "ice": _merge_store(_DEFAULTS["ice"], raw_storage.get("ice")),
    }


def load_pdd_config(cwd=None):
    """Return the merged `pdd` config: {enabled, ignoreFile}. Reads the top-level
    `pdd` block of orchestrate.json (sibling to `storage`); tolerant of a missing
    repo / file / key (falls back to _DEFAULTS_PDD → scanning ON)."""
    raw_pdd = _read_orchestrate_block("pdd", cwd)
    merged = dict(_DEFAULTS_PDD)
    for k in ("enabled", "ignoreFile"):
        if k in raw_pdd:
            merged[k] = raw_pdd[k]
    return merged


def load_close_config(cwd=None):
    """Return the merged `close` config: {autoResolve: {unionFiles: [...]}}. Reads
    the top-level `close` block of orchestrate.json (sibling to `storage`). The
    union-file list is consumer-supplied (the #23 generic rule — no paths baked
    into the shared harness) and defaults to EMPTY (union auto-resolve OFF).
    Tolerant of a missing repo / file / key / malformed value."""
    raw_close = _read_orchestrate_block("close", cwd)
    ar = raw_close.get("autoResolve")
    if not isinstance(ar, dict):
        ar = {}
    uf = ar.get("unionFiles")
    union_files = [s for s in uf if isinstance(s, str) and s] if isinstance(uf, list) else []
    mi = ar.get("markdownIndexes")
    markdown_indexes = [s for s in mi if isinstance(s, str) and s] if isinstance(mi, list) else []
    update_parent_trackers = raw_close.get("updateParentTrackers") is True
    return {
        "autoResolve": {"unionFiles": union_files, "markdownIndexes": markdown_indexes},
        "updateParentTrackers": update_parent_trackers,
    }


def load_enrichment_config(cwd=None):
    """Return the merged `enrichment` config: {statusCommand, clusterFile}. Reads
    the top-level `enrichment` block of orchestrate.json (sibling to `storage`).
    Used by external rankers (e.g. the puzzle-triage skill) to resolve the status
    reconciler (`statusCommand`, e.g. "pmtools status") and the cluster soft-lock
    map (`clusterFile`, reserved for #80/LOCKED). Both consumer-supplied (the #23
    generic rule) and default to None — absent → no reconciler / no cluster
    locking. Tolerant of a missing repo / file / key / non-string value."""
    raw = _read_orchestrate_block("enrichment", cwd)
    merged = dict(_DEFAULTS_ENRICHMENT)
    for k in ("statusCommand", "clusterFile"):
        v = raw.get(k)
        if isinstance(v, str) and v:
            merged[k] = v
    return merged
