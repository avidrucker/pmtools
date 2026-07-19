"""Unit tests for the velocity wrapper's fetch_title seam (#46). Mirrors
js/velocity.test.js. Stdlib unittest only.

fetch_title delegates to a host provider's issue_title; the provider is
injectable so we can test it with a canned/throwing stand-in instead of shelling
out to `gh`. The stand-in is a tiny object, not a mock framework.

    python3 -m unittest discover -s py
"""
import unittest

import velocity


class _CannedProvider:
    def __init__(self, title=None, raises=False):
        self._title = title
        self._raises = raises

    def issue_title(self, n):
        if self._raises:
            raise RuntimeError("gh offline")
        return self._title


class FetchTitleSeam(unittest.TestCase):
    def test_returns_provider_supplied_title(self):
        self.assertEqual(
            velocity.fetch_title(42, _CannedProvider(title="Some title")),
            "Some title",
        )

    def test_returns_none_when_provider_raises(self):
        self.assertIsNone(velocity.fetch_title(42, _CannedProvider(raises=True)))

    def test_returns_none_when_provider_yields_none(self):
        self.assertIsNone(velocity.fetch_title(42, _CannedProvider(title=None)))


if __name__ == "__main__":
    unittest.main()
