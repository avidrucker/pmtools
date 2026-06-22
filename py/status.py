#!/usr/bin/env python3
"""pmtools status — reconcile @todo/@inprogress markers vs worktrees + issues.

Usage:
    status.py [--strict] [--json] [--host github|gitlab]
              [--branch-pattern <regex>] [--limit N]

Gathers the three reconcile inputs from the live repo (git grep, git worktree
list, host provider), calls the pure reconcile core, and renders a table or
JSON. Exit 0 always, except --strict with >=1 STALE marker -> exit 1.
"""
import argparse
import json
import re
import subprocess
import sys

from reconcile import reconcile
from provider import get_provider

DEFAULT_BRANCH_PATTERN = r"^(?P<agent>[a-z]+)/issue-(?P<issue>\d+)"
_MARKER_RE = re.compile(r"@(todo|inprogress)\b", re.IGNORECASE)
_ISSUE_RE = re.compile(r"#(\d+)")


def _js_to_py_named_groups(pattern):
    """Accept JS-style (?<name>...) and normalize to Python (?P<name>...)."""
    return re.sub(r"\(\?<([a-zA-Z_]\w*)>", r"(?P<\1>", pattern)


def _run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    except Exception:
        return ""


def grep_markers():
    """[{file,line,keyword,issue}] for issue-linked @todo/@inprogress markers."""
    out = _run(["git", "grep", "-nE", r"@(todo|inprogress)"])
    markers = []
    for raw in out.splitlines():
        # git grep -n => "file:line:content"
        parts = raw.split(":", 2)
        if len(parts) < 3:
            continue
        file, line, content = parts
        km = _MARKER_RE.search(content)
        im = _ISSUE_RE.search(content)
        if not km or not im:
            continue  # only issue-linked markers participate in status
        markers.append({
            "file": file,
            "line": int(line),
            "keyword": "@" + km.group(1).lower(),
            "issue": int(im.group(1)),
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
    ap = argparse.ArgumentParser(prog="pmtools status")
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--host", default="github")
    ap.add_argument("--branch-pattern", default=DEFAULT_BRANCH_PATTERN)
    ap.add_argument("--limit", type=int, default=50)
    args = ap.parse_args(argv)

    grep = grep_markers()
    worktrees = list_worktrees(args.branch_pattern)
    provider = get_provider(args.host)
    issue_numbers = sorted({m["issue"] for m in grep})
    issues = provider.issue_states(issue_numbers)

    report = reconcile(grep, worktrees, issues)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(render_table(report))

    if args.strict and report["stale"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
