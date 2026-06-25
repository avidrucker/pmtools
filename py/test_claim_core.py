"""Golden-fixture tests for the pure claim core. Stdlib unittest only.

Loads every fixtures/claim/<fn>.cases.json, dispatches the snake_case name to the
corresponding callable, and asserts f(*args) == expected. Also re-checks the
shared status reconcile edge fixtures so the new edge cases are covered here too.

    python3 -m unittest discover -s py
"""
import json
import pathlib
import unittest

import claim_core
from reconcile import reconcile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
CLAIM_FIXTURES = FIXTURES / "claim"


def _load(path):
    return json.loads(pathlib.Path(path).read_text())


# Map each fixture file stem -> the pure callable it grades.
DISPATCH = {
    "slugify": claim_core.slugify,
    "is_safe_ref": claim_core.is_safe_ref,
    "normalize_identity": claim_core.normalize_identity,
    "infer_fruit_from_branch": claim_core.infer_fruit_from_branch,
    "resolve_identity": claim_core.resolve_identity,
    "parse_args": claim_core.parse_args,
    "check_identity_name": claim_core.check_identity_name,
    "assess_base_staleness": claim_core.assess_base_staleness,
    "sentinel_branch": claim_core.sentinel_branch,
    "is_sentinel_stale_by_age": claim_core.is_sentinel_stale_by_age,
    "apply_marker_flip": claim_core.apply_marker_flip,
    "worktrees_with_issue": claim_core.worktrees_with_issue,
    "find_live_worktree_for_issue": claim_core.find_live_worktree_for_issue,
    "find_same_issue_collision": claim_core.find_same_issue_collision,
    "should_block_worktree_guard": claim_core.should_block_worktree_guard,
    "should_block_claim": claim_core.should_block_claim,
    "needs_area_label": claim_core.needs_area_label,
    "should_block_uncategorized": claim_core.should_block_uncategorized,
    "classify_claim_push_result": claim_core.classify_claim_push_result,
    "build_claim_message": claim_core.build_claim_message,
    "claim_push_action": claim_core.claim_push_action,
    "claim_ref_is_stale": claim_core.claim_ref_is_stale,
    "build_banner_lines": claim_core.build_banner_lines,
}


class TestClaimCoreFixtures(unittest.TestCase):
    def test_every_fixture_has_a_dispatch_entry(self):
        stems = {p.stem.replace(".cases", "") for p in CLAIM_FIXTURES.glob("*.cases.json")}
        self.assertEqual(stems, set(DISPATCH), "fixture files and dispatch map must match 1:1")

    def test_all_claim_fixtures(self):
        for stem, fn in DISPATCH.items():
            cases = _load(CLAIM_FIXTURES / "{}.cases.json".format(stem))
            for case in cases:
                with self.subTest(fn=stem, case=case["name"]):
                    result = fn(*case["args"])
                    self.assertEqual(result, case["expected"])

    def test_fruits_roster_matches_lccjs_source(self):
        # Ported verbatim from lccjs claim.js FRUITS (27 items; the task brief said
        # "28-item" but the actual source list is 27 — fidelity over the brief).
        self.assertEqual(len(claim_core.FRUITS), 27)
        self.assertIn("apple", claim_core.FRUITS)
        self.assertIn("zucchini", claim_core.FRUITS)


class TestStatusEdgeFixtures(unittest.TestCase):
    """The three new status reconcile edge fixtures (empty / two-worktrees /
    same-issue-two-markers), graded against the same golden output the JS port uses."""

    EDGE = ["empty", "two-worktrees", "same-issue-two-markers"]

    def test_edge_fixtures(self):
        for name in self.EDGE:
            with self.subTest(fixture=name):
                data = _load(FIXTURES / "{}.input.json".format(name))
                expected = _load(FIXTURES / "{}.expected.json".format(name))
                result = reconcile(data["grep"], data["worktrees"], data["issues"])
                self.assertEqual(result, expected)


if __name__ == "__main__":
    unittest.main()
