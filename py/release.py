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
    claim_ref_delete_command, classify_claim_ref_delete,
    parse_worktree_porcelain, find_worktree_for_issue, release_guard_verdict,
)


def sh(cmd, allow_fail=False):
    try:
        return subprocess.run(cmd, shell=True, check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout
    except subprocess.CalledProcessError:
        if allow_fail:
            return None
        raise


def sh_capture(cmd):
    res = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True)
    return (res.stdout or "").strip()


def log(m):
    print("[release] {}".format(m))


def die(m):
    sys.stderr.write("[release] ✗ {}\n".format(m))
    sys.exit(1)


def parse_args(argv):
    a = {"issue": None, "force": False}
    for t in argv:
        if t == "--force":
            a["force"] = True
        elif t == "--":
            continue
        elif re.match(r"^\d+$", t):
            if a["issue"] is not None:
                die("unexpected extra arg: {} (usage: release <N> [--force])".format(t))
            a["issue"] = t
        else:
            die("unknown arg: {} (usage: release <N> [--force])".format(t))
    if a["issue"] is None:
        die("usage: release <issue-number> [--force]")
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
    rows = parse_worktree_porcelain(sh_capture("git worktree list --porcelain"))
    root = rows[0]["path"] if rows else sh_capture("git rev-parse --show-toplevel")
    wt = find_worktree_for_issue(rows, issue)

    if not wt:
        # Orphan claim ref (no worktree): free the ref so the issue is re-claimable.
        delete_claim_ref(issue)
        log("no worktree found for #{} — nothing to tear down.".format(issue))
        log("#{} left as-is (OPEN unless already closed elsewhere).".format(issue))
        return

    wt_path, branch = wt["path"], wt["branch"]

    # --- data-loss guard FIRST — a refused release leaves the claim + worktree intact.
    if not force:
        sh("git fetch origin -q", True)
        ahead_raw = sh_capture("git rev-list --count origin/main..{}".format(branch))
        ahead = int(ahead_raw) if ahead_raw.isdigit() else 0
        dirty = sh_capture('git -C "{}" status --porcelain'.format(wt_path))
        verdict = release_guard_verdict(ahead, bool(dirty), False)
        if verdict == "unpushed":
            die("#{} branch {} has {} commit(s) NOT on origin/main — release would discard them:\n".format(
                issue, branch, ahead)
                + sh_capture("git log origin/main..{} --oneline".format(branch))
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
    rm_branch = " && git branch -D {}".format(branch) if branch else ""
    sh_capture('git worktree remove --force "{}"{} && git worktree prune'.format(wt_path, rm_branch))
    if wt_path in sh_capture("git worktree list --porcelain"):
        sys.stderr.write("[release] warning: teardown may have failed — check: git worktree list\n")
    log('Shell re-root: cd "{}"'.format(root))


if __name__ == "__main__":
    main()
