#!/usr/bin/env python3
"""velocity.py — log a velocity row into the pmtools SQLite store (+ optional CSV mirror).

  velocity log '<json>' [--db-path P] [--csv P | --no-csv]
  velocity export        [--db-path P] [--csv P]

Same shape as error.py, for the velocity store. Velocity is OPT-IN: the store is
DISABLED by default, so `log` prints a notice + exits 0 unless the project's
.claude/orchestrate.json enables storage.velocity.

Ported from lccjs scripts/velocity-log.js (+ velocity-seed/export). Required
fields: role (closed vocabulary) + agent; ticket nullable. delta_h_min /
delta_c_min are DERIVED (estimate - actual). A non-canonical model is NOTICED,
not rejected. When title is omitted and a ticket is present, the title is
fetched best-effort via `gh issue view <N> --json title -q .title`.

Exit codes: 0 success / disabled-store; 1 missing arg, invalid JSON, validation
failure, or DB error.
"""
import json
import subprocess
import sys

import config
import store
import store_core as core

TABLE = "velocity"
COLS = core.VELOCITY_COLS


def die(msg):
    sys.stderr.write("velocity: {}\n".format(msg))
    sys.exit(1)


def note(msg):
    sys.stderr.write("velocity: note: {}\n".format(msg))


def fetch_title(ticket, gh="gh"):
    """Best-effort `gh issue view <N> --json title -q .title`. None on failure."""
    try:
        out = subprocess.run(
            [gh, "issue", "view", str(ticket), "--json", "title", "-q", ".title"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            check=True, timeout=5,
        )
        t = out.stdout.strip()
        return t or None
    except Exception:
        return None


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
    if args["noCsv"]:
        return None
    if args["csv"]:
        return args["csv"]
    return store_cfg["csvMirror"]


def cmd_log(args, cfg):
    store_cfg = cfg["velocity"]
    if not store_cfg["enabled"]:
        print("velocity store disabled for this project")
        return 0

    if not args["json"]:
        die("usage: velocity log '{\"role\":\"DEV\",\"agent\":\"apple\",...}' "
            "[--db-path P] [--csv P|--no-csv]")
    try:
        raw = json.loads(args["json"])
    except (ValueError, TypeError) as e:
        die("invalid JSON: {}".format(e))
    if not isinstance(raw, dict):
        die("payload must be a JSON object")

    # Auto-fetch the title when omitted and a ticket is present (best-effort).
    if (raw.get("title") is None or raw.get("title") == "") and raw.get("ticket") is not None:
        fetched = fetch_title(raw["ticket"])
        if fetched:
            raw["title"] = fetched
        else:
            note("could not fetch title for #{} via gh — using fallback".format(raw["ticket"]))
            raw["title"] = "#{} (title unavailable)".format(raw["ticket"])

    try:
        row = core.validate_velocity_row(raw)
    except ValueError as e:
        die(str(e))

    n = core.model_notice(raw)
    if n:
        note(n)

    db_path = args["dbPath"] or cfg["dbPath"]
    try:
        rid = store.insert(db_path, TABLE, row)
    except Exception as e:
        die("DB insert failed: {}".format(e))

    ticket_label = "ticket #{}".format(row["ticket"]) if row.get("ticket") else "no ticket"
    print("Inserted velocity row id={} ({})".format(rid, ticket_label))

    csv_path = _resolve_csv(args, store_cfg)
    if csv_path:
        nrows = store.export_csv(db_path, TABLE, csv_path, COLS)
        print("Exported {} rows -> {}".format(nrows, csv_path))
    return 0


def cmd_export(args, cfg):
    store_cfg = cfg["velocity"]
    if not store_cfg["enabled"]:
        print("velocity store disabled for this project")
        return 0
    db_path = args["dbPath"] or cfg["dbPath"]
    csv_path = args["csv"] or store_cfg["csvMirror"]
    if not csv_path:
        die("no CSV target: pass --csv P or set storage.velocity.csvMirror")
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
    die("usage: velocity <log|export> [...]  (got {!r})".format(args["cmd"]))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
