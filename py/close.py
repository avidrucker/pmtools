#!/usr/bin/env python3
"""close.py — finish a puzzle safely: land the close commit on origin/main, then
(and ONLY then) tear down the worktree. The symmetric mirror of claim.py.

Ported from lccjs scripts/close.js (the GENERIC core of the IMPURE orchestration).
All pure decisions live in close_core; this file does only git/gh I/O and wiring,
and is a faithful twin of js/close.js.

Boundary: this tool does NOT author the closing commit. The agent writes the
marker deletion + `Closes #N` message and commits FIRST; close.py takes over
after, owning only the racy push + the gated teardown.

The velocity-row guard (#5) IS ported, but DB-based and config-gated: it reads
SQLite (the source of truth), not the lccjs velocity CSV. Still OMITTED
(lccjs-specific, out of scope): the velocity-CSV diff parsers + auto-resolve, the
learnings-README conflict resolver, union-file auto-resolve, and the
parent-tracker scan. Any rebase conflict is blocking.

Usage (after committing `Closes #N`):
  close <issue>                    # from inside the worktree (statechart default)
  close <issue> --branch <name>    # from the main checkout (branch supplied)
  close <issue> --max 8            # more push-race retries (default 5)
  close <issue> --dry-run          # show the plan, change nothing
  close <issue> --keep             # land the commit but DON'T tear down
  close <issue> --no-verify-issue  # skip the gh post-close check
  close <issue> --skip-marker-check
  close <issue> --skip-keyword-check
  close <issue> --skip-scope-audit
  close <issue> --skip-velocity-check   # bypass the velocity-row guard
  close <issue> --worktree-dir <dir>   # default .claude/worktrees
"""
import os
import re
import subprocess
import sys

import close_core as core
import config
import store
import store_core
import claim_core
from close_core import (
    DEFAULT_MAX_RETRIES, is_safe_ref, classify_push_error, should_cleanup,
    claim_ref_delete_command, classify_claim_ref_delete,
    classify_rebase_conflict, body_closes_issue,
    extract_keywords, keywords_overlap, marker_still_present,
    scope_audit_diff_command, velocity_row_present, compute_velocity_mismatch,
)


