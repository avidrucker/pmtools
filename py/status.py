#!/usr/bin/env python3
"""pmtools status — reconcile @todo/@inprogress markers vs worktrees + issues.

Usage:
    status.py [--strict] [--json] [--host github|gitlab]
              [--branch-pattern <regex>] [--limit N]

Gathers the three reconcile inputs from the live repo (git grep, git worktree
list, host provider), calls the pure reconcile core, and renders a table or
JSON. Exit 0 always, except --strict with >=1 STALE marker -> exit 1.
"""
import json
import os
import re
import subprocess
import sys

from reconcile import reconcile
from provider import get_provider
from status_core import (parse_canonical_marker, parse_pddignore, is_pdd_ignored,
                         filter_open_claims, parse_args as core_parse_args)
from claim_core import parse_claim_refs, CANONICAL_BRANCH_PATTERN
from config import load_pdd_config
from sh import make_die, wants_help
from close_core import parse_worktree_porcelain

# Delegate to the canonical branch pattern (claim_core, the single source of truth)
# so reconciliation sees all three schemes — standard `…-<N>`, self-describing
# `…-issue-<N>`, legacy `<fruit>/issue-<N>` — not only the `issue-`-token forms
# (#135). It exposes the same `agent`/`issue` named groups list_worktrees reads.
DEFAULT_BRANCH_PATTERN = CANONICAL_BRANCH_PATTERN


die = make_die("status")

# The command's own usage line — printed on a bad flag (exit 2) and on `--help`
# (exit 0, #117). Single source so the error and help paths never drift.
USAGE = ("usage: status [--strict] [--json] [--host github|gitlab] "
         "[--branch-pattern RX] [--limit N]")


def parse_args(argv):
    """Thin impure wrapper over the shared pure parser (status_core, #46): an
    unknown flag raises there; here we turn it into a usage die (exit 2) and
    substitute this port's DEFAULT_BRANCH_PATTERN when none was supplied (the
    default's named-group syntax is port-specific, so it lives here, not the core)."""
    try:
        a = core_parse_args(argv)
    except ValueError as e:
        die("{}\n{}".format(e, USAGE), 2)
    if not a["branchPattern"]:
        a["branchPattern"] = DEFAULT_BRANCH_PATTERN
    return a


def _js_to_py_named_groups(pattern):
    """Accept JS-style (?<name>...) and normalize to Python (?P<name>...)."""
    return re.sub(r"\(\?<([a-zA-Z_]\w*)>", r"(?P<\1>", pattern)


def _run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    except Exception:
        return ""


def load_ignore_patterns(ignore_file=".pddignore", warn_if_absent=False):
    """Impure: read the repo-root <ignore_file> (gitignore-style globs) into a
    pattern list. Absent file -> [] (+ a one-line stderr warn when
    warn_if_absent, so an enabled-but-unconfigured repo knows it is scanning
    everything). #15 honors the ignore file; #16 makes the scan toggle-able."""
    root = _run(["git", "rev-parse", "--show-toplevel"]).strip()
    if not root:
        return []
    try:
        with open(os.path.join(root, ignore_file), encoding="utf-8") as fh:
            return parse_pddignore(fh.read())
    except OSError:
        if warn_if_absent:
            sys.stderr.write(
                "[status] pdd enabled but no {} — scanning all tracked files.\n".format(ignore_file))
        return []


def grep_markers(ignore_patterns=None, raw_out=None):
    """[{file,line,keyword,issue}] for canonical PDD markers, honoring .pddignore.

    A grep hit counts only when (a) its file is not .pddignore-excluded and
    (b) its text is a canonical `@(todo|inprogress) #N:<estimate>` marker —
    incidental prose and estimate-less mentions are dropped (the #1458 flood)."""
    ignore_patterns = ignore_patterns or []
    # raw_out is injectable (#46): pass canned `git grep` output to unit-test the
    # parsing + .pddignore filter without shelling out; None → run git for real.
    out = raw_out if raw_out is not None else _run(["git", "grep", "-nE", r"@(todo|inprogress)"])
    markers = []
    for raw in out.splitlines():
        # git grep -n => "file:line:content"
        parts = raw.split(":", 2)
        if len(parts) < 3:
            continue
        file, line, content = parts
        if is_pdd_ignored(file, ignore_patterns):
            continue
        parsed = parse_canonical_marker(content)
        if not parsed:
            continue
        markers.append({
            "file": file,
            "line": int(line),
            "keyword": parsed["keyword"],
            "issue": parsed["issue"],
        })
    return markers


