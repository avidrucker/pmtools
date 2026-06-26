"""Pure claim-core functions, ported faithfully from lccjs scripts/claim.js.

These are the I/O-free decision seams of the `claim` command: identity
resolution, arg parsing, staleness guards, marker flipping, worktree-collision
detection, and the cross-clone claim-push classifier. The git/gh side effects in
claim.js's main() are NOT ported here — only the pure parts, so they are
testable without a repo and graded against the shared fixtures/claim/*.cases.json.

Parity: every function mirrors its JS twin in js/claim_core.js; both are graded
against the SAME fixtures. No lccjs paths leak into this layer — the FRUITS
roster is exposed but callers may pass their own.
"""

import math
import re

# Lowest-index-first roster. Exposed, but functions that need a roster accept one
# (default FRUITS) so no lccjs-specific list is hardcoded into a consumer.
FRUITS = [
    "apple", "banana", "cherry", "date", "dragonfruit", "elderberry", "fig", "grape",
    "honeydew", "incaberry", "jackfruit", "kiwi", "lemon", "mango", "nectarine", "olive", "peach",
    "quince", "raspberry", "strawberry", "tangerine", "ugli", "vanilla",
    "watermelon", "ximenia", "yuzu", "zucchini",
]

# Default TTLs (unix seconds), mirroring claim.js constants.
SESSION_SENTINEL_MAX_AGE_S = 7 * 24 * 60 * 60   # 7 days
CLAIM_REF_MAX_AGE_S = 2 * 24 * 60 * 60          # 2 days

# Marker keyword strings (split in JS to dodge the PDD scanner; plain here).
TODO_KW = "@" + "todo"
INPROGRESS_KW = "@" + "inprogress"


# ---------------------------------------------------------------------------
# injection safety (#37)
# ---------------------------------------------------------------------------

# A value is safe to interpolate into a ref/identity position iff it is a
# non-empty string of ref-legal characters only: letters, digits, dot,
# underscore, slash, dash. Every shell metacharacter (`;`, whitespace, `$`,
# backtick, `|`, `&`, `>`, `<`, newline, ...) is rejected. This is the
# load-bearing guard behind `--base` + agent identity (claim) and `--branch`
# (close/release); the arg-array exec migration is defense-in-depth on top.
# fullmatch (not `$`) so a trailing newline is rejected, matching the JS twin.
SAFE_REF_RE = re.compile(r"[A-Za-z0-9._/-]+")


def is_safe_ref(s):
    return isinstance(s, str) and SAFE_REF_RE.fullmatch(s) is not None


# ---------------------------------------------------------------------------
# slug / identity helpers
# ---------------------------------------------------------------------------

def slugify(s):
    """Slugify a title into a short branch-safe tail (≤5 hyphen-joined parts)."""
    s = str(s).lower()
    s = re.sub(r"\[[^\]]*\]", " ", s)        # drop [OB-008]-style prefixes
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"^-+|-+$", "", s)
    return "-".join(s.split("-")[:5])


def normalize_identity(s):
    """Lowercase + trim a human-supplied identity to a branch-safe token."""
    return str(s).strip().lower()


def infer_fruit_from_branch(branch):
    """Extract <agent> from a [br-]<agent>/[<project>-<lang>-]issue-N[...] branch, else None."""
    if not branch:
        return None
    # agent tolerates a `-<N>` collision-fallback suffix (claim's `${roster[0]}-2`), #49.
    m = re.match(r"^(?:br-)?([a-z0-9]+(?:-[0-9]+)?)/(?:[a-z0-9]+-[a-z0-9]+-)?issue-\d+", branch)
    return m.group(1) if m else None


def parse_claim_refs(listing):
    """Parse `git ls-remote origin 'refs/claims/*'` output -> sorted, unique
    claimed issue numbers. The cross-clone-safe in-flight signal: the claim ref
    lives on origin, so it is visible from any clone and independent of any
    clone's `git worktree list` or branch-naming scheme — the gap that let the
    orchestrator double-assign a claimed issue. Pure. (#70)"""
    issues = set()
    for line in str(listing or "").split("\n"):
        m = re.search(r"refs/claims/issue-(\d+)\b", line)
        if m:
            issues.add(int(m.group(1)))
    return sorted(issues)