def sh(cmd, allow_fail=False):
    """Run a shell command, returning stdout text. allow_fail -> None on error."""
    try:
        out = subprocess.run(
            cmd, shell=True, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        return out.stdout
    except subprocess.CalledProcessError:
        if allow_fail:
            return None
        raise


def sh_capture(cmd):
    """Like sh() but returns {"ok", "out"} with stdout+stderr merged, never raises."""
    res = subprocess.run(
        cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    return {"ok": res.returncode == 0, "out": (res.stdout or "") + (res.stderr or "")}


def git_capture(args):
    """arg-array git exec (#37): values are passed as argv and never re-parsed by
    a shell. Returns {"ok", "out"} like sh_capture; used for teardown's
    `branch -D <branch>`, where --branch is attacker-influenced."""
    res = subprocess.run(
        ["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return {"ok": res.returncode == 0, "out": (res.stdout or "") + (res.stderr or "")}


def die(msg, code=1):
    sys.stderr.write("[close] ✗ {}\n".format(msg))
    sys.exit(code)


def log(msg):
    print("[close] {}".format(msg))


def main_root():
    """The MAIN checkout's root, NOT the worktree we're closing — the worktree is
    about to be removed, so the removal must run from a directory that survives."""
    d = sh("git rev-parse --path-format=absolute --git-common-dir", True)
    if not d:
        rel = sh("git rev-parse --git-common-dir", True)  # older git fallback
        if not rel:
            die("not inside a git repository.")
        d = os.path.abspath(os.path.join(os.getcwd(), rel.strip()))
    return os.path.dirname(d.strip())


def parse_args(argv):
    opts = {
        "issue": None, "max": DEFAULT_MAX_RETRIES, "dryRun": False,
        "keep": False, "verifyIssue": True, "skipKeywordCheck": False,
        "skipMarkerCheck": False, "skipScopeAudit": False, "skipVelocityCheck": False,
        "branch": None, "worktreeDir": ".claude/worktrees",
    }
    positionals = []
    i = 0
    n = len(argv)
    while i < n:
        a = argv[i]
        if a == "--max":
            i += 1
            raw = argv[i] if i < n else None
            try:
                opts["max"] = int(raw)
            except (TypeError, ValueError):
                opts["max"] = DEFAULT_MAX_RETRIES
        elif a == "--dry-run":
            opts["dryRun"] = True
        elif a == "--keep":
            opts["keep"] = True
        elif a == "--no-verify-issue":
            opts["verifyIssue"] = False
        elif a == "--skip-keyword-check":
            opts["skipKeywordCheck"] = True
        elif a == "--skip-marker-check":
            opts["skipMarkerCheck"] = True
        elif a == "--skip-scope-audit":
            opts["skipScopeAudit"] = True
        elif a == "--skip-velocity-check":
            opts["skipVelocityCheck"] = True
        elif a == "--branch":
            i += 1
            opts["branch"] = argv[i] if i < n else None
        elif a == "--worktree-dir":
            i += 1
            opts["worktreeDir"] = argv[i] if i < n else None
        elif a.startswith("--"):
            die("unknown flag: " + a, 2)
        else:
            positionals.append(a)
        i += 1
    opts["issue"] = positionals[0] if positionals else None
    if not isinstance(opts["max"], int) or opts["max"] < 1:
        opts["max"] = DEFAULT_MAX_RETRIES
    return opts


# ---- git I/O helpers (thin wrappers; close_core stays pure) ----------------

def current_branch():
    b = sh("git rev-parse --abbrev-ref HEAD", True)
    return b.strip() if b else None


def head_sha():
    s = sh("git rev-parse HEAD", True)
    return s.strip() if s else None


def find_closing_commit_sha(issue):
    """Scan origin/main..HEAD for a commit whose body Closes #issue. First match's
    SHA, else None."""
    out = sh("git log origin/main..HEAD --format=%H", True) or ""
    shas = [s.strip() for s in out.strip().split("\n") if s.strip()]
    for sha in shas:
        body = sh("git show -s --format=%B {}".format(sha), True) or ""
        if body_closes_issue(body, issue):
            return sha
    return None


def find_closing_commit_on_main(issue):
    """Recovery path: scan origin/main -100 for a Closes #issue commit, else None."""
    out = sh("git log origin/main -100 --format=%H", True) or ""
    shas = [s.strip() for s in out.strip().split("\n") if s.strip()]
    for sha in shas:
        body = sh("git show -s --format=%B {}".format(sha), True) or ""
        if body_closes_issue(body, issue):
            return sha
    return None


def tree_is_clean():
    s = sh("git status --porcelain", True)
    return s is not None and s.strip() == ""


def rebase_or_merge_in_progress():
    rm = sh("git rev-parse --git-path rebase-merge", True)
    ra = sh("git rev-parse --git-path rebase-apply", True)
    mh = sh("git rev-parse --git-path MERGE_HEAD", True)

    def exists(p):
        return bool(p and sh('test -e "{}" && echo yes'.format(p.strip()), True))

    return bool(exists(rm) or exists(ra) or exists(mh))


def conflicted_paths():
    s = sh("git diff --name-only --diff-filter=U", True) or ""
    return [x.strip() for x in s.split("\n") if x.strip()]


def on_origin_main(sha):
    out = sh("git branch -r --contains {}".format(sha), True) or ""
    return any(l.strip() == "origin/main" for l in out.split("\n"))


# ---- guards (skippable) ----------------------------------------------------

def check_keyword_match(issue, closing_commit_sha):
    """Guard 2: the closing commit's subject must share >=1 keyword with the issue
    title (via gh). Degrades gracefully when gh is unavailable."""
    title = sh("gh issue view {} --json title -q .title".format(issue), True)
    if not title or not title.strip():
        log("warn: could not fetch issue title (gh unavailable?) — skipping keyword check.")
        return
    sha = closing_commit_sha or "HEAD"
    subject = sh("git show -s --format=%s {}".format(sha), True) or ""
    title_kws = extract_keywords(title.strip())
    if not title_kws:
        log("warn: issue title has no extractable keywords — skipping keyword check.")
        return
    if keywords_overlap(title_kws, extract_keywords(subject.strip())):
        return
    all_subjects_out = sh("git log origin/main..HEAD --format=%s", True) or ""
    all_subjects = [s for s in all_subjects_out.strip().split("\n") if s]
    if any(keywords_overlap(title_kws, extract_keywords(s)) for s in all_subjects):
        return
    all_subject_kws = sorted(set(kw for s in all_subjects for kw in extract_keywords(s)))
    die("keyword check: no keyword from issue #{} title matched any unpushed commit subject.\n"
        '  title:            "{}"\n'
        "  title keywords:   [{}]\n"
        "  subjects scanned: {}\n"
        "  subject keywords: [{}]\n"
        "  Paraphrased title? Add --skip-keyword-check to your close command.".format(
            issue, title.strip(), ", ".join(title_kws), len(all_subjects),
            ", ".join(all_subject_kws)))


def check_marker_deleted(issue):
    """Guard: no puzzle marker (todo/inprogress) for the issue may remain in any
    tracked file. LANGUAGE-AGNOSTIC: search all tracked files, not just *.js/ts."""
    t_pat = "@" + "todo #{}".format(issue)
    i_pat = "@" + "inprogress #{}".format(issue)
    result = sh_capture('git grep -rn -e "{}" -e "{}"'.format(t_pat, i_pat))
    res = marker_still_present(issue, result["out"])
    if res["found"]:
        die("puzzle marker for #{} still present — delete it in the closing commit first.\n".format(issue)
            + "\n".join("  Found: {}".format(l) for l in res["lines"]) + "\n"
            + "  Pass --skip-marker-check to bypass (no source marker ever existed).")


def check_velocity_guard(issue, fruit):
    """Velocity-row guard (#5; ported from lccjs scripts/close.js). Config-gated:
    when storage.velocity is disabled — or the DB is absent (first run / CI) — it
    no-ops. Otherwise SQLite is the source of truth: (Check A) refuse when no
    velocity row exists for this ticket, or (Guard 1) when the closing agent
    logged only a different ticket (the #278 digit-transposition). All blocking
    decisions live in the pure close_core seams; this wrapper only does I/O."""
    try:
        cfg = config.load_storage_config()
    except Exception:
        return  # config unreadable — never block on it.
    if not cfg.get("velocity") or not cfg["velocity"].get("enabled"):
        return  # disabled → skip.
    db_path = cfg.get("dbPath")
    if not db_path or not os.path.exists(db_path):
        log("warn: velocity store enabled but no DB at {} — skipping velocity-row check.".format(
            db_path or "(unset)"))
        return
    try:
        rows = store.select_all(db_path, "velocity")
    except Exception as e:
        log("warn: could not read velocity DB at {} ({}) — skipping velocity-row check.".format(
            db_path, str(e).split(chr(10))[0]))
        return
    n = int(issue)
    if velocity_row_present([r for r in rows if r["ticket"] is not None and int(r["ticket"]) == n]):
        return  # Check A satisfied (skip issueless null-ticket rows, #56).
    mismatch = compute_velocity_mismatch(rows, issue, fruit)
    if mismatch:
        die('velocity-row guard: agent "{}" logged ticket(s) #{} but is closing #{}. '
            "Align the velocity row's ticket (or the close) first, then re-run. "
            "Pass --skip-velocity-check to bypass.".format(
                fruit, ", #".join(str(t) for t in mismatch), issue))
    die("velocity-row guard: no velocity row for #{} in {}. Log your session first:\n"
        "  pmtools velocity log '{{\"ticket\":{},\"role\":\"DEV\",\"agent\":\"{}\","
        "\"started_iso\":\"<ISO>\",\"finished_iso\":\"<ISO>\",\"actual_min\":<A>}}'\n"
        "  Then re-run close. Pass --skip-velocity-check to bypass (PM/triage closes).".format(
            issue, db_path, issue, fruit))


def delete_claim_ref(issue):
    """Best-effort, idempotent claim-ref delete so a closed issue can't falsely
    block a future re-claim. Never aborts the close."""
    out = sh("{} 2>&1 || true".format(claim_ref_delete_command(issue)), True) or ""
    verdict = classify_claim_ref_delete(out)
    if verdict == "DELETED":
        log("claim ref refs/claims/issue-{} deleted.".format(issue))
    elif verdict == "ABSENT":
        log("claim ref refs/claims/issue-{} already absent — no-op.".format(issue))
    else:
        log("warn: could not delete claim ref refs/claims/issue-{} "
            "(best-effort; close continues).".format(issue))


# ---- land loop -------------------------------------------------------------

def reexport_and_stage_velocity_csv(cfg):
    """Re-export the velocity CSV mirror from SQLite (the source of truth, which
    already holds both agents' rows) and stage it, to auto-resolve a
    velocity-CSV-only rebase conflict. Resolved against the current worktree's
    toplevel (where the rebase is happening). On any failure, abort the rebase and
    die() — the commit stays safe and local. (#57; ported from lccjs #313)"""
    top = (sh("git rev-parse --show-toplevel", True) or "").strip() or os.getcwd()
    csv_abs = os.path.join(top, cfg["velocity"]["csvMirror"])
    try:
        store.export_csv(cfg["dbPath"], "velocity", csv_abs, store_core.VELOCITY_COLS)
    except Exception as e:
        sh("git rebase --abort", True)
        die("velocity CSV conflict: re-export from the DB failed ({}). "
            "Aborted the rebase; your commit is safe and local.".format(
                str(e).split(chr(10))[0]))
    staged = sh_capture('git add "{}"'.format(csv_abs))
    if not staged["ok"]:
        sh("git rebase --abort", True)
        die("velocity CSV conflict: re-export succeeded but git add failed. "
            "Aborted the rebase; your commit is safe and local.")


def union_merge_and_stage(file):
    """Union-merge an append-only file that conflicted on BOTH sides of a rebase,
    keeping every line from each side (git's merge=union semantics) — driven by
    config so the consumer needs no committed .gitattributes (#36 guard 2 / #290).
    During the conflict the three versions live in the index: :1: base, :2: ours
    (origin/main), :3: theirs (the replayed commit); `merge-file --union` folds them.
    On any failure, abort the rebase and die() — the commit stays safe and local."""
    d = os.path.dirname(file) or "."
    base = os.path.join(d, ".pmtools-union.{}.base".format(os.path.basename(file)))
    ours = os.path.join(d, ".pmtools-union.{}.ours".format(os.path.basename(file)))
    theirs = os.path.join(d, ".pmtools-union.{}.theirs".format(os.path.basename(file)))
    try:
        for tmp, stage in ((base, 1), (ours, 2), (theirs, 3)):
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(sh('git show ":{}:{}"'.format(stage, file), True) or "")
        merged = sh('git merge-file -p --union "{}" "{}" "{}"'.format(ours, base, theirs), True)
        if merged is None:
            sh("git rebase --abort", True)
            die("union-file conflict: merge-file failed for {}. "
                "Aborted the rebase; your commit is safe and local.".format(file))
        with open(file, "w", encoding="utf-8") as fh:
            fh.write(merged)
        staged = sh_capture('git add "{}"'.format(file))
        if not staged["ok"]:
            sh("git rebase --abort", True)
            die("union-file conflict: merged {} but git add failed. "
                "Aborted the rebase; your commit is safe and local.".format(file))
    finally:
        for tmp in (base, ours, theirs):
            try:
                os.remove(tmp)
            except OSError:
                pass


def resolve_markdown_index_and_stage(file):
    """Resolve an append-only markdown index that conflicted (each side appended a
    row) by stripping the git conflict markers in place — keeping both rows, and
    collapsing an adjacent identical row — then stage it. The decision logic is the
    pure resolve_append_only_markdown_conflict; this wraps it with file I/O.
    (#36 guard 4 / #971)"""
    try:
        with open(file, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as e:
        sh("git rebase --abort", True)
        die("learnings-index conflict: could not read {} ({}). "
            "Aborted the rebase; your commit is safe and local.".format(file, e))
    try:
        with open(file, "w", encoding="utf-8") as fh:
            fh.write(core.resolve_append_only_markdown_conflict(text))
    except OSError as e:
        sh("git rebase --abort", True)
        die("learnings-index conflict: could not write {} ({}). "
            "Aborted the rebase; your commit is safe and local.".format(file, e))
    staged = sh_capture('git add "{}"'.format(file))
    if not staged["ok"]:
        sh("git rebase --abort", True)
        die("learnings-index conflict: resolved {} but git add failed. "
            "Aborted the rebase; your commit is safe and local.".format(file))


def try_land():
    """One fetch/rebase/push round. Returns 'ok' | 'race' | 'rejected-other', or
    die()s on a blocking rebase conflict (not retryable). A conflict whose ONLY
    path is the velocity CSV mirror auto-resolves via re-export (#57)."""
    sh("git fetch origin main", True)
    rebase = sh_capture("git rebase origin/main")
    if not rebase["ok"]:
        conflicted = conflicted_paths()
        try:
            cfg = config.load_storage_config()
        except Exception:
            cfg = None
        try:
            close_cfg = config.load_close_config()
        except Exception:
            close_cfg = {"autoResolve": {"unionFiles": [], "markdownIndexes": []}}
        union_files = close_cfg["autoResolve"]["unionFiles"]
        markdown_indexes = close_cfg["autoResolve"]["markdownIndexes"]
        csv_mirror = (cfg["velocity"]["csvMirror"]
                      if cfg and cfg.get("velocity") and cfg["velocity"].get("enabled")
                      else None)
        if csv_mirror and core.is_velocity_csv_only_conflict(conflicted, csv_mirror):
            # Two agents committed divergent full-table CSV exports. Re-export from
            # the DB (already holds both rows) and continue — the only resolvable one.
            reexport_and_stage_velocity_csv(cfg)
            cont = sh_capture("GIT_EDITOR=true git rebase --continue")
            if not cont["ok"]:
                sh("git rebase --abort", True)
                die("velocity CSV conflict: re-export + stage succeeded but rebase "
                    "--continue failed: {}. Your commit is safe and local.".format(
                        cont["out"].strip()))
            log("velocity CSV conflict auto-resolved (re-exported from the DB).")
        elif union_files and core.classify_rebase_conflict(conflicted, union_files) == "union-only":
            # Consumer-configured append-only logs diverged on both sides — union-merge
            # each (keep every line), stage, and continue. Config-driven, so no committed
            # .gitattributes is required (#36 guard 2 / #290).
            for f in conflicted:
                union_merge_and_stage(f)
            cont = sh_capture("GIT_EDITOR=true git rebase --continue")
            if not cont["ok"]:
                sh("git rebase --abort", True)
                die("union-file conflict: merge + stage succeeded but rebase --continue "
                    "failed: {}. Your commit is safe and local.".format(cont["out"].strip()))
            log("union-file conflict auto-resolved (merge=union, kept both sides).")
        elif markdown_indexes and core.is_markdown_index_only_conflict(conflicted, markdown_indexes):
            # Consumer-configured append-only markdown indexes diverged (each agent
            # appended a row) — strip the conflict markers (keep both rows, dedup an
            # adjacent identical row), stage, and continue. (#36 guard 4 / #971)
            for f in conflicted:
                resolve_markdown_index_and_stage(f)
            cont = sh_capture("GIT_EDITOR=true git rebase --continue")
            if not cont["ok"]:
                sh("git rebase --abort", True)
                die("learnings-index conflict: resolve + stage succeeded but rebase --continue "
                    "failed: {}. Your commit is safe and local.".format(cont["out"].strip()))
            log("learnings-index conflict auto-resolved (kept both rows).")
        else:
            sh("git rebase --abort", True)
            die("rebase hit a real conflict in: {}. ".format(", ".join(conflicted) or rebase["out"].strip())
                + "Aborted the rebase. Resolve manually, then re-run close. "
                "Your commit is safe and local.")
    push = sh_capture("git push origin HEAD:main")
    if push["ok"]:
        return "ok"
    return classify_push_error(push["out"])


def report(issue, branch, wt_path, closing_sha, landed_sha, kept, dry):
    short = wt_path.replace(os.environ.get("HOME", "\0"), "~") if wt_path else "(unknown)"
    bar = "─" * 58
    print(bar)
    print("  {}  ·  issue: #{}".format(
        "WOULD CLOSE" if dry else ("LANDED (kept worktree)" if kept else "CLOSED"), issue))
    print(bar)
    print("  branch    {}".format(branch or "(detached)"))
    print("  worktree  {}".format(short))
    if closing_sha:
        print("  commit    {}  (on origin/main)".format(closing_sha[:12]))
        if landed_sha and landed_sha != closing_sha:
            print("  tip       {}  (post-rebase HEAD)".format(landed_sha[:12]))
    print(bar)
    tip_field = " tip={}".format(landed_sha) if (landed_sha and landed_sha != closing_sha) else ""
    print("CLOSE {} issue={} branch={} sha={}{}{}".format(
        "DRYRUN" if dry else "OK", issue, branch or "", closing_sha or "",
        tip_field, " kept=1" if kept else ""))


def log_comment_prompt(issue, closing_sha):
    s = closing_sha[:12] if closing_sha else "(sha)"
    log('Post your closing comment:\n  gh issue comment {} --body "Closed in {}. <your summary here>"'.format(issue, s))


def main():
    opts = parse_args(sys.argv[1:])
    if not opts["issue"] or not re.match(r"^\d+$", str(opts["issue"])):
        die("usage: close <issue-number> [--branch <name>] [--max N] [--dry-run] [--keep] "
            "[--no-verify-issue] [--skip-marker-check] [--skip-keyword-check] [--skip-scope-audit] "
            "[--skip-velocity-check] [--worktree-dir <dir>]", 2)
    issue = opts["issue"]

    # --- pre-flight: refuse to start unless the close is real and the tree sane.
    branch = opts["branch"] or current_branch()
    # Injection guard (#37): --branch is interpolated into teardown's `git branch
    # -D <branch>`. Reject shell metacharacters, then require an ANCHORED branch
    # shape bound to the issue token (the old guards were unanchored substring
    # searches, so `x/issue-17; touch ...` slipped through). The anchored shape
    # tolerates the br-/<project>-<lang>- self-describing scheme (#17) as well as
    # legacy <fruit>/issue-N names — and, by anchoring, refuses a slug-embedded
    # `-issue-M` from masquerading as the issue token.
    if not branch or not is_safe_ref(branch):
        die('branch "{}" contains unsafe characters — '
            "only letters, digits, and . _ / - are allowed.".format(branch or "?"))
    if not re.match(r"^(?:br-)?[A-Za-z0-9._-]+/(?:[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-)?issue-\d+(?:-[A-Za-z0-9._-]+)?$", branch):
        die('current branch "{}" is not a [br-]<agent>/[<project>-<lang>-]issue-<N> worktree branch. '
            "Run this from inside the puzzle's worktree, not the main checkout.".format(branch))
    if not re.match(r"^(?:br-)?[A-Za-z0-9._-]+/(?:[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-)?issue-{}(?:-[A-Za-z0-9._-]+)?$".format(issue), branch):
        die('branch "{}" does not match issue #{}. Wrong worktree?'.format(branch, issue))

    root = main_root()
    fruit = claim_core.infer_fruit_from_branch(branch) or branch.split("/")[0]
    wt_path = os.path.join(root, opts["worktreeDir"], claim_core.branch_to_worktree_name(branch))
    if opts["branch"]:
        try:
            os.chdir(wt_path)
        except OSError:
            die("--branch supplied but worktree not found at {}. Is it still present?".format(wt_path))

    closing_commit_sha = find_closing_commit_sha(issue)
    if not closing_commit_sha:
        # Recovery path: agent may have pushed before running close.
        sh("git fetch origin main", True)
        already_landed = find_closing_commit_on_main(issue)
        if already_landed:
            state = sh("gh issue view {} --json state -q .state".format(issue), True)
            if state and state.strip().upper() != "OPEN":
                log("commit {} already on origin/main and #{} is {} — treating as clean close.".format(
                    already_landed[:12], issue, state.strip()))
                delete_claim_ref(issue)
                if opts["keep"]:
                    report(issue, branch, wt_path, already_landed, already_landed, True, False)
                    log_comment_prompt(issue, already_landed)
                    return
                os.chdir(root)
                pull = sh_capture("git pull --ff-only origin main")
                if pull["ok"]:
                    log("main checkout synced.")
                else:
                    log("warn: ff pull of main skipped ({}). Sync manually: "
                        'git -C "{}" pull --ff-only origin main'.format(
                            pull["out"].strip().split(chr(10))[0][:80], root))
                report(issue, branch, wt_path, already_landed, already_landed, False, False)
                log("Shell re-root: cd \"{}\"".format(root))
                log_comment_prompt(issue, already_landed)
                _teardown(wt_path, branch, root)
                return
        die('No unpushed commit references "Closes #{}". Commit the close '
            "(marker deletion + `Closes #N`) FIRST, then run close. "
            "This tool lands an existing close commit; it does not author one.".format(issue))

    # Scope audit (informational, non-blocking, skippable).
    if not opts["skipScopeAudit"]:
        sh("git fetch origin main", True)
        base = (sh("git merge-base HEAD origin/main", True) or "").strip()
        stat = sh(scope_audit_diff_command(base), True)
        if stat and stat.strip():
            label = "merge-base..HEAD" if base else "origin/main (fallback)"
            print("[close] scope audit (git diff --stat {}):".format(label))
            print(stat.rstrip())

    # Velocity-row guard (#5, skippable): config-gated; SQLite is source of truth.
    if not opts["skipVelocityCheck"]:
        check_velocity_guard(issue, fruit)

    # Guard 2 (keyword): closing commit subject vs issue title.
    if not opts["skipKeywordCheck"]:
        check_keyword_match(issue, closing_commit_sha)
    # Guard (marker): the puzzle marker must have been deleted before closing.
    if not opts["skipMarkerCheck"]:
        check_marker_deleted(issue)

    if rebase_or_merge_in_progress():
        die("a rebase/merge is already in progress here — finish or abort it first.")
    if not tree_is_clean():
        die("working tree is not clean. Commit or stash everything into the close "
            "commit first (this tool only pushes what is already committed).")

    sha = head_sha()

    if opts["dryRun"]:
        log("would loop fetch/rebase/push (max {}), verify {} on origin/main, then {} the worktree.".format(
            opts["max"], sha[:12] if sha else "", "KEEP" if opts["keep"] else "remove"))
        report(issue, branch, wt_path, None, None, opts["keep"], True)
        return

    # --- land: loop fetch/rebase/push until it sticks or we give up.
    landed = False
    for attempt in range(1, opts["max"] + 1):
        verdict = try_land()
        if verdict == "ok":
            landed = True
            break
        if verdict == "rejected-other":
            die("push was rejected for a non-racy reason (hook, auth, or protected "
                "branch) on attempt {}. Your commit is SAFE and local — "
                "fix the cause and re-run close. Worktree left intact.".format(attempt))
        log("push lost the race (attempt {}/{}) — re-fetching and retrying.".format(attempt, opts["max"]))
    if not landed:
        die("push lost the race {} times — main is hot right now. Your commit {} is "
            "SAFE and local; re-run close (or raise --max). Worktree left intact, "
            "NOT removed.".format(opts["max"], sha[:12] if sha else ""))

    landed_sha = head_sha()
    closing_on_main = find_closing_commit_on_main(issue)

    # --- the gate: verify on origin/main before ANY teardown.
    sh("git fetch origin main", True)
    if not should_cleanup({"onOriginMain": on_origin_main(landed_sha)}):
        die("push reported success but {} is NOT on origin/main — refusing to remove "
            "the worktree. Investigate before cleaning up; your work is intact.".format(
                landed_sha[:12] if landed_sha else ""))
    if closing_on_main:
        log("commit {} confirmed on origin/main.".format(closing_on_main[:12]))
        if landed_sha and landed_sha != closing_on_main:
            log("tip {} is the post-rebase HEAD.".format(landed_sha[:12]))
    else:
        log("commit {} confirmed on origin/main.".format(landed_sha[:12] if landed_sha else ""))

    delete_claim_ref(issue)

    # --- best-effort: confirm the issue actually closed (the keyword can lag).
    if opts["verifyIssue"]:
        st = sh("gh issue view {} --json state -q .state".format(issue), True)
        if st and st.strip().upper() == "OPEN":
            log("#{} still shows OPEN — closing it explicitly.".format(issue))
            comment = "Closed via pmtools close (commit {} on main).".format(
                landed_sha[:12] if landed_sha else "")
            # arg-array exec (#37): the only gh WRITE call — argv, never shell-parsed.
            subprocess.run(["gh", "issue", "close", str(issue), "-c", comment],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif st:
            log("#{} is {}.".format(issue, st.strip()))

    if opts["keep"]:
        report(issue, branch, wt_path, closing_on_main, landed_sha, True, False)
        log_comment_prompt(issue, closing_on_main or landed_sha)
        return

    # --- teardown: only reachable past the gate. Run from main root.
    os.chdir(root)
    pull = sh_capture("git pull --ff-only origin main")
    if pull["ok"]:
        log("main checkout synced.")
    else:
        log("warn: ff pull of main skipped ({}). Sync manually: "
            'git -C "{}" pull --ff-only origin main'.format(
                pull["out"].strip().split(chr(10))[0][:80], root))

    report(issue, branch, wt_path, closing_on_main, landed_sha, False, False)
    log("Shell re-root: cd \"{}\"".format(root))
    log_comment_prompt(issue, closing_on_main or landed_sha)
    _teardown(wt_path, branch, root)


def _teardown(wt_path, branch, root):
    """Remove the worktree + branch + prune. Run synchronously from root (the
    detached-subprocess trick in close.js dodges an npm getcwd bug we don't have)."""
    # arg-array exec, short-circuited to mirror the old `&&` chain (#37).
    res = git_capture(["worktree", "remove", wt_path])
    if res["ok"]:
        res = git_capture(["branch", "-D", branch])
    if res["ok"]:
        git_capture(["worktree", "prune"])
    if not res["ok"]:
        sys.stderr.write("[close] warning: teardown may have failed — check: git worktree list\n")


if __name__ == "__main__":
    main()
