#!/usr/bin/env python3
"""file.py — gated issue creation (`pmtools file`, alias `create`, #111). Python
twin of js/file.js. Wraps `gh issue create` through the provider, applying the pure
`file_gate_verdict` requirement gates BEFORE the issue exists; on success it echoes
the VERIFIED number read back from the create response (which structurally prevents
the concurrent-create number race, pycats#541).

  pmtools file --title "<t>" [--area A] [--role R] [--body S | --body-file F]
               [--label L ...] [--severity S] [--dry-run] [--allow-uncategorized]

Exit codes: 0 created / clean dry-run; 2 usage error; 1 hard gate block or provider
create failure (nothing created).
"""
import json
import re
import sys

import config
import provider as provider_mod
from sh import make_die, wants_help
from file_core import file_gate_verdict

die = make_die("file")

USAGE = ("usage: file --title T [--area A] [--role R] [--body S | --body-file F] "
         "[--label L ...] [--severity S] [--dry-run] [--allow-uncategorized]")


def out(s):
    sys.stdout.write(re.sub(r"\n?$", "\n", str(s)))


def parse_args(argv):
    a = {"title": None, "area": None, "role": None, "body": None, "bodyFile": None,
         "labels": [], "severity": None, "dryRun": False, "allowUncategorized": False}
    i = 0
    n = len(argv)
    while i < n:
        t = argv[i]
        if t == "--title":
            i += 1; a["title"] = argv[i] if i < n else None
        elif t == "--area":
            i += 1; a["area"] = argv[i] if i < n else None
        elif t == "--role":
            i += 1; a["role"] = argv[i] if i < n else None
        elif t == "--body":
            i += 1; a["body"] = argv[i] if i < n else None
        elif t == "--body-file":
            i += 1; a["bodyFile"] = argv[i] if i < n else None
        elif t == "--label":
            i += 1
            if i < n:
                a["labels"].append(argv[i])
        elif t == "--severity":
            i += 1; a["severity"] = argv[i] if i < n else None
        elif t == "--dry-run":
            a["dryRun"] = True
        elif t == "--allow-uncategorized":
            a["allowUncategorized"] = True
        elif t.startswith("--"):
            raise ValueError("unknown flag: " + t)
        else:
            raise ValueError("unexpected argument: " + t)
        i += 1
    return a


def gh_invocation(title, labels):
    """The resolved `gh issue create` invocation, for --dry-run display. Title
    quoted via json.dumps(ensure_ascii=False) so the two ports render byte-identically."""
    parts = ["gh issue create", "--title " + json.dumps(str(title), ensure_ascii=False), "--body-file -"]
    for l in labels:
        parts.append("--label " + l)
    return " ".join(parts)


def main(argv, provider=None):
    if wants_help(argv):  # #117 command-aware --help
        print(USAGE)
        return 0
    try:
        a = parse_args(argv)
    except ValueError as e:
        return die(str(e), 2)
    if not a["title"]:
        return die(USAGE, 2)
    if a["body"] is not None and a["bodyFile"] is not None:
        return die("pass only one of --body or --body-file", 2)
    body = ""
    if a["bodyFile"] is not None:
        try:
            with open(a["bodyFile"], "r", encoding="utf-8") as f:
                body = f.read()
        except OSError as e:
            return die("could not read --body-file {}: {}".format(a["bodyFile"], e), 2)
    elif a["body"] is not None:
        body = a["body"]

    cfg = config.load_create_config()
    verdict = file_gate_verdict({
        "area": a["area"], "role": a["role"], "severity": a["severity"],
        "title": a["title"], "labels": a["labels"],
        "allowUncategorized": a["allowUncategorized"], "body": body,
    }, cfg)

    # Soft notes first — never block.
    for v in verdict["violations"]:
        if v["severity"] == "soft":
            sys.stderr.write("[file] note: {}\n".format(v["message"]))
    hard = [v for v in verdict["violations"] if v["severity"] == "hard"]
    if hard:
        for v in hard:
            sys.stderr.write("[file] ✗ {}\n".format(v["message"]))
        if a["dryRun"]:
            out("[dry-run] would NOT create — {} hard violation(s): {}".format(
                len(hard), gh_invocation(a["title"], verdict["labels"])))
        return 1  # nothing created

    if a["dryRun"]:
        out("[dry-run] would create: {}".format(gh_invocation(a["title"], verdict["labels"])))
        return 0

    prov = provider or provider_mod.get_provider("github")
    num = prov.create_issue(a["title"], body, verdict["labels"])
    if num is None:
        return die("issue creation failed (gh unavailable / rejected?) — nothing created.", 1)
    out("created #{}{}".format(
        num, " [{}]".format(", ".join(verdict["labels"])) if verdict["labels"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
