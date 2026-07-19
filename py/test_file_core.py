"""Golden-fixture tests for the pure file core (#111). Stdlib unittest only.

Loads fixtures/file/*.cases.json (the SAME files js/file_core.test.js grades) and
asserts file_gate_verdict(*args) == expected. The dispatch map matches the fixture
files 1:1 (same invariant as the other cores).

    python3 -m unittest discover -s py
"""
import json
import pathlib
import unittest

from file_core import file_gate_verdict

FIXTURES = pathlib.Path(__file__).resolve().parent.parent / "fixtures" / "file"


def _load(name):
    return json.loads((FIXTURES / name).read_text())


DISPATCH = {"gate_verdict": file_gate_verdict}


class TestFileCoreFixtures(unittest.TestCase):
    def test_dispatch_matches_fixtures_1to1(self):
        stems = {p.stem.replace(".cases", "") for p in FIXTURES.glob("*.cases.json")}
        self.assertEqual(stems, set(DISPATCH),
                         "fixture files and dispatch map must match 1:1 in file")

    def test_all_file_fixtures(self):
        for stem, fn in DISPATCH.items():
            for case in _load("{}.cases.json".format(stem)):
                with self.subTest(fn=stem, case=case["name"]):
                    self.assertEqual(fn(*case["args"]), case["expected"])


if __name__ == "__main__":
    unittest.main()
