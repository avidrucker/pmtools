#!/usr/bin/env python3
"""store_cli.py — the shared error/velocity store-CLI runner (#76, cont. of #74).

`error.py` and `velocity.py` are ~80% identical: parse the shared store args, load
the storage config, dispatch `log`/`export`, then validate → insert → CSV-mirror.
This module owns that common flow; each wrapper supplies a small `spec` and the
store-specific bits (validate fn, usage string, inserted-row message, and the
optional pre/post-validate hooks velocity needs for title-autofetch + model
notice). Twin of js/store_cli.js.

Exit codes (unchanged, #44): 0 success / disabled-store; 2 usage error; 1
operational (invalid JSON, validation failure, DB error).
"""
import json
import os
import sys

import config
import store
import store_core as core
from sh import make_die, wants_help


def repo_basename(cwd=None):
    # The `repo` data column labels the PROJECT; from a worktree that is still the
    # main repo, so key off main_repo_root (#26), not the worktree toplevel.
    root = config.main_repo_root(cwd)
    return os.path.basename(root) if root else "repo"


def run(argv, spec):
    """Run one store-CLI invocation against `spec`. Keys: name, table, cols,
    cfg_key, validate, log_usage, inserted_message(rid, row); optional
    pre_validate(raw, note, die) and post_validate(raw, note)."""
    die = make_die(spec["name"])

    def note(msg):
        sys.stderr.write("[{}] note: {}\n".format(spec["name"], msg))

    # #117 command-aware --help: print this store command's own usage, exit 0.
    if wants_help(argv):
        print(spec["log_usage"])
        return 0

    try:
        args = core.parse_store_args(argv)
    except ValueError as e:
        die(str(e), 2)

    cfg = config.load_storage_config()
    store_cfg = cfg[spec["cfg_key"]]
    cmd = args["cmd"]
    if cmd == "log":
        return _cmd_log(args, cfg, store_cfg, spec, die, note)
    if cmd == "export":
        return _cmd_export(args, cfg, store_cfg, spec, die)
    die("usage: {} <log|export> [...]  (got {})".format(
        spec["name"], json.dumps(cmd, ensure_ascii=False)), 2)


def _cmd_log(args, cfg, store_cfg, spec, die, note):
    if not store_cfg["enabled"]:
        print("{} store disabled for this project".format(spec["cfg_key"]))
        return 0

    if not args["json"]:
        die(spec["log_usage"], 2)
    try:
        raw = json.loads(args["json"])
    except (ValueError, TypeError) as e:
        die("invalid JSON: {}".format(e))
    if not isinstance(raw, dict):
        die("payload must be a JSON object")

    if spec.get("pre_validate"):
        spec["pre_validate"](raw, note, die)

    # repo defaults to the git repo basename when not supplied (lccjs parity).
    if not raw.get("repo"):
        raw["repo"] = repo_basename()

    try:
        row = spec["validate"](raw)
    except ValueError as e:
        die(str(e))

    if spec.get("post_validate"):
        spec["post_validate"](raw, note)

    db_path = args["dbPath"] or cfg["dbPath"]
    try:
        rid = store.insert(db_path, spec["table"], row)
    except Exception as e:  # sqlite errors are opaque; surface as a DB failure
        die("DB insert failed: {}".format(e))

    print(spec["inserted_message"](rid, row))

    csv_path = core.resolve_csv(args, store_cfg)
    if csv_path:
        nrows = store.export_csv(db_path, spec["table"], csv_path, spec["cols"])
        print("Exported {} rows -> {}".format(nrows, csv_path))
    return 0


def _cmd_export(args, cfg, store_cfg, spec, die):
    if not store_cfg["enabled"]:
        print("{} store disabled for this project".format(spec["cfg_key"]))
        return 0
    db_path = args["dbPath"] or cfg["dbPath"]
    csv_path = args["csv"] or store_cfg["csvMirror"]
    if not csv_path:
        die("no CSV target: pass --csv P or set storage.{}.csvMirror".format(spec["cfg_key"]))
    nrows = store.export_csv(db_path, spec["table"], csv_path, spec["cols"])
    print("Exported {} rows -> {}".format(nrows, csv_path))
    return 0
