"""Golden-fixture tests for the pure status core (#15). Stdlib unittest only.

Loads every fixtures/status/<fn>.cases.json, dispatches the snake_case name to
the corresponding callable, and asserts f(*args) == expected.

    python3 -m unittest discover -s py
"""
import json
import pathlib
import unittest

import status_core

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATUS_FIXTURES = ROOT / "fixtures" / "status"


def _load(path):
    return json.loads(pathlib.Path(path).read_text())


DISPATCH = {
    "parse_canonical_marker": status_core.parse_canonical_marker,
    "parse_pddignore": status_core.parse_pddignore,
    "is_pdd_ignored": status_core.is_pdd_ignored,
}


class TestStatusCoreFixtures(unittest.TestCase):
    def test_every_fixture_has_a_dispatch_entry(self):
        stems = {p.stem.replace(".cases", "") for p in STATUS_FIXTURES.glob("*.cases.json")}
        self.assertEqual(stems, set(DISPATCH), "fixture files and dispatch map must match 1:1")

    def test_all_status_fixtures(self):
        for stem, fn in DISPATCH.items():
            for case in _load(STATUS_FIXTURES / "{}.cases.json".format(stem)):
                with self.subTest(fn=stem, case=case["name"]):
                    self.assertEqual(fn(*case["args"]), case["expected"])


if __name__ == "__main__":
    unittest.main()
