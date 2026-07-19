#!/usr/bin/env python3
"""velocity.py — log a velocity row into the pmtools SQLite store (+ optional CSV mirror).

  velocity log '<json>' [--db-path P] [--csv P | --no-csv]
  velocity export        [--db-path P] [--csv P]

A thin spec over the shared store-CLI runner (store_cli, #76) plus the two velocity
-only hooks: a pre-validate title-autofetch (when title is omitted and a ticket is
present, fetch it best-effort via the GitHub provider) and a post-validate model
notice (a non-canonical model is NOTICED, not rejected). Velocity is OPT-IN: the
store is DISABLED by default, so `log` prints a notice + exits 0 unless the
project's .claude/orchestrate.json enables storage.velocity.

Exit codes: 0 success / disabled-store; 2 usage error; 1 operational (invalid JSON,
validation failure, or DB error). See CONTRACT.md "Output conventions" (#44).
"""
import sys

import store_core as core
import store_cli
from provider import get_provider


def fetch_title(ticket, provider=None):
    """Best-effort issue title via a host provider. None on any failure.
    `provider` is injectable (#46) so the seam is unit-testable with a
    canned/throwing stand-in instead of shelling out to `gh`; None → the real
    GitHub provider. Mirrors js/velocity.js fetchTitle -> provider.issueTitle."""
    try:
        return (provider or get_provider("github")).issue_title(ticket)
    except Exception:
        return None


def _pre_validate(raw, note, die):
    # Auto-fetch the title when omitted and a ticket is present (best-effort).
    if (raw.get("title") is None or raw.get("title") == "") and raw.get("ticket") is not None:
        fetched = fetch_title(raw["ticket"])
        if fetched:
            raw["title"] = fetched
        else:
            note("could not fetch title for #{} via gh — using fallback".format(raw["ticket"]))
            raw["title"] = "#{} (title unavailable)".format(raw["ticket"])


def _post_validate(raw, note):
    n = core.model_notice(raw)
    if n:
        note(n)


SPEC = {
    "name": "velocity",
    "table": "velocity",
    "cols": core.VELOCITY_COLS,
    "cfg_key": "velocity",
    "validate": core.validate_velocity_row,
    "log_usage": "usage: velocity log '{\"role\":\"DEV\",\"agent\":\"apple\",...}' "
                 "[--db-path P] [--csv P|--no-csv]",
    "pre_validate": _pre_validate,
    "post_validate": _post_validate,
    "inserted_message": lambda rid, row: "Inserted velocity row id={} ({})".format(
        rid, "ticket #{}".format(row["ticket"]) if row.get("ticket") else "no ticket"),
}


def main(argv):
    return store_cli.run(argv, SPEC)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
