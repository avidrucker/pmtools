"""Golden-fixture tests for the pure close core. Stdlib unittest only.

Loads every fixtures/close/<fn>.cases.json, dispatches the snake_case name to the
corresponding callable, and asserts f(*args) == expected.

    python3 -m unittest discover -s py
"""
import json
import pathlib
import unittest

import close_core

ROOT = pathlib.Path(__file__).resolve().parent.parent
CLOSE_FIXTURES = ROOT / "fixtures" / "close"
RELEASE_FIXTURES = ROOT / "fixtures" / "release"


def _load(path):
    return json.loads(pathlib.Path(path).read_text())


# A couple of fixture fns take a stop-set / union-set that JSON encodes as an
# array; Python wants a set/list. extract_keywords' optional 2nd arg is a stop
# set; classify_rebase_conflict's 2nd arg stays a list (membership works on it).
def _extract_keywords(*args):
    if len(args) == 2:
        return close_core.extract_keywords(args[0], set(args[1]))
    return close_core.extract_keywords(*args)


DISPATCH = {
    "is_safe_ref": close_core.is_safe_ref,
    "classify_push_error": close_core.classify_push_error,
    "should_cleanup": close_core.should_cleanup,
    "claim_ref_delete_command": close_core.claim_ref_delete_command,
    "classify_claim_ref_delete": close_core.classify_claim_ref_delete,
    "classify_rebase_conflict": close_core.classify_rebase_conflict,
    "body_closes_issue": close_core.body_closes_issue,
    "pushed_commit_references_issue": close_core.pushed_commit_references_issue,
    "unsupported_flag_hint": close_core.unsupported_flag_hint,
    "extract_keywords": _extract_keywords,
    "keywords_overlap": close_core.keywords_overlap,
    "marker_still_present": close_core.marker_still_present,
    "scope_audit_diff_command": close_core.scope_audit_diff_command,
    "velocity_row_present": close_core.velocity_row_present,
    "velocity_ticket_mismatch": close_core.velocity_ticket_mismatch,
    "compute_velocity_mismatch": close_core.compute_velocity_mismatch,
    "is_velocity_csv_only_conflict": close_core.is_velocity_csv_only_conflict,
    "is_markdown_index_only_conflict": close_core.is_markdown_index_only_conflict,
    "resolve_append_only_markdown_conflict": close_core.resolve_append_only_markdown_conflict,
    "find_parent_trackers": close_core.find_parent_trackers,
    "tick_checkbox_for_issue": close_core.tick_checkbox_for_issue,
    "parse_worktree_porcelain": close_core.parse_worktree_porcelain,
    "find_worktree_for_issue": close_core.find_worktree_for_issue,
    "resolve_close_branch": close_core.resolve_close_branch,
    "preclose_plan": close_core.preclose_plan,
    "release_guard_verdict": close_core.release_guard_verdict,
}


class TestCloseCoreFixtures(unittest.TestCase):
    def test_every_fixture_has_a_dispatch_entry(self):
        stems = {p.stem.replace(".cases", "") for p in CLOSE_FIXTURES.glob("*.cases.json")}
        self.assertEqual(stems, set(DISPATCH), "fixture files and dispatch map must match 1:1")

    def test_all_close_fixtures(self):
        for stem, fn in DISPATCH.items():
            cases = _load(CLOSE_FIXTURES / "{}.cases.json".format(stem))
            for case in cases:
                with self.subTest(fn=stem, case=case["name"]):
                    result = fn(*case["args"])
                    self.assertEqual(result, case["expected"])

    def test_stop_set_and_short_tech_words_exported(self):
        self.assertIn("research", close_core.KEYWORD_STOP_SET)
        self.assertIn("data", close_core.KEYWORD_STOP_SET)
        self.assertIn("cli", close_core.SHORT_TECH_WORDS)

    def test_union_files_default_empty(self):
        # The pmtools port treats any rebase conflict as blocking; the lccjs
        # union auto-resolve set is out of scope.
        self.assertEqual(close_core.UNION_FILES, [])


class TestReleaseParseArgsFixtures(unittest.TestCase):
    """release shares close_core; its pure arg parser is graded from a separate
    fixtures/release/ dir (#46). expected_error cases assert the parser raises
    (the impure release.py wrapper turns the raise into a usage die)."""

    RELEASE_DISPATCH = {
        "parse_args": close_core.parse_release_args,
    }

    def test_every_fixture_has_a_dispatch_entry(self):
        stems = {p.stem.replace(".cases", "") for p in RELEASE_FIXTURES.glob("*.cases.json")}
        self.assertEqual(stems, set(self.RELEASE_DISPATCH), "fixture files and dispatch map must match 1:1")

    def test_all_release_fixtures(self):
        for stem, fn in self.RELEASE_DISPATCH.items():
            cases = _load(RELEASE_FIXTURES / "{}.cases.json".format(stem))
            for case in cases:
                with self.subTest(fn=stem, case=case["name"]):
                    if case.get("expected_error"):
                        with self.assertRaises(ValueError):
                            fn(*case["args"])
                    else:
                        self.assertEqual(fn(*case["args"]), case["expected"])


if __name__ == "__main__":
    unittest.main()
