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
fetched best-effort via the GitHub provider (provider.issue_title).

Exit codes: 0 success / disabled-store; 2 usage error (missing/unknown subcommand,
unknown flag, missing payload arg); 1 operational (invalid JSON, validation
failure, or DB error). See CONTRACT.md "Output conventions" (#44).
"""
import json
import os
import sys

import config
import store
import store_core as core
from provider import get_provider
from sh import make_die

TABLE = "velocity"
COLS = core.VELOCITY_COLS


die = make_die("velocity")


def note(msg):
    sys.stderr.write("[velocity] note: {}\n".format(msg))


def fetch_title(ticket, provider=None):
    """Best-effort issue title via a host provider. None on any failure.
    `provider` is injectable (#46) so the seam is unit-testable with a
    canned/throwing stand-in instead of shelling out to `gh`; None → the real
    GitHub provider. Mirrors js/velocity.js fetchTitle -> provider.issueTitle."""
    try:
        return (provider or get_provider("github")).issue_title(ticket)
    except Exception:
        return None


def parse_args(argv):
    # Thin impure wrapper over the shared pure parser (store_core, #46): an
    # unknown flag raises there; here we turn it into a usage die (exit 2).
    try:
        return core.parse_store_args(argv)
    except ValueError as e:
        die(str(e), 2)


def _repo_basename(cwd=None):
    # The `repo` data column labels the PROJECT; from a worktree that is still
    # the main repo, so key off main_repo_root (#26), not the worktree toplevel.
    root = config.main_repo_root(cwd)
    return os.path.basename(root) if root else "repo"


def cmd_log(args, cfg):
    store_cfg = cfg["velocity"]
    if not store_cfg["enabled"]:
        print("velocity store disabled for this project")
        return 0

    if not args["json"]:
        die("usage: velocity log '{\"role\":\"DEV\",\"agent\":\"apple\",...}' "
            "[--db-path P] [--csv P|--no-csv]", 2)
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

    # repo defaults to the git repo basename when not supplied (lccjs parity, #61).
    if not raw.get("repo"):
        raw["repo"] = _repo_basename()

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

    csv_path = core.resolve_csv(args, store_cfg)
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
    die("usage: velocity <log|export> [...]  (got {})".format(
        json.dumps(args["cmd"], ensure_ascii=False)), 2)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
