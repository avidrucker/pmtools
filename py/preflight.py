#!/usr/bin/env python3
"""preflight.py — guard task START (fleet workflow). Python twin of js/preflight.js
(seeded from lccjs scripts/preflight.js), reusing the pure preflight_core seams.

  preflight <issue> [--scratch-dir <dir>] [--evidence-dir <dir> ...]

  - scratch dir:   default ~/.pmtools/<repo>/ (<repo> = basename of git toplevel)
  - evidence dirs: default docs/logs, docs/research

Steps:
  1. Stamp started_iso to <scratchDir>/preflight-<issue>.iso.
  2. Start-of-task reads: git status, git worktree list, gh issue view.
  2.5 Surface in-repo evidence (<evidenceDirs>/<M>-*) for referenced #M.
  3. Assert the issue is OPEN; exit 1 otherwise (warn-and-proceed when gh offline).
"""
import json
import os
import re
import subprocess
import sys

import config
from preflight_core import preflight_issue_gate, preflight_evidence, DEFAULT_EVIDENCE_DIRS


def sh(cmd):
    """Run a command (list) and return combined best-effort stdout, else None."""
    try:
        out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, check=True)
        return out.stdout
    except subprocess.CalledProcessError as e:
        return (e.stdout or e.stderr) or None
    except FileNotFoundError:
        return None


def out(s):
    sys.stdout.write(re.sub(r"\n?$", "\n", str(s)))


def die(msg):
    sys.stderr.write("[preflight] ✗ {}\n".format(msg))
    sys.exit(1)


def indent(s):
    return re.sub(r"\s+$", "", re.sub(r"(?m)^", "    ", str(s or "")))


def list_evidence_files(evidence_dirs):
    acc = []
    for d in evidence_dirs:
        try:
            for name in os.listdir(d):
                acc.append("{}/{}".format(d, name))
        except OSError:
            pass  # dir absent — best-effort
    return acc


def default_scratch_dir():
    # Key the scratch dir off the MAIN checkout so worktrees don't scatter
    # ~/.pmtools/<worktree>/ dirs (#26).
    root = config.main_repo_root()
    repo = os.path.basename(root) if root else "repo"
    return os.path.join(os.path.expanduser("~"), ".pmtools", repo)


def parse_args(argv):
    a = {"issue": "", "scratchDir": None, "evidenceDirs": []}
    i = 0
    n = len(argv)
    while i < n:
        t = argv[i]
        if t == "--scratch-dir":
            i += 1; a["scratchDir"] = argv[i] if i < n else None
        elif t == "--evidence-dir":
            i += 1
            if i < n:
                a["evidenceDirs"].append(argv[i])
        elif not a["issue"]:
            a["issue"] = t
        i += 1
    if not a["scratchDir"]:
        a["scratchDir"] = default_scratch_dir()
    if not a["evidenceDirs"]:
        a["evidenceDirs"] = list(DEFAULT_EVIDENCE_DIRS)
    return a


def main(argv):
    args = parse_args(argv)
    issue = re.sub(r"^#", "", str(args["issue"] or ""))
    if not re.match(r"^\d+$", issue):
        die("usage: preflight <issue-number> [--scratch-dir D] [--evidence-dir D ...]")

    bar = "─" * 58
    out(bar); out("  PREFLIGHT  ·  issue #{}".format(issue)); out(bar)

    stamp = (sh(["date", "+%Y-%m-%dT%H:%M:%S%z"]) or "").strip()
    scratch = os.path.join(args["scratchDir"], "preflight-{}.iso".format(issue))
    try:
        os.makedirs(args["scratchDir"], exist_ok=True)
        with open(scratch, "w", encoding="utf-8") as f:
            f.write(stamp + "\n")
    except OSError:
        pass
    out("  started_iso   {}".format(stamp or "(date unavailable)"))
    out("  saved to      {}".format(scratch))
    out("")

    status = sh(["git", "status", "--short"])
    out("  git status --short:")
    out(indent(status) if status and status.strip() else "    (clean)")
    out("  git worktree list:")
    out(indent(sh(["git", "worktree", "list"])))
    out("")

    info = None
    raw = sh(["gh", "issue", "view", issue, "--json", "number,title,state,body,comments"])
    if raw:
        try:
            info = json.loads(raw)
        except (ValueError, TypeError):
            info = None
    body = ""
    comments = []
    if info:
        body = info.get("body") or ""
        comments = info["comments"] if isinstance(info.get("comments"), list) else []
        out("  #{} [{}] {}".format(info.get("number"), info.get("state"), info.get("title")))
        out("  body:")
        out(indent(body if body and body.strip() else "(no body)"))
        out("  comments ({}):".format(len(comments)))
        for c in comments:
            who = (c.get("author") or {}).get("login") or "unknown"
            out(indent("— @{} ({}):\n{}".format(who, c.get("createdAt") or "", (c.get("body") or "").strip())))
    else:
        out("  ⚠ gh issue view {} unavailable (offline?) — skipping issue read.".format(issue))
    out("")

    ref_text = "\n".join([body] + [(c.get("body") or "") for c in comments])
    evidence = preflight_evidence(ref_text, list_evidence_files(args["evidenceDirs"]), args["evidenceDirs"])
    out("  existing evidence — read these before writing findings:")
    if evidence:
        for p in evidence:
            out("    • {}".format(p))
    else:
        out("    (none found for referenced tickets)")
    out("")

    gate = preflight_issue_gate(info.get("state") if info else None)
    if gate.get("warn"):
        out("  ⚠ {}".format(gate["warn"]))
    if not gate["ok"]:
        die(gate["error"])

    out(bar)
    out("  PREFLIGHT OK  ·  #{} is OPEN  ·  started_iso stamped".format(issue))
    out("  next: claim #{} under your agent identity (fleet workflow).".format(issue))
    out(bar)


if __name__ == "__main__":
    main(sys.argv[1:])
