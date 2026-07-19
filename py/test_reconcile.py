"""Golden-fixture test for the pure `reconcile` core (see ../CONTRACT.md).

Stdlib unittest — no third-party deps, runs anywhere:
    python3 -m unittest discover -s py
"""
import json
import pathlib
import unittest

from reconcile import reconcile

FIXTURES = pathlib.Path(__file__).resolve().parent.parent / "fixtures"


def _load(name):
    return json.loads((FIXTURES / name).read_text())


class TestReconcile(unittest.TestCase):
    def test_basic_fixture(self):
        data = _load("basic.input.json")
        expected = _load("basic.expected.json")
        result = reconcile(data["grep"], data["worktrees"], data["issues"])
        self.assertEqual(result, expected)

    def test_inprogress_fixture(self):
        # #77: @inprogress + live worktree → IN-PROGRESS (distinct from a @todo
        # CLAIMED), while @inprogress with no worktree stays STALE.
        data = _load("inprogress.input.json")
        expected = _load("inprogress.expected.json")
        result = reconcile(data["grep"], data["worktrees"], data["issues"])
        self.assertEqual(result, expected)

    def test_blocked_fixture(self):
        # #78: the `blocked` label sets a blocked:true overlay, orthogonal to the
        # lifecycle status (202 is IN-PROGRESS *and* blocked); a non-blocked row
        # carries blocked:false (not only the true case).
        data = _load("blocked.input.json")
        expected = _load("blocked.expected.json")
        result = reconcile(data["grep"], data["worktrees"], data["issues"])
        self.assertEqual(result, expected)

    def test_blocked_by_relation_fixture(self):
        # #87: 300 has no `blocked` label but blockedByCount:2 → blocked:true;
        # 301 has neither → blocked:false. The overlay reflects the relation.
        data = _load("blocked-by-relation.input.json")
        expected = _load("blocked-by-relation.expected.json")
        result = reconcile(data["grep"], data["worktrees"], data["issues"])
        self.assertEqual(result, expected)

    def test_markerless_blocked_fixture(self):
        # #88: 300 already has a marker (no synthetic dupe); 400 (with worktree)
        # and 401 (no worktree) are marker-less blocked → synthetic BLOCKED rows
        # appended after markers, with null file/line/keyword.
        data = _load("markerless-blocked.input.json")
        expected = _load("markerless-blocked.expected.json")
        result = reconcile(data["grep"], data["worktrees"], data["issues"], data["blockedIssues"])
        self.assertEqual(result, expected)

    def test_strict_helper_counts_stale(self):
        data = _load("basic.input.json")
        result = reconcile(data["grep"], data["worktrees"], data["issues"])
        self.assertEqual(len(result["stale"]), 2)


if __name__ == "__main__":
    unittest.main()
