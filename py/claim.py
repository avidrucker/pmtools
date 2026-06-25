#!/usr/bin/env python3
"""claim.py — claim an issue into a worktree under a self-assigned agent identity.

Ported from lccjs scripts/claim.js (the IMPURE orchestration). All pure
decisions live in claim_core; this file does only git/gh I/O and wiring, and is
a faithful twin of js/claim.js.

The lccjs-isms are parameterized (this is the whole point of pmtools):
  --worktree-dir <dir>  default .claude/worktrees (relative to mainRoot)
  --roster a,b,c        default = FRUITS from claim_core; auto-claim walks it
  --lane-check          OFF by default (INVERTED from lccjs): only when passed
                        do we enforce the area:* lane gate
  --copy-env            OFF by default: only when passed do we copy <root>/.env
  --base <ref>          default main
Other flags: --as, --dry-run, --force, --allow-stale-main, --custom.

Convention:
  branch   = <fruit>/issue-<N>[-<slug>]
  worktree = <worktreeDir>/<fruit>-issue-<N>

Identity precedence: --as > CLAUDE_AGENT_NAME > branch-inferred > auto.
Auto (no identity) is a hard error — agents must be named (lccjs #386).
"""
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

import claim_core as core
from claim_core import (
    FRUITS, slugify, resolve_identity, check_identity_name,
    should_block_claim, should_block_uncategorized, assess_base_staleness,
    worktrees_with_issue, find_live_worktree_for_issue, find_same_issue_collision,
    should_block_worktree_guard, sentinel_branch, is_sentinel_stale_by_age,
    apply_marker_flip, build_banner_lines, classify_claim_push_result,
    build_claim_message, claim_push_action,
)

TODO_KW = "@" + "todo"
INPROGRESS_KW = "@" + "inprogress"


def sh(cmd, allow_fail=False):
    """Run a shell command, returning stdout text. allow_fail -> None on error.

    Uses shell=True to mirror claim.js's execSync semantics (the lccjs source
    builds shell strings); callers pass already-quoted/built strings.
    """
    try:
        out = subprocess.run(
            cmd, shell=True, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True,
        )
        return out.stdout
    except subprocess.CalledProcessError:
        if allow_fail:
            return None
        raise


