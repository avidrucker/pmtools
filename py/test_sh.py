"""Tests for the shared sh.py I/O helpers (#41). Twin of js/sh.test.js.

    python3 -m unittest discover -s py
"""
import io
import os
import sys
import tempfile
import time
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

    def test_sh_capture_timeout_kills_over_limit(self):  # #107
        t0 = time.monotonic()
        r = shmod.sh_capture("sleep 5", timeout_sec=1)
        elapsed = time.monotonic() - t0
        self.assertFalse(r["ok"])
        self.assertTrue(r.get("timedOut"))
        self.assertIn("timed out after 1s", r["out"])
        self.assertLess(elapsed, 3.0)

    def test_sh_capture_under_limit_returns_normally(self):  # #107
        self.assertEqual(shmod.sh_capture("printf hi", timeout_sec=5), {"ok": True, "out": "hi"})

    def test_sh_capture_timeout_kills_whole_process_group(self):  # #107
        # A backgrounded grandchild touches a sentinel 2s in, while the shell keeps
        # running — so the command stays a live parent with a live child. Strict
        # group-kill (start_new_session + killpg) must reap the grandchild at the 1s
        # timeout, so the sentinel is NEVER created. This is the no-orphan guarantee.
        d = tempfile.mkdtemp()
        sentinel = os.path.join(d, "grandchild_alive")
        cmd = "(sleep 2; touch {}) & sleep 5".format(sentinel)
        r = shmod.sh_capture(cmd, timeout_sec=1)
        self.assertTrue(r.get("timedOut"))
        time.sleep(1.6)  # past t=2s, when the grandchild WOULD have touched the file
        self.assertFalse(os.path.exists(sentinel),
                         "group-kill must reap the backgrounded grandchild")

    def test_git_capture_ok(self):
        r = shmod.git_capture(["--version"])
        self.assertTrue(r["ok"])
        self.assertIn("git version", r["out"])

    def test_git_capture_failure(self):
        self.assertFalse(shmod.git_capture(["not-a-real-subcommand-xyz"])["ok"])

    def test_git_trim(self):
        self.assertTrue(shmod.git_trim(["--version"]).startswith("git version"))
        self.assertEqual(shmod.git_trim(["not-a-real-subcommand-xyz"]), "")

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