def resolve_identity(opts, env, branch=None):
    """Resolve agent identity by precedence: --as > env > branch-inferred > auto.

    Returns {name, source, modeLabel}. name=None means auto (pick a fresh fruit).
    """
    if opts.get("as"):
        return {"name": normalize_identity(opts["as"]), "source": "as", "modeLabel": "reuse (--as)"}
    env_name = normalize_identity(env.get("CLAUDE_AGENT_NAME") or "")
    if env_name:
        return {"name": env_name, "source": "env", "modeLabel": "human-directed (env)"}
    inferred = infer_fruit_from_branch(branch)
    if inferred:
        return {"name": inferred, "source": "branch", "modeLabel": "branch-inferred"}
    return {"name": None, "source": "auto", "modeLabel": "auto"}


def parse_args(argv):
    """Parse the claim CLI argv into an opts dict.

    Mirrors claim.js parseArgs. JS calls die() on an unknown --flag; here we
    raise ValueError so the behavior stays testable for valid inputs while still
    rejecting unknown flags loudly.
    """
    opts = {
        "issue": None, "slug": None, "as": None, "base": "main",
        "dryRun": False, "allowStaleMain": False, "force": False,
        "custom": False, "allowUncategorized": False,
    }
    positionals = []
    i = 0
    n = len(argv)
    while i < n:
        a = argv[i]
        if a == "--as":
            i += 1
            opts["as"] = argv[i] if i < n else None
        elif a == "--base":
            i += 1
            opts["base"] = argv[i] if i < n else None
        elif a == "--dry-run":
            opts["dryRun"] = True
        elif a == "--force":
            opts["force"] = True
        elif a == "--allow-stale-main":
            opts["allowStaleMain"] = True
        elif a == "--allow-uncategorized" or a == "--no-lane-check":
            opts["allowUncategorized"] = True
        elif a == "--custom":
            opts["custom"] = True
        elif a.startswith("--"):
            raise ValueError("unknown flag: " + a)
        else:
            positionals.append(a)
        i += 1
    opts["issue"] = positionals[0] if len(positionals) > 0 else None
    opts["slug"] = positionals[1] if len(positionals) > 1 else None
    return opts


def check_identity_name(identity, opts, fruits=None):
    """Notice (never block) an unrecognised agent name. Returns None or {warn}."""
    if fruits is None:
        fruits = FRUITS
    name = identity.get("name")
    if not name or name.lower() in fruits:
        return None
    return {"warn": '"{}" is not in the known fruit list — using it anyway.'.format(name)}


# ---------------------------------------------------------------------------
# staleness / base guards
# ---------------------------------------------------------------------------

def _to_number(v, default=0):
    """Mimic JS `Number(v) || default`: NaN/None/unparseable -> default."""
    if v is None:
        return default
    if isinstance(v, bool):
        return (1 if v else 0) or default
    if isinstance(v, (int, float)):
        if isinstance(v, float) and math.isnan(v):
            return default
        return v or default
    try:
        f = float(v)
        if math.isnan(f):
            return default
        return f or default
    except (ValueError, TypeError):
        return default


def assess_base_staleness(base, behind):
    """Pure stale-main guard (#228). Only a local `main` base can be stale."""
    checks_remote = base == "main" or base == "refs/heads/main"
    n = _to_number(behind, 0)
    # Normalize integral floats back to int for clean fixture equality.
    if isinstance(n, float) and n.is_integer():
        n = int(n)
    return {"checksRemote": checks_remote, "behind": n, "stale": bool(checks_remote and n > 0)}


# --- self-describing naming scheme (br-/wt- prefixes) -----------------------
# Short language tags for the <lang> field. Sensible default map; unknown
# languages pass through lowercased + alnum-only; empty/null -> 'unk'. Extend freely.
LANG_TAGS = {
    "javascript": "js", "typescript": "ts", "python": "py", "clojure": "clj",
    "java": "java", "ruby": "rb", "go": "go", "rust": "rs", "c": "c", "c++": "cpp",
    "cpp": "cpp", "csharp": "cs", "php": "php", "shell": "sh", "bash": "sh",
}


def lang_tag(language):
    """Short <lang> tag. Known map, else lowercased alnum-only, else 'unk'."""
    key = str(language or "").strip().lower()
    if not key:
        return "unk"
    if key in LANG_TAGS:
        return LANG_TAGS[key]
    slug = re.sub(r"[^a-z0-9]", "", key)
    return slug or "unk"


def build_branch(parts):
    """branch = br-<agent>/<project>-<lang>-issue-<N>[-<slug>]."""
    slug = parts.get("slug")
    tail = "-{}".format(slug) if slug else ""
    return "br-{}/{}-{}-issue-{}{}".format(
        parts["agent"], parts["project"], parts["lang"], parts["issue"], tail)


