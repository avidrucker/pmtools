"""store.py — IMPURE sqlite engine for the pmtools error + velocity stores.

stdlib `sqlite3` only (no better-sqlite3 / no pip). SQLite is the source of
truth; the CSV mirror (export_csv) is a derived, shallow full-table dump.

Schemas + indices are copied verbatim from lccjs scripts/errors-seed.js and
scripts/velocity-seed.js. `connect()` is idempotent (CREATE TABLE/INDEX IF NOT
EXISTS), so the first write to a fresh DB seeds it. The encoders live in the
pure store_core layer; this file only does I/O.
"""

import os
import sqlite3
import sys

import store_core as core
import ice_core

# --- schema (verbatim from the lccjs seed scripts) ---------------------------

CREATE_ERRORS = """
CREATE TABLE IF NOT EXISTS errors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_iso TEXT    NOT NULL,
  agent        TEXT,
  model        TEXT,
  ticket       INTEGER,
  repo         TEXT,
  error_type   TEXT,
  message      TEXT,
  context      TEXT,
  notes        TEXT
);
""".strip()

ERRORS_INDEXES = [
    "CREATE INDEX IF NOT EXISTS errors_agent_time ON errors (agent, occurred_iso);",
    "CREATE INDEX IF NOT EXISTS errors_type ON errors (error_type);",
    "CREATE INDEX IF NOT EXISTS errors_ticket ON errors (ticket);",
]

CREATE_VELOCITY = """
CREATE TABLE IF NOT EXISTS velocity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket        INTEGER,
  title         TEXT,
  role          TEXT,
  h_min         REAL,
  c_min         REAL,
  actual_min    REAL,
  delta_h_min   REAL,
  delta_c_min   REAL,
  started_iso   TEXT,
  finished_iso  TEXT,
  closed_commit TEXT,
  notes         TEXT,
  agent         TEXT,
  model         TEXT,
  repo          TEXT
);
""".strip()

VELOCITY_INDEXES = [
    # Partial unique index: NULL started_iso rows are excluded (undated rows
    # for the same ticket/agent don't conflict).
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_velocity_session "
    "ON velocity(ticket, agent, started_iso) WHERE started_iso IS NOT NULL;",
]

# True iff velocity already holds duplicate (ticket, agent, started_iso) groups
# that would block the partial unique index above.
VELOCITY_DUP_CHECK = (
    "SELECT 1 FROM velocity WHERE started_iso IS NOT NULL "
    "GROUP BY ticket, agent, started_iso HAVING COUNT(*) > 1 LIMIT 1"
)

# The ice store (#101): a per-issue triage score, keyed by a UNIQUE issue so a
# re-score upserts (INSERT OR REPLACE) rather than appending. Columns mirror
# ice_core.ICE_COLS; ice_rank is NOT stored (derived at export).
CREATE_ICE = """
CREATE TABLE IF NOT EXISTS ice (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  issue          INTEGER NOT NULL UNIQUE,
  title          TEXT,
  type           TEXT,
  I              REAL,
  C              REAL,
  E              REAL,
  ice_score      REAL,
  tier           TEXT DEFAULT '',
  yegor_priority INTEGER,
  actionable     TEXT DEFAULT 'Y',
  provisional    INTEGER DEFAULT 0,
  labels         TEXT,
  notes          TEXT,
  updated_iso    TEXT
);
""".strip()

ICE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS ice_score_idx ON ice (ice_score);",
]

# Non-id columns, in schema order, per table — what insert()/upsert() bind.
_INSERT_COLS = {
    "errors": [c for c in core.ERROR_COLS if c != "id"],
    "velocity": [c for c in core.VELOCITY_COLS if c != "id"],
    "ice": [c for c in ice_core.ICE_COLS if c != "id"],
}

_TABLES = ("errors", "velocity", "ice")


def _resolve(db_path):
    """expanduser + absolutise a DB path."""
    return os.path.abspath(os.path.expanduser(db_path))


