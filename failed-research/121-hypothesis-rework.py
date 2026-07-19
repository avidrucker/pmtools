#!/usr/bin/env python3
"""
121-hypothesis-rework.py — test ONE finding from the #121 waste audit, from raw data.

    H1: `fix:` commits disproportionately delete RECENTLY-WRITTEN code.
        (i.e. fixes repair fresh work, rather than paying down old debt)

This is NOT a regression test. Nothing is hardcoded to a previously-claimed value. The
script derives the numbers from git and then tries to KILL the hypothesis four ways. It
prints whatever it finds -- including "refuted" or "cannot distinguish".

    ./121-hypothesis-rework.py [--repo lccjs|pycats] [--window 14]

WHY A NULL IS MANDATORY
    "88% of the lines fixes delete are <14 days old" sounds damning and means nothing on
    its own. In a young, fast-moving repo MOST lines are <14 days old. The question is
    whether fixes delete recent lines MORE than chance -- so the honest statistic is the
    ratio of the fix rate to the base rate in the SAME FILES the fixes touched.

METHOD
    cohort   = non-merge `fix:` commits in the 30 days before the pinned SHA
    observed = for each deleted line, blame it at the commit's PARENT to find the commit
               that introduced it; age = fix_date - introduce_date; count age < window
    null     = at the same parent, blame the WHOLE file; what fraction of ALL its lines
               are < window old? That is the chance rate for a randomly-chosen line.
    result   = enrichment = observed_rate / null_rate, with a two-proportion z-test.
"""
import argparse
import re
import subprocess
import sys
from collections import defaultdict
from math import sqrt

PINNED = {
    "lccjs":  ("/home/avi/Documents/Study/JavaScript/lccjs",
               "c83d41b8391ad32ec486a5c17dc99c36c0933378"),
    "pycats": ("/home/avi/Documents/Study/Python/pycats",
               "0fe74ddf13471598198fb06e40fd2fac2d05a4fc"),
}
CODE = (".js", ".py", ".sh", ".mjs", ".cjs")


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo, *args],
                       capture_output=True, text=True, timeout=120)
    return r.stdout


def commit_time(repo, sha):
    out = git(repo, "log", "-1", "--format=%ct", sha).strip()
    return int(out) if out else None


def fix_commits(repo, sha, days=30):
    """Non-merge commits whose subject starts with fix: / bug: in the window before sha."""
    out = git(repo, "log", sha, "--no-merges", f"--since={days} days ago",
              "--format=%H%x09%ct%x09%s")
    out2 = git(repo, "log", "-1", "--format=%ct", sha)
    tip = int(out2.strip())
    cutoff = tip - days * 86400
    rows = []
    for line in out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        h, ct, subj = parts
        ct = int(ct)
        if ct < cutoff:
            continue
        if re.match(r"^\s*(fix|bug)\s*(\([^)]*\))?\s*!?:", subj, re.I):
            rows.append((h, ct, subj))
    return rows


def deleted_ranges(repo, sha):
    """{path: [(start,count), ...]} of lines this commit DELETED, in the parent's numbering."""
    out = git(repo, "show", sha, "--unified=0", "--no-color", "-M",
              "--format=", "--", *[f"*{e}" for e in CODE])
    ranges, cur = defaultdict(list), None
    for line in out.splitlines():
        if line.startswith("--- a/"):
            cur = line[6:]
        elif line.startswith("--- /dev/null"):
            cur = None
        elif line.startswith("@@") and cur:
            m = re.match(r"@@ -(\d+)(?:,(\d+))? \+", line)
            if m:
                start = int(m.group(1))
                count = int(m.group(2)) if m.group(2) is not None else 1
                if count > 0:
                    ranges[cur].append((start, count))
    return ranges


