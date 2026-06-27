"""Provider-seam parity tests (#40). Stdlib unittest only.

The two ports must expose the same provider surface. JS routed velocity's
title-fetch through `provider.issueTitle`, but the Python `GitHubProvider` had no
`issue_title` and `py/velocity.py` inlined its own `gh` shell-out — so the same
capability lived on opposite sides of the pure/impure boundary, and a future
gitlab adapter would get the method in JS but not PY. These pin the parity.

    python3 -m unittest discover -s py
"""
import json
import unittest

import provider
import velocity


class ParseIssueStateRow(unittest.TestCase):
    """parse_issue_state_row: pure mapping of a `gh issue view
    --json state,labels,blockedBy` payload to a reconcile-ready row (#87).
    Tested with canned JSON, no gh shell-out. Mirrors js parseIssueStateRow."""

    def test_surfaces_blocked_by_count(self):
        out = json.dumps({"state": "OPEN", "labels": [{"name": "bug"}],
                          "blockedBy": {"nodes": [], "totalCount": 2}})
        self.assertEqual(provider.parse_issue_state_row(out, 7),
                         {"number": 7, "state": "OPEN", "labels": ["bug"], "blockedByCount": 2})

    def test_blocked_by_count_defaults_to_zero(self):
        out = json.dumps({"state": "CLOSED", "labels": []})
        self.assertEqual(provider.parse_issue_state_row(out, 9),
                         {"number": 9, "state": "CLOSED", "labels": [], "blockedByCount": 0})

    def test_null_garbage_or_non_open_closed_returns_none(self):
        self.assertIsNone(provider.parse_issue_state_row(None, 1))
        self.assertIsNone(provider.parse_issue_state_row("not json", 1))
        self.assertIsNone(provider.parse_issue_state_row(json.dumps({"state": "DRAFT"}), 1))


class IssueTitleParity(unittest.TestCase):
    def test_github_provider_exposes_issue_title(self):
        gh = provider.GitHubProvider()
        self.assertTrue(callable(getattr(gh, "issue_title", None)),
                        "GitHubProvider must expose issue_title (parity with js issueTitle)")

    def test_gitlab_provider_stubs_issue_title(self):
        gl = provider.GitLabProvider()
        with self.assertRaises(NotImplementedError):
            gl.issue_title(123)


class VelocityDelegatesToProvider(unittest.TestCase):
    def test_fetch_title_routes_through_provider(self):
        """velocity.fetch_title must delegate to the provider's issue_title,
        not inline its own gh shell-out (the #40 boundary bug)."""
        calls = []

        class FakeProvider:
            def issue_title(self, number):
                calls.append(number)
                return "fetched-title"

        orig = velocity.get_provider
        velocity.get_provider = lambda host: FakeProvider()
        try:
            result = velocity.fetch_title(42)
        finally:
            velocity.get_provider = orig

        self.assertEqual(result, "fetched-title")
        self.assertEqual(calls, [42],
                         "fetch_title should call provider.issue_title(ticket) exactly once")


if __name__ == "__main__":
    unittest.main()
