#!/usr/bin/env python3
"""error.py — log an error row into the pmtools SQLite store (+ optional CSV mirror).

  error log '<json>' [--db-path P] [--csv P | --no-csv]
  error export        [--db-path P] [--csv P]

A thin spec over the shared store-CLI runner (store_cli, #76); see that module for
the common parse → validate → insert → CSV-mirror flow. SQLite is the source of
truth; the CSV mirror is a derived full-table dump. When the errors store is
DISABLED for the project, `log` prints a notice and exits 0.

Exit codes: 0 success / disabled-store; 2 usage error; 1 operational (invalid JSON,
validation failure, or DB error). See CONTRACT.md "Output conventions" (#44).
"""
import sys

import store_core as core
import store_cli

SPEC = {
    "name": "error",
    "table": "errors",
    "cols": core.ERROR_COLS,
    "cfg_key": "errors",
    "validate": core.validate_error_row,
    "log_usage": "usage: error log '{\"occurred_iso\":\"<ISO8601>\",\"message\":\"...\"}' "
                 "[--db-path P] [--csv P|--no-csv]",
    "inserted_message": lambda rid, row: "Inserted error row id={}{}".format(
        rid, " (ticket #{})".format(row["ticket"]) if row.get("ticket") else ""),
}


def main(argv):
    return store_cli.run(argv, SPEC)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
