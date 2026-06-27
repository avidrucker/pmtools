"""Render tests for the Python status port. Mirrors js/status.test.js.

    python3 -m unittest discover -s py
"""
import unittest

import status


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
