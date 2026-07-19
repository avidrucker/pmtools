"""Tests for the ice persistence layer (#101): the CREATE_ICE table + upsert +
the storage.ice config block. Stdlib unittest only.

    python3 -m unittest discover -s py
"""
import os
import sqlite3
import tempfile
import unittest

import config
import store


def _tmp_db(name="ice.db"):
    return os.path.join(tempfile.mkdtemp(prefix="pmtools-ice-"), name)


def _table_exists(db, name):
    conn = sqlite3.connect(db)
    try:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (name,)).fetchone()
        return row is not None
    finally:
        conn.close()


class IceTable(unittest.TestCase):
    def test_connect_creates_ice_table_idempotently(self):
        db = _tmp_db()
        store.connect(db).close()
        self.assertTrue(_table_exists(db, "ice"))
        # second connect must not raise (idempotent)
        store.connect(db).close()
        self.assertTrue(_table_exists(db, "ice"))

    def test_ice_in_tables_and_insert_cols(self):
        self.assertIn("ice", store._TABLES)
        self.assertEqual(store._INSERT_COLS["ice"][0], "issue")
        self.assertNotIn("id", store._INSERT_COLS["ice"])

    def test_upsert_replaces_by_issue(self):
        db = _tmp_db()
        store.upsert(db, "ice", {"issue": 1360, "ice_score": 4.0, "tier": ""})
        store.upsert(db, "ice", {"issue": 1360, "ice_score": 8.0, "tier": "critical"})
        rows = store.select_all(db, "ice")
        self.assertEqual(store.count(db, "ice"), 1)          # replaced, not appended
        self.assertEqual(rows[0]["issue"], 1360)
        self.assertEqual(rows[0]["ice_score"], 8.0)          # latest value won
        self.assertEqual(rows[0]["tier"], "critical")

    def test_two_distinct_issues_coexist(self):
        db = _tmp_db()
        store.upsert(db, "ice", {"issue": 1, "ice_score": 1.0})
        store.upsert(db, "ice", {"issue": 2, "ice_score": 2.0})
        self.assertEqual(store.count(db, "ice"), 2)


class IceConfig(unittest.TestCase):
    def test_default_storage_has_ice_block(self):
        cfg = config.load_storage_config(tempfile.mkdtemp(prefix="pmtools-norepo-"))
        self.assertIn("ice", cfg)
        self.assertEqual(cfg["ice"],
                         {"enabled": False, "csvMirror": None, "logCommand": None})

    def test_orchestrate_ice_block_merges(self):
        import json
        import subprocess
        d = tempfile.mkdtemp(prefix="pmtools-icecfg-")
        subprocess.run(["git", "-C", d, "init", "-q"], check=True)
        os.makedirs(os.path.join(d, ".claude"))
        with open(os.path.join(d, ".claude", "orchestrate.json"), "w") as fh:
            json.dump({"storage": {"ice": {"enabled": True, "csvMirror": "docs/ice.csv"}}}, fh)
        cfg = config.load_storage_config(d)
        self.assertTrue(cfg["ice"]["enabled"])
        self.assertEqual(cfg["ice"]["csvMirror"], "docs/ice.csv")
        self.assertIsNone(cfg["ice"]["logCommand"])  # default preserved


if __name__ == "__main__":
    unittest.main()
