"""Wrapper-level tests for the ice CLI (#102): score (batch + --auto + dry-run),
list, export — with the gh provider FAKED and the store_cfg passed directly, so
no gh and no orchestrate.json are needed. Stdlib unittest only.

    python3 -m unittest discover -s py
"""
import contextlib
import io
import os
import tempfile
import unittest

import ice
import ice_core
import store
from sh import make_die

DIE = make_die("ice")
ENABLED = {"enabled": True, "csvMirror": None}


def _tmp_db():
    return os.path.join(tempfile.mkdtemp(prefix="pmtools-icecli-"), "ice.db")


class FakeProvider:
    def __init__(self, titles=None, states=None, listing=None):
        self._titles = titles or {}
        self._states = states or {}
        self._listing = listing or []

    def issue_title(self, n):
        return self._titles.get(n)

    def issue_states(self, nums):
        return {n: self._states.get(n, {}) for n in nums}

    def list_open_issues_with_labels(self, limit):
        return self._listing


def _run(argv, db, provider, cfg=ENABLED):
    a = ice._parse(argv)
    with contextlib.redirect_stdout(io.StringIO()) as out:
        rc = (ice._cmd_score(a, db, cfg, DIE, provider) if a["cmd"] == "score"
              else ice._cmd_list(a, db, cfg, DIE) if a["cmd"] == "list"
              else ice._cmd_export(a, db, cfg, DIE))
    return rc, out.getvalue()


class ScoreBatch(unittest.TestCase):
    def test_batch_upsert_and_rescore_replaces(self):
        db = _tmp_db()
        prov = FakeProvider(titles={5: "Five"}, states={5: {"labels": ["severity:low"]}})
        _run(["score", '{"5":{"I":1,"C":0.8,"E":5}}'], db, prov)
        rows = store.select_all(db, "ice")
        self.assertEqual(store.count(db, "ice"), 1)
        self.assertEqual(rows[0]["issue"], 5)
        self.assertEqual(rows[0]["ice_score"], 4.0)
        self.assertEqual(rows[0]["title"], "Five")
        self.assertEqual(rows[0]["labels"], "severity:low")
        self.assertEqual(rows[0]["provisional"], 0)
        # re-score same issue -> replace, not append
        _run(["score", '{"5":{"I":2,"C":0.8,"E":5}}'], db, prov)
        rows = store.select_all(db, "ice")
        self.assertEqual(store.count(db, "ice"), 1)
        self.assertEqual(rows[0]["ice_score"], 8.0)

    def test_priority_label_sets_tier(self):
        db = _tmp_db()
        prov = FakeProvider(states={9: {"labels": ["priority:critical"]}})
        _run(["score", '{"9":{"I":1,"C":1.0,"E":10}}'], db, prov)
        self.assertEqual(store.select_all(db, "ice")[0]["tier"], "critical")


class AutoSweep(unittest.TestCase):
    def test_auto_provisional_from_labels(self):
        db = _tmp_db()
        prov = FakeProvider(listing=[{"number": 7, "title": "Seven", "labels": ["severity:high"]}])
        _run(["score", "--auto"], db, prov)
        rows = store.select_all(db, "ice")
        self.assertEqual(rows[0]["issue"], 7)
        self.assertEqual(rows[0]["provisional"], 1)
        self.assertEqual(rows[0]["ice_score"], 8.0)  # I=2,C=0.8,E=5

    def test_auto_skips_already_scored(self):
        db = _tmp_db()
        store.upsert(db, "ice", {"issue": 7, "ice_score": 1.0})
        prov = FakeProvider(listing=[{"number": 7, "title": "x", "labels": ["severity:high"]}])
        _run(["score", "--auto"], db, prov)
        self.assertEqual(store.select_all(db, "ice")[0]["ice_score"], 1.0)  # untouched

    def test_dry_run_writes_nothing(self):
        db = _tmp_db()
        prov = FakeProvider(listing=[{"number": 7, "title": "x", "labels": ["research"]}])
        _run(["score", "--auto", "--dry-run"], db, prov)
        self.assertEqual(store.count(db, "ice"), 0)


class ListAndExport(unittest.TestCase):
    def test_export_ranked_csv(self):
        db = _tmp_db()
        store.upsert(db, "ice", {"issue": 10, "ice_score": 2.0})
        store.upsert(db, "ice", {"issue": 20, "ice_score": 5.0})
        csv = _tmp_db().replace(".db", ".csv")
        _run(["export", "--csv", csv], db, FakeProvider())
        with open(csv) as fh:
            lines = fh.read().splitlines()
        self.assertIn("AUTO-GENERATED", lines[0])
        self.assertEqual(lines[1], ",".join(ice_core.ICE_CSV_COLS))
        # higher score ranks first; ice_rank is column index 7 (0-based)
        self.assertTrue(lines[2].startswith("20,"))

    def test_list_json_ranked(self):
        db = _tmp_db()
        store.upsert(db, "ice", {"issue": 10, "ice_score": 2.0})
        store.upsert(db, "ice", {"issue": 20, "ice_score": 5.0})
        rc, out = _run(["list", "--json"], db, FakeProvider())
        self.assertEqual(rc, 0)
        import json
        ranked = json.loads(out)
        self.assertEqual(ranked[0]["issue"], 20)
        self.assertEqual(ranked[0]["ice_rank"], 1)


class Gating(unittest.TestCase):
    def test_disabled_store_is_noop(self):
        db = _tmp_db()
        rc, out = _run(["score", '{"5":{"I":1,"C":0.8,"E":5}}'], db,
                       FakeProvider(), cfg={"enabled": False, "csvMirror": None})
        self.assertEqual(rc, 0)
        self.assertIn("disabled", out)
        self.assertEqual(store.count(db, "ice"), 0)

    def test_unknown_flag_raises(self):
        with self.assertRaises(ValueError):
            ice._parse(["score", "--bogus"])


if __name__ == "__main__":
    unittest.main()