def blame_ages(repo, parent, path, fix_ct, ranges=None):
    """Ages (seconds) of blamed lines. ranges=None → blame the WHOLE file (the null)."""
    args = ["blame", "--porcelain", "-w", "-M", "-C"]
    if ranges:
        for start, count in ranges:
            args += ["-L", f"{start},+{count}"]
    args += [parent, "--", path]
    out = git(repo, *args)
    ages, seen = [], {}
    cur = None
    for line in out.splitlines():
        m = re.match(r"^([0-9a-f]{40}) \d+ \d+", line)
        if m:
            cur = m.group(1)
        elif line.startswith("author-time ") and cur:
            seen[cur] = int(line.split()[1])
            ages.append(fix_ct - seen[cur])
            cur = None
    return ages


def two_prop_z(x1, n1, x2, n2):
    if n1 == 0 or n2 == 0:
        return float("nan")
    p1, p2 = x1 / n1, x2 / n2
    p = (x1 + x2) / (n1 + n2)
    se = sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    return (p1 - p2) / se if se else float("nan")


def run(repo_key, window_days, quiet=False):
    repo, sha = PINNED[repo_key]
    window = window_days * 86400
    fixes = fix_commits(repo, sha)
    if not quiet:
        print(f"repo={repo_key}  pinned={sha[:8]}  window={window_days}d  "
              f"fix-commits in cohort: {len(fixes)}")

    obs_recent = obs_total = 0
    null_recent = null_total = 0
    per_commit = []          # for the jackknife

    for h, ct, _subj in fixes:
        parent = git(repo, "rev-parse", f"{h}^").strip()
        if not parent:
            continue
        rngs = deleted_ranges(repo, h)
        c_obs_r = c_obs_t = 0
        for path, rs in rngs.items():
            ages = blame_ages(repo, parent, path, ct, rs)
            c_obs_t += len(ages)
            c_obs_r += sum(1 for a in ages if a < window)
            # the null: every line of that same file, at that same moment
            nages = blame_ages(repo, parent, path, ct, None)
            null_total += len(nages)
            null_recent += sum(1 for a in nages if a < window)
        obs_recent += c_obs_r
        obs_total += c_obs_t
        if c_obs_t:
            per_commit.append((h, c_obs_r, c_obs_t))

    return dict(repo=repo_key, window=window_days, fixes=len(fixes),
                obs_recent=obs_recent, obs_total=obs_total,
                null_recent=null_recent, null_total=null_total,
                per_commit=per_commit)


