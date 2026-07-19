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


class ParseIssueListRows(unittest.TestCase):
    """parse_issue_list_rows: pure mapping of a `gh issue list --json
    number,state,labels` payload to reconcile-ready rows (#88). Mirrors js."""

    def test_maps_list_payload_to_rows(self):
        out = json.dumps([
            {"number": 5, "state": "OPEN", "labels": [{"name": "blocked"}, {"name": "bug"}]},
            {"number": 6, "state": "OPEN", "labels": [{"name": "blocked"}]},
        ])
        self.assertEqual(provider.parse_issue_list_rows(out), [
            {"number": 5, "state": "OPEN", "labels": ["blocked", "bug"], "blockedByCount": 0},
            {"number": 6, "state": "OPEN", "labels": ["blocked"], "blockedByCount": 0},
        ])

    def test_null_garbage_or_empty_returns_empty(self):
        self.assertEqual(provider.parse_issue_list_rows(None), [])
        self.assertEqual(provider.parse_issue_list_rows("not json"), [])
        self.assertEqual(provider.parse_issue_list_rows("[]"), [])


class ParseIssueStateRows(unittest.TestCase):
    """parse_issue_state_rows: the BATCHED plural mapping of a `gh issue list
    --state all --json number,state,labels,blockedBy` array to reconcile-ready
    rows (#42). Unlike parse_issue_list_rows it KEEPS blockedByCount so the
    batched issue_states preserves the BLOCKED overlay's relation signal (#87).
    Mirrors js parseIssueStateRows."""

    def test_maps_keeping_blocked_by_and_both_states(self):
        out = json.dumps([
            {"number": 5, "state": "OPEN", "labels": [{"name": "blocked"}],
             "blockedBy": {"totalCount": 3}},
            {"number": 6, "state": "CLOSED", "labels": [{"name": "bug"}]},
        ])
        self.assertEqual(provider.parse_issue_state_rows(out), [
            {"number": 5, "state": "OPEN", "labels": ["blocked"], "blockedByCount": 3},
            {"number": 6, "state": "CLOSED", "labels": ["bug"], "blockedByCount": 0},
        ])

    def test_drops_non_open_closed_and_offline_returns_empty(self):
        out = json.dumps([
            {"number": 1, "state": "OPEN", "labels": []},
            {"number": 2, "state": "DRAFT", "labels": []},
        ])
        self.assertEqual(provider.parse_issue_state_rows(out),
                         [{"number": 1, "state": "OPEN", "labels": [], "blockedByCount": 0}])
        self.assertEqual(provider.parse_issue_state_rows(None), [])
        self.assertEqual(provider.parse_issue_state_rows("not json"), [])
        self.assertEqual(provider.parse_issue_state_rows("{}"), [])


class SelectStateRows(unittest.TestCase):
    """select_state_rows: pure filter+fallback decision for batched issue_states
    (#42) — return the batch rows matching the requested numbers plus the
    requested numbers the batch MISSED (which get a per-view fallback). Mirrors
    js selectStateRows."""

    def test_filters_to_requested_and_reports_missing(self):
        batch = [
            {"number": 5, "state": "OPEN", "labels": [], "blockedByCount": 0},
            {"number": 6, "state": "CLOSED", "labels": [], "blockedByCount": 0},
            {"number": 8, "state": "OPEN", "labels": [], "blockedByCount": 0},
        ]
        rows, missing = provider.select_state_rows([5, 7, 6], batch)
        self.assertEqual(rows, [
            {"number": 5, "state": "OPEN", "labels": [], "blockedByCount": 0},
            {"number": 6, "state": "CLOSED", "labels": [], "blockedByCount": 0},
        ])
        self.assertEqual(missing, [7])

    def test_empty_batch_everything_missing(self):
        rows, missing = provider.select_state_rows([3, 4], [])
        self.assertEqual(rows, [])
        self.assertEqual(missing, [3, 4])


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


class ParseCreatedIssueNumber(unittest.TestCase):
    """parse_created_issue_number: pure mapping of `gh issue create` stdout (a URL)
    → the new issue number (#111). None on unparseable/offline."""

    def test_reads_issues_number_from_url(self):
        self.assertEqual(
            provider.parse_created_issue_number("https://github.com/o/r/issues/42"), 42)
        self.assertEqual(
            provider.parse_created_issue_number("Creating issue\nhttps://github.com/o/r/issues/1360\n"), 1360)

    def test_null_or_garbage_is_none(self):
        self.assertIsNone(provider.parse_created_issue_number(None))
        self.assertIsNone(provider.parse_created_issue_number(""))
        self.assertIsNone(provider.parse_created_issue_number("no url here"))

    def test_gitlab_stub_create_issue_raises(self):
        with self.assertRaises(NotImplementedError):
            provider.GitLabProvider().create_issue("t", "b", [])


if __name__ == "__main__":
    unittest.main()
