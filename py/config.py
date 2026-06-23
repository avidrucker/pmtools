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


# Per-project default. errors enabled by default; velocity opt-in (disabled).
_DEFAULTS = {
    "dbPath": None,
    "errors": {"enabled": True, "csvMirror": None, "logCommand": None},
    "velocity": {"enabled": False, "csvMirror": None, "logCommand": None},
}


def _sh(cmd):
    try:
        out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, check=True)
        return out.stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def repo_root(cwd=None):
    """Absolute git toplevel for `cwd` (default os.getcwd()), or None."""
    args = ["git", "rev-parse", "--show-toplevel"]
    if cwd:
        args = ["git", "-C", cwd, "rev-parse", "--show-toplevel"]
    top = (_sh(args) or "").strip()
    return top or None


def default_db_path(root=None):
    """The dbPath default: ~/.pmtools/<repo>/pmtools.db (<repo> = root basename).

    Mirrors preflight.default_scratch_dir()'s ~/.pmtools/<repo>/ pattern.
    """
    if root is None:
        root = repo_root()
    repo = os.path.basename(root) if root else "repo"
    return os.path.join(os.path.expanduser("~"), ".pmtools", repo, "pmtools.db")


def _merge_store(default_store, override):
    merged = dict(default_store)
    if isinstance(override, dict):
        for k in ("enabled", "csvMirror", "logCommand"):
            if k in override:
                merged[k] = override[k]
    return merged


def load_storage_config(cwd=None):
    """Return the merged storage config dict.

    Keys: dbPath (resolved to a concrete path — never None on the way out),
    errors {enabled, csvMirror, logCommand}, velocity {...}. Always tolerant:
    a missing repo / file / key falls back to defaults.
    """
    root = repo_root(cwd)
    raw_storage = {}
    if root:
        cfg_path = os.path.join(root, ".claude", "orchestrate.json")
        if os.path.isfile(cfg_path):
            try:
                with open(cfg_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("storage"), dict):
                    raw_storage = data["storage"]
            except (ValueError, OSError):
                raw_storage = {}

    db_path = raw_storage.get("dbPath")
    if not db_path:
        db_path = default_db_path(root)
    else:
        db_path = os.path.expanduser(db_path)

    return {
        "dbPath": db_path,
        "errors": _merge_store(_DEFAULTS["errors"], raw_storage.get("errors")),
        "velocity": _merge_store(_DEFAULTS["velocity"], raw_storage.get("velocity")),
    }