def connect(db_path):
    """Open (creating parent dirs) the DB and idempotently seed both tables.

    Returns a live sqlite3.Connection with row_factory set to sqlite3.Row.
    """
    path = _resolve(db_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute(CREATE_ERRORS)
    for idx in ERRORS_INDEXES:
        conn.execute(idx)
    conn.execute(CREATE_VELOCITY)
    # Dedup-gate the velocity unique index (twin of js/store.js; #10): a legacy
    # velocity table holding duplicate (ticket, agent, started_iso) sessions
    # can't host uq_velocity_session. `IF NOT EXISTS` does NOT suppress a
    # uniqueness violation over existing data, so creating it unconditionally
    # would raise here and abort ALL logging (errors included) — connect() runs
    # on every write to either store. Detect dups first; skip + warn instead of
    # aborting. A fresh/clean DB has no dups, so it still gets the index.
    if conn.execute(VELOCITY_DUP_CHECK).fetchone() is not None:
        print(
            "pmtools: velocity has duplicate (ticket, agent, started_iso) rows; "
            "skipping the uq_velocity_session unique index (logging continues). "
            "Resolve the duplicates and re-run to add it.",
            file=sys.stderr,
        )
    else:
        for idx in VELOCITY_INDEXES:
            conn.execute(idx)
    conn.execute(CREATE_ICE)
    for idx in ICE_INDEXES:
        conn.execute(idx)
    conn.commit()
    return conn


def insert(db_path, table, row):
    """Insert a (pre-validated) row dict into `table`; return the new row id."""
    if table not in _TABLES:
        raise ValueError("unknown table {!r}".format(table))
    cols = _INSERT_COLS[table]
    placeholders = ", ".join(":" + c for c in cols)
    sql = "INSERT INTO {} ({}) VALUES ({})".format(
        table, ", ".join(cols), placeholders)
    conn = connect(db_path)
    try:
        cur = conn.execute(sql, {c: row.get(c) for c in cols})
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def upsert(db_path, table, row):
    """INSERT OR REPLACE a (pre-validated) row keyed by the table's UNIQUE
    column — for the ice store, where a re-score must REPLACE the prior row, not
    append. Returns the resulting row id. (`ice` is keyed by a UNIQUE issue.)"""
    if table not in _TABLES:
        raise ValueError("unknown table {!r}".format(table))
    cols = _INSERT_COLS[table]
    placeholders = ", ".join(":" + c for c in cols)
    sql = "INSERT OR REPLACE INTO {} ({}) VALUES ({})".format(
        table, ", ".join(cols), placeholders)
    conn = connect(db_path)
    try:
        cur = conn.execute(sql, {c: row.get(c) for c in cols})
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def select_all(db_path, table):
    """Return all rows of `table` ordered by id, as a list of plain dicts."""
    if table not in _TABLES:
        raise ValueError("unknown table {!r}".format(table))
    conn = connect(db_path)
    try:
        cur = conn.execute("SELECT * FROM {} ORDER BY id".format(table))
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def count(db_path, table):
    """Row count for `table` (convenience for callers/tests)."""
    if table not in _TABLES:
        raise ValueError("unknown table {!r}".format(table))
    conn = connect(db_path)
    try:
        cur = conn.execute("SELECT COUNT(*) AS n FROM {}".format(table))
        return cur.fetchone()["n"]
    finally:
        conn.close()


def export_csv(db_path, table, csv_path, cols):
    """Export `table` to `csv_path` as a derived full-file mirror.

    Layout: line 1 = the AUTO-GENERATED preamble (Source: <db_path>); line 2 =
    the header; then one line per row, in `cols` order. Atomic: write a temp
    file then rename over the target.
    """
    rows = select_all(db_path, table)
    resolved_db = _resolve(db_path)
    lines = [core.csv_preamble(resolved_db), core.csv_header(cols)]
    lines.extend(core.csv_encode_row(r, cols) for r in rows)
    body = "\n".join(lines) + "\n"

    out = os.path.abspath(os.path.expanduser(csv_path))
    parent = os.path.dirname(out)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(body)
    os.replace(tmp, out)
    return len(rows)
