"""Golden-fixture tests for the pure ICE core. Stdlib unittest only.

Loads every fixtures/ice/<fn>.cases.json, dispatches the snake_case stem to the
corresponding ice_core callable, and asserts f(*args) == expected OR, for cases
marked "expected_error": true, asserts f(*args) raises ValueError. The dispatch
map must match the fixture files 1:1 (same invariant as test_store_core.py). The
JS twin (js/ice_core.test.js) grades the SAME fixtures.

    python3 -m unittest discover -s py
"""
import json
import pathlib
import unittest

import ice_core

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICE_FIXTURES = ROOT / "fixtures" / "ice"


def _load(path):
    return json.loads(pathlib.Path(path).read_text())


# fixture stem -> pure callable
ICE_DISPATCH = {
    "compute_ice": ice_core.compute_ice,
    "rank_rows": ice_core.rank_rows,
    "derive_auto_score": ice_core.derive_auto_score,
    "validate_ice_row": ice_core.validate_ice_row,
}


class TestIceCoreFixtures(unittest.TestCase):
    def test_ice_fixtures(self):
        stems = {p.stem.replace(".cases", "")
                 for p in ICE_FIXTURES.glob("*.cases.json")}
        self.assertEqual(stems, set(ICE_DISPATCH),
                         "fixture files and dispatch map must match 1:1 in ice")
        for stem, fn in ICE_DISPATCH.items():
            cases = _load(ICE_FIXTURES / "{}.cases.json".format(stem))
            for case in cases:
                with self.subTest(fn=stem, case=case["name"]):
                    if case.get("expected_error"):
                        with self.assertRaises(ValueError):
                            fn(*case["args"])
                    else:
                        self.assertEqual(fn(*case["args"]), case["expected"])


class TestIceCoreConstants(unittest.TestCase):
    def test_cols_shape(self):
        self.assertEqual(ice_core.ICE_COLS[0], "id")
        self.assertEqual(ice_core.ICE_COLS[1], "issue")
        self.assertIn("ice_rank", ice_core.ICE_CSV_COLS)
        self.assertNotIn("ice_rank", ice_core.ICE_COLS)
        self.assertNotIn("id", ice_core.ICE_CSV_COLS)

    def test_vocabularies(self):
        self.assertEqual(ice_core.VALID_C, (0.5, 0.8, 1.0))
        self.assertIn(0.25, ice_core.VALID_I)
        self.assertIn(10, ice_core.VALID_E)


if __name__ == "__main__":
    unittest.main()
