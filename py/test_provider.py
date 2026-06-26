"""Provider-seam parity tests (#40). Stdlib unittest only.

The two ports must expose the same provider surface. JS routed velocity's
title-fetch through `provider.issueTitle`, but the Python `GitHubProvider` had no
`issue_title` and `py/velocity.py` inlined its own `gh` shell-out — so the same
capability lived on opposite sides of the pure/impure boundary, and a future
gitlab adapter would get the method in JS but not PY. These pin the parity.

    python3 -m unittest discover -s py
"""
import unittest

import provider
import velocity


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
