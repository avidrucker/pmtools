"""Golden-fixture tests for the pure preflight core. Stdlib unittest only.

Loads fixtures/preflight/{issue_gate,evidence}.cases.json and asserts
f(*args) == expected, the SAME fixtures the JS harness grades.

    python3 -m unittest discover -s py
"""
import json
import pathlib
import unittest

from preflight_core import preflight_issue_gate, preflight_evidence

FIXTURES = pathlib.Path(__file__).resolve().parent.parent / "fixtures" / "preflight"


def _load(name):
    return json.loads((FIXTURES / name).read_text())


DISPATCH = {
    "issue_gate": preflight_issue_gate,
    "evidence": preflight_evidence,
}


class TestPreflightCoreFixtures(unittest.TestCase):
    def test_all_preflight_fixtures(self):
        for stem, fn in DISPATCH.items():
            cases = _load("{}.cases.json".format(stem))
            for case in cases:
                with self.subTest(fn=stem, case=case["name"]):
                    self.assertEqual(fn(*case["args"]), case["expected"])


if __name__ == "__main__":
    unittest.main()
