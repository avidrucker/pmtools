"""Render tests for the Python status port. Mirrors js/status.test.js.

    python3 -m unittest discover -s py
"""
import json
import unittest

import status
from reconcile import reconcile

# Canned `git grep -nE @(todo|inprogress)` output (format "file:line:content").
# The injected raw_out arg exercises grep_markers' parsing + .pddignore filter
# without shelling out to git (#46). Mirrors js/status.test.js CANNED_GREP.
CANNED_GREP = (
    "js/foo.js:10:  // @todo #42:30 do the thing\n"
    "docs/skip.md:3:  // @todo #99:15m should be ignored\n"
    "bar.py:5:  not a canonical marker here\n"
    "baz.js:20:// @inprogress #7:45 wip\n"
)

CANNED_PORCELAIN = (
    "worktree /repo/main\nHEAD aaa\nbranch refs/heads/main\n\n"
    "worktree /repo/.claude/worktrees/grape-issue-22\nHEAD bbb\nbranch refs/heads/grape/issue-22\n\n"
    "worktree /repo/detached\nHEAD ccc\ndetached\n"
)


class GrepMarkersCanned(unittest.TestCase):
    def test_keeps_canonical_drops_prose_honors_pddignore(self):
        markers = status.grep_markers(["docs/**"], CANNED_GREP)
        self.assertEqual(markers, [
            {"file": "js/foo.js", "line": 10, "keyword": "@todo", "issue": 42},
            {"file": "baz.js", "line": 20, "keyword": "@inprogress", "issue": 7},
        ])

    def test_empty_output_no_markers(self):
        self.assertEqual(status.grep_markers([], ""), [])


class ListWorktreesCanned(unittest.TestCase):
    def test_extracts_agent_issue_from_matching_branches_only(self):
        rows = status.list_worktrees(r"^(?P<agent>[a-z]+)/issue-(?P<issue>\d+)", CANNED_PORCELAIN)
        self.assertEqual(rows, [{"branch": "grape/issue-22", "issue": 22, "agent": "grape"}])


class StatusJsonSchema(unittest.TestCase):
    """Schema snapshot for `status --json` (#46): locks the serialized report
    shape (reconcile output + the claims field status.main attaches) so a field
    rename or drop is caught. Mirrors js/status.test.js."""

    def test_top_level_and_per_marker_keys_are_stable(self):
        report = reconcile(
            [{"file": "a.py", "line": 1, "keyword": "@todo", "issue": 5}],
            [{"branch": "grape/issue-5", "issue": 5, "agent": "grape"}],
            [{"number": 5, "state": "OPEN", "labels": ["blocked"]}],
        )
        report["claims"] = [5]  # the cross-clone in-flight signal main() appends

        parsed = json.loads(json.dumps(report, indent=2))
        self.assertEqual(sorted(parsed.keys()), ["claims", "markers", "stale"])
        self.assertEqual(
            sorted(parsed["markers"][0].keys()),
            ["blocked", "file", "issue", "keyword", "line", "state", "status", "worktree"],
        )
        self.assertIsInstance(parsed["claims"][0], int)
        self.assertIsInstance(parsed["stale"], list)


class RenderBlockedOverlay(unittest.TestCase):
    def test_blocked_row_shows_glyph_non_blocked_does_not(self):
        # #78: the ⛔ overlay is rendered per row from the `blocked` field,
        # orthogonal to the lifecycle status; a non-blocked row stays clean.
        report = {
            "markers": [
                {"issue": 5, "file": "a.py", "line": 1, "keyword": "@todo",
                 "state": "OPEN", "worktree": None, "status": "IDLE", "blocked": True},
                {"issue": 6, "file": "b.py", "line": 2, "keyword": "@todo",
                 "state": "OPEN", "worktree": None, "status": "IDLE", "blocked": False},
            ],
            "stale": [],
        }
        lines = status.render_table(report).split("\n")
        self.assertIn("⛔", lines[0], "blocked row should show the ⛔ overlay")
        self.assertNotIn("⛔", lines[1], "non-blocked row should not show ⛔")


if __name__ == "__main__":
    unittest.main()