def report(r):
    o_r, o_t = r["obs_recent"], r["obs_total"]
    n_r, n_t = r["null_recent"], r["null_total"]
    if o_t == 0 or n_t == 0:
        print("  INSUFFICIENT DATA — no deleted code lines in cohort. Cannot test.")
        return None
    obs = o_r / o_t
    null = n_r / n_t
    enr = obs / null if null else float("nan")
    z = two_prop_z(o_r, o_t, n_r, n_t)

    print(f"\n  OBSERVED  fixes deleted {o_t} code lines; {o_r} were <{r['window']}d old"
          f"  → {obs:6.1%}")
    print(f"  NULL      those same files held {n_t} lines; {n_r} were <{r['window']}d old"
          f"  → {null:6.1%}")
    print(f"  ENRICHMENT  {enr:.2f}×      z = {z:+.1f}")
    print()
    # Four outcomes, not three. An instrument that cannot report "the OPPOSITE of your
    # hypothesis is true" is a broken instrument -- and this one couldn't, until a synthetic
    # reversed-effect case was fed to it and came back "AMBIGUOUS" (z=-4.1, enrichment 0.49x).
    if z < -3:
        print(f"  → H1 REFUTED — and REVERSED. Fixes delete recent code {1/enr:.2f}× LESS than")
        print("    chance. They are paying down OLD debt, which is the opposite of the claim.")
    elif enr > 1.2 and z > 3:
        print(f"  → H1 SUPPORTED. Fixes delete recent code {enr:.2f}× more than chance.")
    elif abs(z) < 3:
        print("  → H1 NOT SUPPORTED. Fixes delete recent code at ~the base rate; the effect is")
        print("    indistinguishable from chance. The raw percentage is an artifact of a")
        print("    young/fast-moving codebase, not a finding.")
    else:
        print(f"  → AMBIGUOUS — significant (z={z:+.1f}) but small (enrichment={enr:.2f}×).")
        print("    Statistically real, practically negligible. Do not act on it.")
    print(f"\n  NOTE: the bare '{obs:.0%} of deleted lines were recent' figure is NOT the")
    print(f"  finding. On its own it is uninterpretable: {null:.0%} of ALL lines in those")
    print("  files were recent anyway. Only the ENRICHMENT means anything.")
    return enr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="lccjs", choices=list(PINNED))
    ap.add_argument("--window", type=int, default=14)
    a = ap.parse_args()

    print("=" * 72)
    print("H1: `fix:` commits disproportionately delete RECENTLY-WRITTEN code.")
    print("=" * 72)
    r = run(a.repo, a.window)
    enr = report(r)
    if enr is None:
        return 2

    print("\n" + "=" * 72)
    print("NOW TRY TO KILL IT — four ways the finding could be an artifact")
    print("=" * 72)

    # ---- FALSIFIER 1: is it one commit? -------------------------------------
    print("\n[1] JACKKNIFE — is this driven by a single large commit?")
    pc = sorted(r["per_commit"], key=lambda t: -t[2])
    if pc:
        biggest = pc[0]
        rr = r["obs_recent"] - biggest[1]
        tt = r["obs_total"] - biggest[2]
        print(f"    largest contributor {biggest[0][:8]}: {biggest[2]} of {r['obs_total']} "
              f"lines ({biggest[2]/r['obs_total']:.0%})")
        if tt:
            null = r["null_recent"] / r["null_total"]
            print(f"    drop it → observed {rr/tt:.1%}, enrichment {(rr/tt)/null:.2f}× "
                  f"(was {enr:.2f}×)")
            print("    VERDICT: robust." if abs((rr/tt)/null - enr) < 0.3
                  else "    VERDICT: FRAGILE — one commit is moving the result.")
        else:
            print("    VERDICT: FRAGILE — nothing left after dropping it.")

    # ---- FALSIFIER 2: window sensitivity -----------------------------------
    print("\n[2] WINDOW SWEEP — is 14 days a knob that was tuned to the answer?")
    for w in (7, 14, 21, 30):
        rw = run(a.repo, w, quiet=True)
        if rw["obs_total"] and rw["null_total"]:
            o = rw["obs_recent"] / rw["obs_total"]
            n = rw["null_recent"] / rw["null_total"]
            print(f"    {w:>2}d: observed {o:6.1%}  null {n:6.1%}  enrichment {o/n:5.2f}×")
    print("    (A finding that only exists at one window is a tuned knob, not a result.)")

    # ---- FALSIFIER 3: does it replicate in the other repo? -----------------
    print("\n[3] REPLICATION — does it hold in the other repo?")
    other = "pycats" if a.repo == "lccjs" else "lccjs"
    ro = run(other, a.window, quiet=True)
    if ro["obs_total"] and ro["null_total"]:
        o = ro["obs_recent"] / ro["obs_total"]
        n = ro["null_recent"] / ro["null_total"]
        print(f"    {other}: observed {o:.1%}  null {n:.1%}  enrichment {o/n:.2f}×  "
              f"(n={ro['obs_total']} lines, {ro['fixes']} fixes)")
        print("    (Replication is support. Failure to replicate is NOT refutation —")
        print("     the repos differ in age, pace, and test discipline.)")
    else:
        print(f"    {other}: insufficient data — CANNOT replicate. Treat H1 as single-repo.")

    # ---- FALSIFIER 4: the thing the statistic cannot tell you ---------------
    print("\n[4] WHAT THIS CANNOT SHOW — read before acting")
    print("    · Enrichment shows fixes CONCENTRATE on recent code. It does NOT show that")
    print("      the recent code was BAD, nor that a test would have caught it.")
    print("    · `fix:` is a commit-message convention, not ground truth. A mislabelled")
    print("      commit is invisible here.")
    print("    · Survivorship: a bug never found is never fixed, so never counted.")
    print("    · The recommendation ('test at authoring time') does NOT follow from this")
    print("      number alone — it follows from this number PLUS the sub-hour lead time,")
    print("      which is a separate claim you should check separately.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