def list_worktrees(branch_pattern, porcelain=None):
    """[{branch,issue,agent}] parsed from `git worktree list --porcelain`.

    porcelain is injectable (#46): pass canned output to unit-test the
    branch-pattern extraction; None → run git for real."""
    rx = re.compile(_js_to_py_named_groups(branch_pattern))
    # Reuse the canonical pure porcelain parser (#74); keep status's regex
    # extraction + null-safety (parser tolerates None/empty).
    out = porcelain if porcelain is not None else _run(["git", "worktree", "list", "--porcelain"])
    rows = []
    for r in parse_worktree_porcelain(out):
        branch = r["branch"]
        if not branch:
            continue
        m = rx.search(branch)
        if not m:
            continue
        rows.append({
            "branch": branch,
            "issue": int(m.group("issue")),
            "agent": m.group("agent"),
        })
    return rows


def render_table(report):
    lines = []
    glyph = {"IDLE": "·", "CLAIMED": "▶", "IN-PROGRESS": "↻", "STALE": "✗", "BLOCKED": "⛔"}
    for m in report["markers"]:
        wt = f" [{m['worktree']}]" if m["worktree"] else ""
        # Overlay glyph (#78), orthogonal to status — but a BLOCKED row already
        # shows ⛔ as its status glyph, so don't double it (#88).
        blocked = " ⛔" if (m.get("blocked") and m["status"] != "BLOCKED") else ""
        # Synthetic marker-less rows (#88) have no file/line/keyword.
        loc = "(no marker)" if m["file"] is None else f"{m['file']}:{m['line']} ({m['keyword']})"
        lines.append(
            f"{glyph.get(m['status'], '?')} #{m['issue']:<5} {m['status']:<8} "
            f"{m['state']:<8} {loc}{wt}{blocked}"
        )
    if report["stale"]:
        lines.append("")
        lines.append(f"{len(report['stale'])} STALE marker(s) — clean up.")
    return "\n".join(lines) if lines else "(no issue-linked markers found)"


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if wants_help(argv):  # #117 command-aware --help
        print(USAGE)
        return 0
    args = parse_args(argv)

    # PDD marker scanning is config-gated (#16). When disabled, skip the scan
    # entirely; worktree + issue reconciliation still run.
    pdd = load_pdd_config()
    if pdd["enabled"]:
        grep = grep_markers(load_ignore_patterns(pdd["ignoreFile"], warn_if_absent=True))
    else:
        sys.stderr.write("[status] pdd disabled — skipping marker scan.\n")
        grep = []
    worktrees = list_worktrees(args["branchPattern"])
    # An unknown host fails get_provider (usage error, 2); a not-yet-implemented
    # host (gitlab) reaches a stub whose methods raise (operational, 1). Either
    # way: a clean die, never a raw traceback (#43). Twin of js/status.js.
    try:
        provider = get_provider(args["host"])
    except (ValueError, TypeError):
        die("unknown host '{}' (expected github or gitlab)".format(args["host"]), 2)
    issue_numbers = sorted({m["issue"] for m in grep})
    try:
        issues = provider.issue_states(issue_numbers)
    except NotImplementedError:
        die("host '{}' not yet supported".format(args["host"]), 1)

    # Marker-less blocked issues (#88): a `blocked`-labelled issue with no marker
    # would otherwise be invisible. One `gh issue list` call; best-effort (offline
    # -> []). Host is guaranteed github here (gitlab/unknown died above).
    try:
        blocked_issues = provider.list_issues_by_label("blocked")
    except NotImplementedError:
        blocked_issues = []

    report = reconcile(grep, worktrees, issues, blocked_issues)
    # Active claims (refs/claims/* on origin): the cross-clone-safe in-flight
    # signal an orchestrator should consume instead of git-worktree-list heuristics,
    # which miss sibling-clone worktrees and the br-/wt- naming scheme (#70).
    claim_numbers = parse_claim_refs(_run(["git", "ls-remote", "origin", "refs/claims/*"]))
    # Drop stale CLOSED claim refs so the in-flight signal is claims ∩ ¬CLOSED
    # (#81): a hand-closed issue leaves a dangling ref the sweep (#71) only clears
    # on the next claim. Reuse the marker-issue states already fetched; look up
    # only the claim issues whose state we don't yet know. Host is guaranteed
    # github here (a gitlab/unknown host already died above). Twin of js/status.js.
    claim_states = issues
    known_states = {s["number"] for s in issues}
    unknown_claims = [n for n in claim_numbers if n not in known_states]
    if unknown_claims:
        claim_states = issues + provider.issue_states(unknown_claims)
    report["claims"] = filter_open_claims(claim_numbers, claim_states)

    if args["json"]:
        print(json.dumps(report, indent=2))
    else:
        print(render_table(report))

    if args["strict"] and report["stale"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