def build_worktree_name(parts):
    """worktree dir = wt-<agent>-<project>-<lang>-issue-<N> (slug never in dir name)."""
    return "wt-{}-{}-{}-issue-{}".format(
        parts["agent"], parts["project"], parts["lang"], parts["issue"])


def branch_to_worktree_name(branch):
    """Map a branch (new OR legacy) to its worktree dir name — the back-compat
    bridge close uses. New br-…/… -> wt-…; legacy <fruit>/issue-N… -> <fruit>-issue-N."""
    if not branch:
        return None
    is_new = branch.startswith("br-")
    core = branch[3:] if is_new else branch
    flat = re.sub(r"(issue-\d+).*$", r"\1", core.replace("/", "-", 1))
    return "wt-" + flat if is_new else flat


def sentinel_branch(fruit):
    """Return the <fruit>/session sentinel branch name."""
    return "{}/session".format(fruit)


def _is_finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def is_sentinel_stale_by_age(commit_ts, now_s, max_age_s=SESSION_SENTINEL_MAX_AGE_S):
    """Is a session sentinel stale by age? Non-finite ts -> stale (free the fruit)."""
    if not _is_finite(commit_ts):
        return True
    return (now_s - commit_ts) > max_age_s


# ---------------------------------------------------------------------------
# marker flip
# ---------------------------------------------------------------------------

def apply_marker_flip(content, issue):
    """Flip the first LIVE `@todo #N:<est>/<ROLE>` marker to `@inprogress`.

    A live marker requires the canonical `:<est>/<ROLE>` tail — a bare mention
    (`@todo #88` in a note/TIL) is never flipped (#1116), and the required colon
    subsumes the #42-in-#420 guard (#420). Returns {updated, flipped, line}
    (line is 1-indexed, 0 when no flip).
    """
    pat = re.compile(r"{}(\s+#{}:\s*\d+\w*/[A-Z]+)".format(re.escape(TODO_KW), issue))
    match = pat.search(content)
    if not match:
        return {"updated": content, "flipped": False, "line": 0}
    updated = pat.sub(lambda m: INPROGRESS_KW + m.group(1), content, count=1)
    line = content[: content.index(match.group(0))].count("\n") + 1
    return {"updated": updated, "flipped": True, "line": line}


# ---------------------------------------------------------------------------
# worktree collision seams
# ---------------------------------------------------------------------------

def worktrees_with_issue(branches):
    """Filter worktree-branch entries to those with a parseable issue-<N> (new -issue- or legacy /issue-)."""
    result = []
    for entry in (branches or []):
        branch = entry.get("branch")
        fruit = entry.get("fruit")
        m = re.search(r"[-/]issue-(\d+)", branch) if branch else None
        if m:
            result.append({"branch": branch, "fruit": fruit, "issue": int(m.group(1))})
    return result


def find_live_worktree_for_issue(entries, issue_num):
    """First worktree entry whose issue matches, else None."""
    for w in entries:
        if w["issue"] == issue_num:
            return w
    return None


def find_same_issue_collision(entries, issue_num, own_branch):
    """First entry with the same issue under a DIFFERENT branch, else None."""
    for w in (entries or []):
        if w["issue"] == issue_num and w["branch"] != own_branch:
            return w
    return None


def should_block_worktree_guard(existing_wt, opts):
    """Live-worktree guard: block unless --force or --dry-run, or no worktree."""
    if not existing_wt:
        return False
    return not opts.get("force") and not opts.get("dryRun")


# ---------------------------------------------------------------------------
# issue-state guards
# ---------------------------------------------------------------------------

def should_block_claim(info, force):
    """Block a claim only on a definitive CLOSED state; offline/--force proceed."""
    if force:
        return False
    return bool(info and info.get("state") == "CLOSED")


def needs_area_label(labels):
    """True when an issue lacks a real area:* label (or only area:uncategorized)."""
    if not isinstance(labels, list):
        return False
    areas = [l for l in labels if isinstance(l, str) and l.startswith("area:")]
    if len(areas) == 0:
        return True
    return "area:uncategorized" in areas


def should_block_uncategorized(info, allow):
    """Hard lane gate (#1151). allow short-circuits; offline never blocks."""
    if allow:
        return False
    return bool(info and needs_area_label(info.get("labels")))


# ---------------------------------------------------------------------------
# cross-clone claim push
# ---------------------------------------------------------------------------

