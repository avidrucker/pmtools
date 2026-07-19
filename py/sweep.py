#!/usr/bin/env python3
"""pmtools sweep — delete stale claim refs whose issue is CLOSED (#71).

Usage:
    sweep.py [--dry-run] [--host github|gitlab]

Lists `refs/claims/*` on origin, resolves each claimed issue's state via the host
provider, and deletes ONLY the refs whose issue is CONFIRMED CLOSED
(`classify_sweep_targets`). OPEN / in-flight / unknown (offline) refs are NEVER
touched — an active claim is a live worktree lock. This is the explicit,
auditable alternative to hand-running `git push origin :refs/claims/issue-N`,
which `claim` only ever *nagged* about. `--dry-run` reports what WOULD be swept,
deleting nothing.

Exit `0` on success or nothing-to-do; a **usage error** (unknown flag/host) → `2`;
a host not yet implemented or a delete that left a ref behind → `1`. Twin of
js/sweep.js.
"""
import subprocess
import sys

from provider import get_provider
from claim_core import parse_claim_refs, classify_sweep_targets
from claimref import delete_claim_ref
from sh import make_die, make_log, wants_help

die = make_die("sweep")
log = make_log("sweep")

# The command's own usage line — printed on a bad invocation (exit 2) and on
# `--help` (exit 0, #117). Single source so the error and help paths never drift.
USAGE = "usage: sweep [--dry-run] [--host github|gitlab]"


def _run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    except Exception:
        return ""


def parse_args(argv):
    opts = {"dryRun": False, "host": "github"}
    i, n = 0, len(argv)
    while i < n:
        a = argv[i]
        if a == "--dry-run":
            opts["dryRun"] = True
        elif a == "--host":
            i += 1
            opts["host"] = argv[i] if i < n else None
        elif a.startswith("--"):
            die("unknown flag: {}\n{}".format(a, USAGE), 2)
        else:
            die("sweep takes no positional args (got '{}')\n{}".format(a, USAGE), 2)
        i += 1
    return opts


def _list_claims():
    return parse_claim_refs(_run(["git", "ls-remote", "origin", "refs/claims/*"]))


def main(argv):
    if wants_help(argv):  # #117 command-aware --help
        print(USAGE)
        return 0
    opts = parse_args(argv)
    if opts["host"] not in ("github", "gitlab"):
        die("unknown host '{}' (expected github or gitlab)".format(opts["host"]), 2)
    try:
        provider = get_provider(opts["host"])
    except Exception:
        die("unknown host '{}' (expected github or gitlab)".format(opts["host"]), 2)

    claim_numbers = _list_claims()
    if not claim_numbers:
        log("no claim refs on origin — nothing to sweep.")
        return 0

    try:
        states = provider.issue_states(claim_numbers)
    except NotImplementedError:
        die("host '{}' not yet supported".format(opts["host"]), 1)

    targets = classify_sweep_targets(claim_numbers, states)
    if not targets:
        log("{} claim ref(s) on origin, none resolve to CLOSED — nothing to sweep.".format(
            len(claim_numbers)))
        return 0

    listed = " ".join("#{}".format(t) for t in targets)
    if opts["dryRun"]:
        log("WOULD SWEEP {} closed-issue claim ref(s): {}".format(len(targets), listed))
        for t in targets:
            log("  git push origin :refs/claims/issue-{}".format(t))
        return 0

    for t in targets:
        delete_claim_ref(t, log)

    remaining = set(_list_claims())
    failures = [t for t in targets if t in remaining]
    if failures:
        die("could not delete: {} (still on origin — check permissions)".format(
            " ".join("#{}".format(f) for f in failures)), 1)
    log("SWEEP OK removed {} claim ref(s): {}".format(len(targets), listed))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
