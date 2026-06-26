"""Tests for the shared sh.py I/O helpers (#41). Twin of js/sh.test.js.

    python3 -m unittest discover -s py
"""
import io
import sys
import unittest

import sh as shmod


class ShHelpers(unittest.TestCase):
    def test_sh_returns_stdout(self):
        self.assertEqual(shmod.sh("printf hi"), "hi")

    def test_sh_allow_fail_returns_none(self):
        self.assertIsNone(shmod.sh("exit 3", allow_fail=True))

    def test_sh_raises_without_allow_fail(self):
        with self.assertRaises(Exception):
            shmod.sh("exit 3")

    def test_sh_capture_ok(self):
        self.assertEqual(shmod.sh_capture("printf hi"), {"ok": True, "out": "hi"})

    def test_sh_capture_failure_merges_stderr(self):
        r = shmod.sh_capture("echo boom >&2; exit 1")
        self.assertFalse(r["ok"])
        self.assertIn("boom", r["out"])

    def test_sh_trim(self):
        self.assertEqual(shmod.sh_trim('echo "  hi  "'), "hi")
        self.assertEqual(shmod.sh_trim("exit 1"), "")

    def test_make_log_tags_output(self):
        buf = io.StringIO()
        orig = sys.stdout
        sys.stdout = buf
        try:
            shmod.make_log("demo")("hello")
        finally:
            sys.stdout = orig
        self.assertEqual(buf.getvalue(), "[demo] hello\n")

    def test_make_die_is_callable(self):
        self.assertTrue(callable(shmod.make_die("demo")))


if __name__ == "__main__":
    unittest.main()
