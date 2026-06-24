"""Regression tests for the IMPURE sqlite engine's connect() dedup-gating (#10).

A pre-existing ("legacy") DB whose velocity table holds duplicate
(ticket, agent, started_iso) rows must NOT be rendered unloggable: connect()
runs on every write to EITHER store, so the velocity unique index must be
dedup-gated (detect dups -> skip + warn) rather than abort all logging.

    python3 -m unittest discover -s py
"""
import contextlib
import io
import os
import sqlite3
import tempfile
import unittest

import store


def _tmp_db(name):
    d = tempfile.mkdtemp(prefix="pmtools-store-")
    return os.path.join(d, name)


def _has_uq_index(db):
    conn = sqlite3.connect(db)
    try:
        row = conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='index' AND name='uq_velocity_session'"
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def _seed_legacy_dup_db():
    """velocity table WITHOUT the unique index, holding duplicate rows (#10 state)."""
    db = _tmp_db("legacy.db")
    conn = sqlite3.connect(db)
    conn.executescript(store.CREATE_VELOCITY)
    conn.execute(
        "INSERT INTO velocity (ticket, agent, started_iso) "
        "VALUES (1, 'X', '2026-01-01T00:00:00-1000')")
    conn.execute(
        "INSERT INTO velocity (ticket, agent, started_iso) "
        "VALUES (1, 'X', '2026-01-01T00:00:00-1000')")
    conn.commit()
    conn.close()
    return db


class ConnectDedupGate(unittest.TestCase):
    def test_errors_logging_not_aborted_by_legacy_dups(self):
        db = _seed_legacy_dup_db()
        with contextlib.redirect_stderr(io.StringIO()):
            rid = store.insert(db, "errors",
                               {"occurred_iso": "2026-01-01T00:00:00-1000", "message": "x"})
        self.assertIsInstance(rid, int)
        self.assertGreater(rid, 0)

    def test_velocity_logging_still_inserts_against_legacy_dups(self):
        db = _seed_legacy_dup_db()
        with contextlib.redirect_stderr(io.StringIO()):
            rid = store.insert(db, "velocity",
                               {"ticket": 2, "agent": "Y",
                                "started_iso": "2026-02-02T00:00:00-1000"})
        self.assertIsInstance(rid, int)
        self.assertGreater(rid, 0)

    def test_connect_dedup_gates_and_warns(self):
        db = _seed_legacy_dup_db()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            store.connect(db).close()
        self.assertIsNone(_has_uq_index(db),
                          "unique index must stay absent while dups exist")
        self.assertIn("uq_velocity_session", err.getvalue(),
                      "must warn that the index was skipped")

    def test_fresh_db_creates_uq_index(self):
        db = _tmp_db("fresh.db")
        store.connect(db).close()
        self.assertEqual(_has_uq_index(db), "uq_velocity_session")

    def test_fresh_db_still_enforces_unique_session(self):
        db = _tmp_db("fresh2.db")
        row = {"ticket": 3, "agent": "Z", "started_iso": "2026-03-03T00:00:00-1000"}
        store.insert(db, "velocity", row)
        with self.assertRaises(sqlite3.IntegrityError):
            store.insert(db, "velocity", row)


if __name__ == "__main__":
    unittest.main()
