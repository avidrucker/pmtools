#!/usr/bin/env python3
"""error.py — log an error row into the pmtools SQLite store (+ optional CSV mirror).

  error log '<json>' [--db-path P] [--csv P | --no-csv]
  error export        [--db-path P] [--csv P]

SQLite is the source of truth; the CSV mirror is a derived full-table dump
regenerated after each write (or on demand via `export`). Config comes from the
project's .claude/orchestrate.json `storage` block (see config.py). When the
errors store is DISABLED for the project, `log` prints a notice and exits 0 (a
disabled store is not an error).

Ported from lccjs scripts/error-log.js + scripts/errors-seed.js. The pure
validation/encoding lives in store_core; the sqlite engine in store.

Exit codes: 0 success / disabled-store; 1 missing arg, invalid JSON, validation
failure, or DB error.
"""
import json
import os
import sys

import config
import store
import store_core as core

TABLE = "errors"
COLS = core.ERROR_COLS


def die(msg):
    sys.stderr.write("error: {}\n".format(msg))
    sys.exit(1)


def _repo_basename(cwd=None):
    root = config.repo_root(cwd)
    return os.path.basename(root) if root else "repo"


def parse_args(argv):
    a = {"cmd": None, "json": None, "dbPath": None, "csv": None, "noCsv": False}
    positionals = []
    i = 0
    n = len(argv)
    while i < n:
        t = argv[i]
        if t == "--db-path":
            i += 1; a["dbPath"] = argv[i] if i < n else None
        elif t == "--csv":
            i += 1; a["csv"] = argv[i] if i < n else None
        elif t == "--no-csv":
            a["noCsv"] = True
        elif t.startswith("--"):
            die("unknown flag: " + t)
        else:
            positionals.append(t)
        i += 1
    a["cmd"] = positionals[0] if positionals else None
    a["json"] = positionals[1] if len(positionals) > 1 else None
    return a


def _resolve_csv(args, store_cfg):
    """The CSV mirror path to export to, or None. CLI --no-csv wins; then --csv;
    then the project config's errors.csvMirror."""
    if args["noCsv"]:
        return None
    if args["csv"]:
        return args["csv"]
    return store_cfg["csvMirror"]


def cmd_log(args, cfg):
    store_cfg = cfg["errors"]
    if not store_cfg["enabled"]:
        print("errors store disabled for this project")
        return 0

    if not args["json"]:
        die("usage: error log '{\"occurred_iso\":\"<ISO8601>\",\"message\":\"...\"}' "
            "[--db-path P] [--csv P|--no-csv]")
    try:
        raw = json.loads(args["json"])
    except (ValueError, TypeError) as e:
        die("invalid JSON: {}".format(e))

    if not isinstance(raw, dict):
        die("payload must be a JSON object")

    # repo defaults to the git repo basename when not supplied (lccjs parity).
    if not raw.get("repo"):
        raw["repo"] = _repo_basename()

    try:
        row = core.validate_error_row(raw)
    except ValueError as e:
        die(str(e))

    db_path = args["dbPath"] or cfg["dbPath"]
    try:
        rid = store.insert(db_path, TABLE, row)
    except Exception as e:  # sqlite errors are opaque; surface as a DB failure
        die("DB insert failed: {}".format(e))

    ticket_label = " (ticket #{})".format(row["ticket"]) if row.get("ticket") else ""
    print("Inserted error row id={}{}".format(rid, ticket_label))

    csv_path = _resolve_csv(args, store_cfg)
    if csv_path:
        nrows = store.export_csv(db_path, TABLE, csv_path, COLS)
        print("Exported {} rows -> {}".format(nrows, csv_path))
    return 0


def cmd_export(args, cfg):
    store_cfg = cfg["errors"]
    if not store_cfg["enabled"]:
        print("errors store disabled for this project")
        return 0
    db_path = args["dbPath"] or cfg["dbPath"]
    csv_path = args["csv"] or store_cfg["csvMirror"]
    if not csv_path:
        die("no CSV target: pass --csv P or set storage.errors.csvMirror")
    nrows = store.export_csv(db_path, TABLE, csv_path, COLS)
    print("Exported {} rows -> {}".format(nrows, csv_path))
    return 0


def main(argv):
    args = parse_args(argv)
    cfg = config.load_storage_config()
    if args["cmd"] == "log":
        return cmd_log(args, cfg)
    if args["cmd"] == "export":
        return cmd_export(args, cfg)
    die("usage: error <log|export> [...]  (got {!r})".format(args["cmd"]))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
