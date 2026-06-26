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
from status_core import parse_canonical_marker, parse_pddignore, is_pdd_ignored
from config import load_pdd_config
from sh import make_die

DEFAULT_BRANCH_PATTERN = r"^(?:br-)?(?P<agent>[a-z0-9]+)/(?:[a-z0-9]+-[a-z0-9]+-)?issue-(?P<issue>\d+)"


die = make_die("status")


def parse_args(argv):
    """Hand-rolled, faithful twin of js/status.js parseArgs (was argparse, which
    diverged from JS on unknown-flag handling + exit code). Unknown --flags die."""
    a = {"strict": False, "json": False, "host": "github",
         "branchPattern": DEFAULT_BRANCH_PATTERN, "limit": 50}
    i = 0
    n = len(argv)
    while i < n:
        t = argv[i]
        if t == "--strict":
            a["strict"] = True
        elif t == "--json":
            a["json"] = True
        elif t == "--host":
            i += 1; a["host"] = argv[i] if i < n else None
        elif t == "--branch-pattern":
            i += 1; a["branchPattern"] = argv[i] if i < n else DEFAULT_BRANCH_PATTERN
        elif t == "--limit":
            i += 1
            try:
                a["limit"] = int(argv[i]) if i < n else 50
            except (TypeError, ValueError):
                a["limit"] = 50
        elif t.startswith("--"):
            die("unknown flag: " + t, 2)
        i += 1
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


def grep_markers(ignore_patterns=None):
    """[{file,line,keyword,issue}] for canonical PDD markers, honoring .pddignore.

    A grep hit counts only when (a) its file is not .pddignore-excluded and
    (b) its text is a canonical `@(todo|inprogress) #N:<estimate>` marker —
    incidental prose and estimate-less mentions are dropped (the #1458 flood)."""
    ignore_patterns = ignore_patterns or []
    out = _run(["git", "grep", "-nE", r"@(todo|inprogress)"])
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


def list_worktrees(branch_pattern):
    """[{branch,issue,agent}] parsed from `git worktree list --porcelain`."""
    rx = re.compile(_js_to_py_named_groups(branch_pattern))
    out = _run(["git", "worktree", "list", "--porcelain"])
    rows = []
    for raw in out.splitlines():
        if not raw.startswith("branch "):
            continue
        branch = raw[len("branch "):].strip().replace("refs/heads/", "", 1)
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
    glyph = {"IDLE": "·", "CLAIMED": "▶", "STALE": "✗"}
    for m in report["markers"]:
        wt = f" [{m['worktree']}]" if m["worktree"] else ""
        lines.append(
            f"{glyph.get(m['status'], '?')} #{m['issue']:<5} {m['status']:<8} "
            f"{m['state']:<8} {m['file']}:{m['line']} ({m['keyword']}){wt}"
        )
    if report["stale"]:
        lines.append("")
        lines.append(f"{len(report['stale'])} STALE marker(s) — clean up.")
    return "\n".join(lines) if lines else "(no issue-linked markers found)"


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
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

    report = reconcile(grep, worktrees, issues)

    if args["json"]:
        print(json.dumps(report, indent=2))
    else:
        print(render_table(report))

    if args["strict"] and report["stale"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
