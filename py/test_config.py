"""Tests for main-repo identity resolution (#26). Stdlib unittest only.

Per-project STATE (DB path, scratch dir, the `repo` data column) must key off the
MAIN checkout, so every worktree of one repo shares one identity. The bug:
resolving via `--show-toplevel` returns the *worktree* in a worktree. These tests
build a real repo + worktree and pin the corrected resolution.

    python3 -m unittest discover -s py
"""
import os
import subprocess
import tempfile
import unittest

import config


def _git(cwd, *args):
    return subprocess.run(["git", "-C", cwd, *args],
                          capture_output=True, text=True).stdout.strip()


def _repo_with_worktree():
    d = tempfile.mkdtemp(prefix="pmtools-mainroot-")
    main = os.path.join(d, "myrepo")
    os.makedirs(main)
    _git(main, "init", "-q")
    _git(main, "config", "user.email", "t@e.com")
    _git(main, "config", "user.name", "t")
    with open(os.path.join(main, "f.txt"), "w") as fh:
        fh.write("x")
    _git(main, "add", "-A")
    _git(main, "commit", "-qm", "init")
    wt = os.path.join(d, "wt-issue-99")
    _git(main, "worktree", "add", "-q", wt, "HEAD")
    return main, wt


class MainRepoRoot(unittest.TestCase):
    def test_repo_root_from_worktree_is_the_worktree(self):
        _main, wt = _repo_with_worktree()
        self.assertEqual(os.path.basename(config.repo_root(wt)), "wt-issue-99")

    def test_main_repo_root_from_worktree_resolves_main(self):
        _main, wt = _repo_with_worktree()
        self.assertEqual(os.path.basename(config.main_repo_root(wt)), "myrepo")

    def test_main_repo_root_in_plain_checkout_matches_repo_root(self):
        main, _wt = _repo_with_worktree()
        self.assertEqual(os.path.basename(config.main_repo_root(main)), "myrepo")
        self.assertEqual(os.path.basename(config.repo_root(main)), "myrepo")

    def test_default_db_path_keys_off_main_from_worktree(self):
        _main, wt = _repo_with_worktree()
        db = config.default_db_path(config.main_repo_root(wt))
        self.assertEqual(os.path.basename(os.path.dirname(db)), "myrepo")


if __name__ == "__main__":
    unittest.main()