def git(args, allow_fail=False):
    """arg-array git exec (#37): values are passed as argv and never re-parsed by
    a shell, so an interpolated `;touch` can never execute. Used for every git
    call that interpolates a branch/base/path; constant commands stay on sh().
    Returns stdout on success, None on a non-zero exit (mirrors sh(..., True))."""
    try:
        out = subprocess.run(
            ["git", *args], check=True,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        return out.stdout
    except subprocess.CalledProcessError:
        if allow_fail:
            return None
        raise


def git_capture(args):
    """Combined stdout+stderr regardless of exit, never raises (for the claim-ref
    push, whose output the push-result classifier inspects)."""
    res = subprocess.run(
        ["git", *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return res.stdout or ""


def die(msg):
    sys.stderr.write("[claim] ✗ {}\n".format(msg))
    sys.exit(1)


def main_root():
    """The MAIN checkout's root, NOT cwd (so a reused worktree still nests under
    the main repo, never inside the caller's worktree)."""
    d = sh("git rev-parse --path-format=absolute --git-common-dir", True)
    if not d:
        rel = sh("git rev-parse --git-common-dir", True)  # older git fallback
        if not rel:
            die("not inside a git repository.")
        d = os.path.abspath(os.path.join(os.getcwd(), rel.strip()))
    return os.path.dirname(d.strip())


def list_worktree_branches():
    out = sh("git worktree list --porcelain", True) or ""
    branches = []
    for line in out.split("\n"):
        if line.startswith("branch "):
            branch = line[len("branch "):].replace("refs/heads/", "", 1)
            fruit = branch.split("/")[0] if "/" in branch else None
            branches.append({"branch": branch, "fruit": fruit})
    return branches


def is_sentinel_stale(fruit):
    raw = git(["log", "-1", "--format=%ct", "refs/heads/{}".format(sentinel_branch(fruit))], True)
    if not raw or not raw.strip():
        return False
    try:
        ts = int(raw.strip())
    except ValueError:
        return False
    return is_sentinel_stale_by_age(ts, int(time.time()))


def branch_exists(branch):
    return git(["show-ref", "--verify", "--quiet", "refs/heads/{}".format(branch)], True) is not None


def create_session_sentinel(fruit):
    b = sentinel_branch(fruit)
    if branch_exists(b):
        return
    git(["branch", b, "HEAD"], True)


def taken_fruits():
    taken = set(b["fruit"] for b in list_worktree_branches() if b["fruit"])
    all_branches = sh("git branch --list", True) or ""
    for line in all_branches.split("\n"):
        branch = re.sub(r"^\*\s+", "", line.strip())
        if not branch:
            continue
        slash = branch.find("/")
        if slash < 0:
            continue
        fruit = branch[:slash]
        rest = branch[slash + 1:]
        if rest == "session" and is_sentinel_stale(fruit):
            continue
        if fruit:
            taken.add(fruit)
    return taken


def current_branch():
    b = sh("git rev-parse --abbrev-ref HEAD", True)
    return b.strip() if b else None


def read_issue(issue):
    out = sh("gh issue view {} --json title,state,comments,labels".format(issue), True)
    if not out:
        return None
    try:
        import json
        j = json.loads(out)
        return {
            "title": j.get("title") or None,
            "state": str(j.get("state") or "").upper(),
            "commentCount": len(j["comments"]) if isinstance(j.get("comments"), list) else 0,
            "labels": [l.get("name") for l in j["labels"] if l and l.get("name")]
                      if isinstance(j.get("labels"), list) else [],
        }
    except Exception:
        return None


def flip_marker(issue, wt_path):
    inprogress = git(["-C", wt_path, "grep", "-lE", "{} #{}:[0-9]".format(INPROGRESS_KW, issue)], True)
    if inprogress and inprogress.strip():
        print("[claim] {} #{} already present — skipping flip".format(INPROGRESS_KW, issue))
        return
    grep = git(["-C", wt_path, "grep", "-nIE", "{} #{}:[0-9]".format(TODO_KW, issue)], True)
    if not grep or not grep.strip():
        print("[claim] no {} #{} marker found — skipping flip".format(TODO_KW, issue))
        return
    first_line = grep.strip().split("\n")[0]
    rel_file = first_line.split(":")[0]
    abs_file = os.path.join(wt_path, rel_file)
    try:
        with open(abs_file, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError as e:
        sys.stderr.write("[claim] warn: could not read {}: {}\n".format(rel_file, e))
        return
    res = apply_marker_flip(content, issue)
    if not res["flipped"]:
        print("[claim] no {} #{} marker found — skipping flip".format(TODO_KW, issue))
        return
    try:
        with open(abs_file, "w", encoding="utf-8") as f:
            f.write(res["updated"])
    except OSError as e:
        sys.stderr.write("[claim] warn: could not write {}: {}\n".format(rel_file, e))
        return
    print("[claim] flipped {} #{} → {} in {}:{}".format(
        TODO_KW, issue, INPROGRESS_KW, rel_file, res["line"]))


def warn_orphaned_worktrees(worktree_dir):
    entries = worktrees_with_issue(list_worktree_branches())
    if not entries:
        return
    root = main_root()
    for e in entries:
        branch, fruit, iss = e["branch"], e["fruit"], e["issue"]
        state = sh("gh issue view {} --json state -q .state".format(iss), True)
        if not state or not state.strip():
            continue
        if state.strip().upper() != "CLOSED":
            continue
        wt_path = os.path.join(root, worktree_dir, "{}-issue-{}".format(fruit, iss))
        sys.stderr.write(
            '[claim] ⚠ stale worktree: "{}" references CLOSED issue #{}.\n'
            "         Deferred teardown may have failed. To clean up:\n"
            '           git worktree remove "{}" --force\n'
            "           git branch -D {}\n".format(branch, iss, wt_path, branch))


def warn_stale_claim_refs():
    listing = sh("git ls-remote origin 'refs/claims/*' 2>/dev/null", True)
    if not listing or not listing.strip():
        return
    for line in listing.strip().split("\n"):
        parts = line.split("\t")
        ref = parts[1] if len(parts) > 1 else ""
        m = re.search(r"refs/claims/issue-(\d+)\b", ref)
        if not m:
            continue
        issue_num = m.group(1)
        state_raw = sh("gh issue view {} --json state -q .state".format(issue_num), True)
        issue_state = state_raw.strip().upper() if state_raw and state_raw.strip() else None
        if issue_state in ("CLOSED", "MERGED"):
            sys.stderr.write(
                "[claim] ⚠ stale claim ref refs/claims/issue-{0} (issue #{0} is {1}).\n"
                "         To sweep:  git push origin :refs/claims/issue-{0}\n".format(issue_num, issue_state))


def parse_args(argv):
    opts = {
        "issue": None, "slug": None, "as": None, "base": "main", "dryRun": False,
        "allowStaleMain": False, "force": False, "custom": False,
        "laneCheck": False, "copyEnv": False,
        "worktreeDir": ".claude/worktrees", "roster": None,
    }
    positionals = []
    i = 0
    n = len(argv)
    while i < n:
        a = argv[i]
        if a == "--as":
            i += 1; opts["as"] = argv[i] if i < n else None
        elif a == "--base":
            i += 1; opts["base"] = argv[i] if i < n else None
        elif a == "--dry-run":
            opts["dryRun"] = True
        elif a == "--force":
            opts["force"] = True
        elif a == "--allow-stale-main":
            opts["allowStaleMain"] = True
        elif a == "--custom":
            opts["custom"] = True
        elif a == "--lane-check":
            opts["laneCheck"] = True
        elif a == "--copy-env":
            opts["copyEnv"] = True
        elif a == "--worktree-dir":
            i += 1; opts["worktreeDir"] = argv[i] if i < n else None
        elif a == "--roster":
            i += 1
            raw = argv[i] if i < n else ""
            opts["roster"] = [s.strip() for s in str(raw or "").split(",") if s.strip()]
        elif a.startswith("--"):
            die("unknown flag: " + a)
        else:
            positionals.append(a)
        i += 1
    opts["issue"] = positionals[0] if len(positionals) > 0 else None
    opts["slug"] = positionals[1] if len(positionals) > 1 else None
    return opts


def report(fruit, branch, wt_path, base, mode, dry, comment_count, issue):
    for line in build_banner_lines(fruit, branch, wt_path, base, mode, dry,
                                   comment_count, issue, os.environ.get("HOME")):
        print(line)


def main():
    opts = parse_args(sys.argv[1:])
    if not opts["issue"] or not re.match(r"^\d+$", str(opts["issue"])):
        die("usage: claim <issue-number> [slug] [--as <fruit>] [--base <ref>] [--dry-run] [--force] "
            "[--custom] [--lane-check] [--copy-env] [--worktree-dir <dir>] [--roster a,b,c] [--allow-stale-main]")
    issue = opts["issue"]
    roster = opts["roster"] if (opts["roster"]) else FRUITS

    identity = resolve_identity(opts, os.environ, current_branch())

    if identity["source"] == "auto":
        die(
            "no agent identity set.\n"
            "  Corrected command:  claim " + str(issue) + " --as <fruit>\n"
            "  or export CLAUDE_AGENT_NAME=<fruit> before running.\n"
            "  Auto-naming is disabled — agent names must be assigned by the human orchestrator.")

    # Injection guard (#37): the identity becomes the branch/worktree name and is
    # interpolated into git commands — reject anything but ref-legal characters.
    if identity["name"] and not core.is_safe_ref(identity["name"]):
        die('agent identity "{}" contains unsafe characters — '
            "only letters, digits, and . _ / - are allowed.".format(identity["name"]))

    name_check = check_identity_name(identity, opts, roster)
    if name_check:
        sys.stderr.write("[claim] note: {}\n".format(name_check["warn"]))

    info = read_issue(issue)
    if should_block_claim(info, opts["force"]):
        die("#{} is CLOSED -- nothing to claim. Pass --force to claim it anyway.".format(issue))

    # Lane gate (INVERTED from lccjs): OFF by default, only enforced with --lane-check.
    if opts["laneCheck"] and should_block_uncategorized(info, False):
        die(
            "#{0} has no real area:* label (only area:uncategorized or none). "
            "Assign a lane before claiming:\n"
            '  gh issue edit {0} --add-label "area:<name>" --remove-label area:uncategorized\n'
            "then re-run the claim. To work it uncategorized, drop --lane-check.".format(issue))

    slug = slugify(opts["slug"]) if opts["slug"] else None
    if not slug and info and info.get("title"):
        slug = slugify(info["title"])

    base = opts["base"]
    # Injection guard (#37): base is interpolated into git rev-parse / worktree add.
    if not core.is_safe_ref(base):
        die('base ref "{}" contains unsafe characters — '
            "only letters, digits, and . _ / - are allowed.".format(base))
    if git(["rev-parse", "--verify", "--quiet", "{}^{{commit}}".format(base)], True) is None:
        die('base ref "{}" does not resolve — pass --base <ref> (e.g. origin/main).'.format(base))

    if not opts["allowStaleMain"]:
        sh("git fetch origin main --quiet", True)
        behind_raw = (sh("git rev-list --count main..origin/main", True) or "").strip()
        try:
            behind = int(behind_raw) if behind_raw else 0
        except ValueError:
            behind = 0
        if assess_base_staleness(base, behind)["stale"]:
            die("local main is {} commit(s) behind origin/main — run `git pull --ff-only origin main` "
                "first, then re-claim (pass --allow-stale-main to override).".format(behind))

    warn_orphaned_worktrees(opts["worktreeDir"])
    warn_stale_claim_refs()

    existing_wt = find_live_worktree_for_issue(
        worktrees_with_issue(list_worktree_branches()), int(issue))
    if existing_wt:
        detail = (
            'issue #{} is already live in worktree "{}" (agent: {}).\n'
            "  cd into the existing worktree, or pass --force to claim anyway.".format(
                issue, existing_wt["branch"], existing_wt["fruit"] or "unknown"))
        if should_block_worktree_guard(existing_wt, opts):
            die(detail)
        sys.stderr.write("[claim] ⚠ live worktree detected: {}\n".format(detail))

    root = main_root()

    def mk_branch(fruit):
        return "{}/issue-{}{}".format(fruit, issue, "-" + slug if slug else "")

    def mk_path(fruit):
        return os.path.join(root, opts["worktreeDir"], "{}-issue-{}".format(fruit, issue))

    if identity["name"]:
        candidates = [identity["name"]]
    else:
        taken = taken_fruits()
        candidates = [f for f in roster if f not in taken]
        if not candidates:
            fallback = "{}-2".format(roster[0])
            sys.stderr.write(
                "[claim] all {} roster names are checked out — falling back to \"{}\".\n".format(
                    len(roster), fallback))
            candidates = [fallback]

    if opts["dryRun"]:
        fruit = candidates[0]
        dry_comment_count = (info and info.get("commentCount")) or 0
        print("[claim] --dry-run — nothing staked.")
        report(fruit, mk_branch(fruit), mk_path(fruit), base, identity["modeLabel"],
               True, dry_comment_count, issue)
        return

    for fruit in candidates:
        branch = mk_branch(fruit)
        wt_path = mk_path(fruit)

        if branch_exists(branch):
            if identity["name"]:
                die("branch {} already exists — issue #{} is already claimed under \"{}\". "
                    "cd into {}, or claim a different issue.".format(branch, issue, fruit, wt_path))
            continue

        ok = git(["worktree", "add", wt_path, "-b", branch, base], True)
        if ok is None:
            if identity["name"]:
                die("git worktree add failed for {} (see git output).".format(branch))
            continue

        if not identity["name"]:
            same_fruit = [b for b in list_worktree_branches() if b["fruit"] == fruit]
            if len(same_fruit) > 1:
                sys.stderr.write(
                    '[claim] race: "{}" was taken by another agent — rolling back and retrying.\n'.format(fruit))
                git(["worktree", "remove", wt_path, "--force"], True)
                git(["branch", "-D", branch], True)
                continue

        if not opts["force"]:
            collision = find_same_issue_collision(
                worktrees_with_issue(list_worktree_branches()), int(issue), branch)
            if collision:
                git(["worktree", "remove", wt_path, "--force"], True)
                git(["branch", "-D", branch], True)
                die('issue #{} was claimed concurrently in worktree "{}" (agent: {}) — '
                    'rolled back "{}". cd into the existing worktree, or claim a different '
                    "issue (pass --force to override).".format(
                        issue, collision["branch"], collision["fruit"] or "unknown", branch))

        base_tree = (git(["rev-parse", "{}^{{tree}}".format(base)], True) or "").strip()
        if base_tree:
            stamp = "{}.{}".format(datetime.now(timezone.utc).isoformat(), time.monotonic_ns())
            claim_msg = build_claim_message(issue, branch, os.getpid(), stamp)
            claim_sha = (git(["commit-tree", base_tree, "-m", claim_msg], True) or "").strip()
            if claim_sha:
                push_out = git_capture(
                    ["push", "origin", "{}:refs/claims/issue-{}".format(claim_sha, issue)])
                action = claim_push_action(classify_claim_push_result(push_out), opts["force"])
                if action == "ROLLBACK_DIE":
                    git(["worktree", "remove", wt_path, "--force"], True)
                    git(["branch", "-D", branch], True)
                    die("issue #{0} is already claimed in another clone "
                        "(cross-clone collision on refs/claims/issue-{0}) — rolled back \"{1}\". "
                        "cd into that clone's worktree, claim a different issue, or pass --force "
                        "to override.".format(issue, branch))
                elif action == "WARN_PROCEED":
                    sys.stderr.write(
                        "[claim] ⚠ could not confirm a cross-clone claim for #{} "
                        "(remote unreachable/auth — best-effort) — proceeding.\n".format(issue))

        if opts["copyEnv"]:
            root_env = os.path.join(root, ".env")
            if os.path.exists(root_env):
                try:
                    import shutil
                    shutil.copyfile(root_env, os.path.join(wt_path, ".env"))
                except OSError:
                    pass

        if not identity["name"]:
            create_session_sentinel(fruit)

        flip_marker(issue, wt_path)
        report(fruit, branch, wt_path, base, identity["modeLabel"], False,
               (info and info.get("commentCount")) or 0, issue)
        return

    die("could not claim a worktree — every candidate was taken or staking failed.")


if __name__ == "__main__":
    main()