_OK_RE = re.compile(r"\[new reference\]|Everything up-to-date|\bnew branch\b", re.I)
_CONFLICT_RES = [
    re.compile(r"\[rejected\]", re.I),
    re.compile(r"non-fast-forward", re.I),
    re.compile(r"\bfetch first\b", re.I),
    re.compile(r"cannot lock ref", re.I),
    re.compile(r"failed to push some refs", re.I),
    re.compile(r"tip of your current branch is behind", re.I),
]
_TRANSIENT_RES = [
    re.compile(r"could not resolve host", re.I),
    re.compile(r"couldn't resolve host", re.I),
    re.compile(r"connection refused", re.I),
    re.compile(r"connection timed out", re.I),
    re.compile(r"operation timed out", re.I),
    re.compile(r"\btimed out\b", re.I),
    re.compile(r"network is unreachable", re.I),
    re.compile(r"unable to access", re.I),
    re.compile(r"could not read from remote", re.I),
    re.compile(r"permission denied", re.I),
    re.compile(r"authentication failed", re.I),
    re.compile(r"\b403\b"),
    re.compile(r"no such remote|does not appear to be a git repository|no configured push destination", re.I),
]


def classify_claim_push_result(output):
    """Classify push stdout+stderr into 'OK' / 'CONFLICT' / 'TRANSIENT'.

    Order: success markers first, then the conflict-reject family, then transient
    signals; empty -> OK; unrecognised failure -> TRANSIENT (best-effort proceed).
    """
    s = "" if output is None else str(output)
    if _OK_RE.search(s):
        return "OK"
    if any(rx.search(s) for rx in _CONFLICT_RES):
        return "CONFLICT"
    if any(rx.search(s) for rx in _TRANSIENT_RES):
        return "TRANSIENT"
    if s.strip() == "":
        return "OK"
    return "TRANSIENT"


def build_claim_message(issue, branch, pid, stamp):
    """Per-agent-unique commit message for the cross-clone claim object."""
    return "claim issue-{} {} pid={} {}".format(issue, branch, pid, stamp)


def claim_push_action(verdict, force):
    """Map a classify verdict + --force into the claim action."""
    if force:
        return "PROCEED"
    if verdict == "CONFLICT":
        return "ROLLBACK_DIE"
    if verdict == "TRANSIENT":
        return "WARN_PROCEED"
    return "PROCEED"


def claim_ref_is_stale(args):
    """Is a remote claim ref stale? args: {issueState, claimCommitTs, nowS, ttl?}.

    CLOSED/MERGED -> stale; OPEN past ttl -> stale; OPEN within ttl or no ts ->
    not stale; unknown/offline -> not stale (best-effort).
    """
    issue_state = args.get("issueState")
    claim_commit_ts = args.get("claimCommitTs")
    now_s = args.get("nowS")
    ttl = args.get("ttl", CLAIM_REF_MAX_AGE_S)

    state = "" if issue_state is None else str(issue_state).strip().upper()
    if state == "":
        return False
    if state == "CLOSED" or state == "MERGED":
        return True
    if state == "OPEN":
        if _is_finite(claim_commit_ts):
            return (now_s - claim_commit_ts) > ttl
        return False
    return False


# ---------------------------------------------------------------------------
# banner
# ---------------------------------------------------------------------------

def build_banner_lines(fruit, branch, wt_path, base, mode, dry,
                       comment_count=None, issue=None, home=None):
    """Build the CLAIMED/WOULD CLAIM banner as a list of lines.

    `home` parameterizes the HOME path used to shorten wt_path to `~` (claim.js
    reads process.env.HOME). When home is None, no shortening is done.
    """
    short = wt_path.replace(home, "~") if home else wt_path
    bar = "─" * 58
    lines = [
        bar,
        "  {}  ·  agent: {}  ({})".format("WOULD CLAIM" if dry else "CLAIMED", fruit, mode),
        bar,
        "  branch    {}".format(branch),
        "  worktree  {}".format(short),
        "  base      {}".format(base),
    ]
    if comment_count is not None and comment_count > 0:
        lines.append("  comments  {} — read them: gh issue view {} --comments".format(comment_count, issue))
    if not dry:
        lines.append("")
        lines.append("  next:")
        lines.append("    cd {}".format(short))
        lines.append("    # (claim already flipped the {} #N marker to {} #N if one was found)".format(TODO_KW, INPROGRESS_KW))
        lines.append("    # reuse this identity for later worktrees:  pmtools claim <issue> --as " + fruit)
    lines.append(bar)
    lines.append("CLAIM {} agent={} branch={} path={}".format("DRYRUN" if dry else "OK", fruit, branch, wt_path))
    return lines
