#!/usr/bin/env python3
"""release.py — abandon a claim + tear down its worktree WITHOUT closing the
issue (#22; "unclaim"). The cleanup half of close.py, minus land-on-main +
provider-close. Faithful twin of js/release.js; pure decisions live in
close_core. Ported from lccjs scripts/release.js.

  1. Delete the cross-clone claim ref (reuses close_core's refspec + classifier;
     best-effort + idempotent; --no-verify so a messy tree can't block its own
     cleanup — pmtools ships no hooks, but the flag keeps it portable).
  2. Remove the worktree + branch + prune (SYNCHRONOUS teardown). Reverts any
     uncommitted @inprogress flip for free.
  3. Leave the issue OPEN — no commit, no push, no provider close.
  4. Data-loss guard FIRST: refuse if the branch has commits not on origin/main
     OR the worktree is dirty — unless --force — printing what would be lost.

Usage:  pmtools release <issue> [--force]
Exit:   0 on success / nothing-to-do; 1 on bad args or a guard refusal.
"""
import os
import re
import subprocess
import sys

from close_core import (
    is_safe_ref, claim_ref_delete_command, classify_claim_ref_delete,
    parse_worktree_porcelain, find_worktree_for_issue, release_guard_verdict,
)
from sh import sh, sh_trim, make_die, make_log


def git_capture(args):
    """arg-array git exec (#37): values are argv, never re-parsed by a shell.
    Returns trimmed stdout (mirrors sh_trim). Used for every git call that
    interpolates the porcelain-parsed branch / worktree path."""
    res = subprocess.run(["git", *args], stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True)
    return (res.stdout or "").strip()


log = make_log("release")
die = make_die("release")


def parse_args(argv):
    a = {"issue": None, "force": False}
    for t in argv:
        if t == "--force":
            a["force"] = True
        elif t == "--":
            continue
        elif re.match(r"^\d+$", t):
            if a["issue"] is not None:
                die("unexpected extra arg: {} (usage: release <N> [--force])".format(t), 2)
            a["issue"] = t
        else:
            die("unknown arg: {} (usage: release <N> [--force])".format(t), 2)
    if a["issue"] is None:
        die("usage: release <issue-number> [--force]", 2)
    return a


def delete_claim_ref(issue):
    out = sh("{} --no-verify 2>&1 || true".format(claim_ref_delete_command(issue)), True) or ""
    verdict = classify_claim_ref_delete(out)
    if verdict == "DELETED":
        log("claim ref refs/claims/issue-{} deleted.".format(issue))
    elif verdict == "ABSENT":
        log("claim ref refs/claims/issue-{} already absent — no-op.".format(issue))
    else:
        log("warn: could not delete claim ref refs/claims/issue-{} "
            "(best-effort; continuing).".format(issue))


def main():
    args = parse_args(sys.argv[1:])
    issue, force = args["issue"], args["force"]
    rows = parse_worktree_porcelain(sh_trim("git worktree list --porcelain"))
    root = rows[0]["path"] if rows else sh_trim("git rev-parse --show-toplevel")
    wt = find_worktree_for_issue(rows, issue)

    if not wt:
        # Orphan claim ref (no worktree): free the ref so the issue is re-claimable.
        delete_claim_ref(issue)
        log("no worktree found for #{} — nothing to tear down.".format(issue))
        log("#{} left as-is (OPEN unless already closed elsewhere).".format(issue))
        return

    wt_path, branch = wt["path"], wt["branch"]
    # Injection guard (#37): the branch (parsed from `git worktree list`) is
    # interpolated into git rev-list / log / branch -D — refuse unsafe characters.
    if branch and not is_safe_ref(branch):
        die('worktree branch "{}" contains unsafe characters — refusing to operate on it.'.format(branch))

    # --- data-loss guard FIRST — a refused release leaves the claim + worktree intact.
    if not force:
        sh("git fetch origin -q", True)
        ahead_raw = git_capture(["rev-list", "--count", "origin/main..{}".format(branch)])
        ahead = int(ahead_raw) if ahead_raw.isdigit() else 0
        dirty = git_capture(["-C", wt_path, "status", "--porcelain"])
        verdict = release_guard_verdict(ahead, bool(dirty), False)
        if verdict == "unpushed":
            die("#{} branch {} has {} commit(s) NOT on origin/main — release would discard them:\n".format(
                issue, branch, ahead)
                + git_capture(["log", "origin/main..{}".format(branch), "--oneline"])
                + "\n  Land them on the right ticket first, or re-run with --force to discard.")
        if verdict == "dirty":
            die("worktree {} has uncommitted changes — release would discard them:\n".format(wt_path)
                + dirty + "\n  Commit/stash what you want to keep, or re-run with --force to discard.")

    # --- claim ref (only now that the guard passed / --force) ---
    delete_claim_ref(issue)

    # --- teardown: synchronous from the main root (mirrors close.py; reverts any
    #     uncommitted @inprogress flip for free; leaves the issue OPEN). ---
    log("releasing #{}: worktree {} + branch {} — issue stays OPEN.".format(issue, wt_path, branch))
    try:
        os.chdir(root)
    except OSError:
        pass
    # arg-array exec (#37): the branch/path never reach a shell.
    git_capture(["worktree", "remove", "--force", wt_path])
    if branch:
        git_capture(["branch", "-D", branch])
    git_capture(["worktree", "prune"])
    if wt_path in git_capture(["worktree", "list", "--porcelain"]):
        sys.stderr.write("[release] warning: teardown may have failed — check: git worktree list\n")
    log('Shell re-root: cd "{}"'.format(root))


if __name__ == "__main__":
    main()
