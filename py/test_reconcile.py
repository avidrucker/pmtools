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

    def test_strict_helper_counts_stale(self):
        data = _load("basic.input.json")
        result = reconcile(data["grep"], data["worktrees"], data["issues"])
        self.assertEqual(len(result["stale"]), 2)


if __name__ == "__main__":
    unittest.main()
