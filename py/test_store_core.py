"""Golden-fixture tests for the pure store core. Stdlib unittest only.

Loads every fixtures/{error,velocity}/<fn>.cases.json, dispatches the snake_case
name to the corresponding callable, and either asserts f(*args) == expected OR,
for cases marked `"expected_error": true`, asserts f(*args) raises ValueError.

The `expected_error` convention is LANGUAGE-NEUTRAL: the future JS port reads the
same fixtures and asserts a thrown error for those cases.

    python3 -m unittest discover -s py
"""
import json
import pathlib
import unittest

import store_core

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
ERROR_FIXTURES = FIXTURES / "error"
VELOCITY_FIXTURES = FIXTURES / "velocity"


def _load(path):
    return json.loads(pathlib.Path(path).read_text())


# Map each fixture file stem -> the pure callable it grades.
ERROR_DISPATCH = {
    "validate_error_row": store_core.validate_error_row,
    "csv_encode_row": store_core.csv_encode_row,
    "parse_args": store_core.parse_store_args,
    "resolve_csv": store_core.resolve_csv,
}
VELOCITY_DISPATCH = {
    "validate_velocity_row": store_core.validate_velocity_row,
    "derive_delta": store_core.derive_delta,
    "csv_encode_row": store_core.csv_encode_row,
    "parse_args": store_core.parse_store_args,
    "resolve_csv": store_core.resolve_csv,
}


class TestStoreCoreFixtures(unittest.TestCase):
    def _run_suite(self, fixtures_dir, dispatch):
        stems = {p.stem.replace(".cases", "")
                 for p in fixtures_dir.glob("*.cases.json")}
        self.assertEqual(stems, set(dispatch),
                         "fixture files and dispatch map must match 1:1 in {}"
                         .format(fixtures_dir.name))
        for stem, fn in dispatch.items():
            cases = _load(fixtures_dir / "{}.cases.json".format(stem))
            for case in cases:
                with self.subTest(fn=stem, case=case["name"]):
                    if case.get("expected_error"):
                        with self.assertRaises(ValueError):
                            fn(*case["args"])
                    else:
                        self.assertEqual(fn(*case["args"]), case["expected"])

    def test_error_fixtures(self):
        self._run_suite(ERROR_FIXTURES, ERROR_DISPATCH)

    def test_velocity_fixtures(self):
        self._run_suite(VELOCITY_FIXTURES, VELOCITY_DISPATCH)


class TestStoreCoreConstants(unittest.TestCase):
    def test_error_cols_match_schema_order(self):
        self.assertEqual(store_core.ERROR_COLS[0], "id")
        self.assertIn("occurred_iso", store_core.ERROR_COLS)
        self.assertEqual(len(store_core.ERROR_COLS), 10)

    def test_velocity_cols_match_schema_order(self):
        self.assertEqual(store_core.VELOCITY_COLS[0], "id")
        self.assertIn("delta_h_min", store_core.VELOCITY_COLS)
        self.assertEqual(len(store_core.VELOCITY_COLS), 16)

    def test_error_types_vocabulary(self):
        self.assertIn("CLAIM_FAIL", store_core.ERROR_TYPES)
        self.assertIn("BEHAVIORAL_FAIL", store_core.ERROR_TYPES)
        self.assertEqual(len(store_core.ERROR_TYPES), 17)

    def test_valid_roles_vocabulary(self):
        self.assertIn("DEV", store_core.VALID_ROLES)
        self.assertIn("REVIEW", store_core.VALID_ROLES)
        self.assertEqual(len(store_core.VALID_ROLES), 11)

    def test_csv_preamble_names_source(self):
        self.assertIn("AUTO-GENERATED", store_core.csv_preamble("/x/y.db"))
        self.assertIn("/x/y.db", store_core.csv_preamble("/x/y.db"))


if __name__ == "__main__":
    unittest.main()
