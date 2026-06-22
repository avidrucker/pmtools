"""Pure close-core functions, ported faithfully from lccjs scripts/close.js.

These are the I/O-free decision seams of the `close` command: push-error
classification, the cleanup gate, claim-ref delete command/classification,
rebase-conflict classification, the closing-commit body matcher, the Guard 2
keyword tokenizer/overlap, marker-presence detection, and the scope-audit diff
command. The git/gh side effects in close.js's main() are NOT ported here — only
the pure parts, so they are testable without a repo and graded against the
shared fixtures/close/*.cases.json.

Parity: every function mirrors its JS twin in js/close_core.js; both are graded
against the SAME fixtures. The lccjs-specific velocity-CSV / learnings-README
auto-resolve and parent-tracker scan are OUT of scope (see the close.js port
brief), so UNION_FILES defaults to EMPTY and classify_rebase_conflict treats any
conflict as 'blocking'.
"""

import re

DEFAULT_MAX_RETRIES = 5

# lccjs's merge=union auto-resolve set is OUT of scope for the pmtools port: any
# rebase conflict is treated as human-resolvable ('blocking'). Kept as an empty
# default so classify_rebase_conflict's signature matches the JS twin and callers
# may still pass their own union set.
UNION_FILES = []


# ---------------------------------------------------------------------------
# push / cleanup classification
# ---------------------------------------------------------------------------

# Retryable race signatures (order matters): ref-lock contention (the #200
# incident) + the non-ff family. The "[remote rejected]" PREFIX is not itself a
# fatal signal — the parenthetical reason is — so these are checked FIRST.
_RACE_RES = [
    re.compile(r"cannot lock ref", re.I),
    re.compile(r"non-fast-forward", re.I),
    re.compile(r"\bfetch first\b", re.I),
    re.compile(r"tip of your current branch is behind", re.I),
    re.compile(r"\[rejected\]", re.I),
]


def classify_push_error(output):
    """Classify a FAILED git push's stdout+stderr into 'race' | 'rejected-other'.

    Only call on a non-zero push: success is decided by the exit code. Race
    signals (re-fetch/rebase clears them) are checked first; anything else
    un-retryable (hook block, auth, protected branch, unrecognised) defaults to
    'rejected-other' — don't loop blindly.
    """
    s = "" if output is None else str(output)
    if any(rx.search(s) for rx in _RACE_RES):
        return "race"
    return "rejected-other"


def should_cleanup(args):
    """The gate. Cleanup is permitted IFF onOriginMain is exactly True.

    args: {"onOriginMain": bool|None}. The single chokepoint that makes
    "tear down after a failed push" structurally impossible.
    """
    return args.get("onOriginMain") is True


# ---------------------------------------------------------------------------
# claim-ref delete
# ---------------------------------------------------------------------------

def claim_ref_delete_command(issue):
    """The refspec command that deletes the cross-clone claim ref (a leading
    `:` deletes the remote ref)."""
    return "git push origin :refs/claims/issue-{}".format(issue)


def classify_claim_ref_delete(output):
    """Classify the claim-ref delete output. Idempotent by design.

    'DELETED' — removed, or a clean/empty exit (nothing to report).
    'ABSENT'  — the ref did not exist remotely → already deleted / never staked.
    'WARN'    — offline / auth / unrecognised → best-effort; the close continues.
    """
    s = "" if output is None else str(output)
    if re.search(r"\[deleted\]", s, re.I):
        return "DELETED"
    if re.search(r"remote ref does not exist|unable to delete", s, re.I):
        return "ABSENT"
    if s.strip() == "":
        return "DELETED"
    return "WARN"


# ---------------------------------------------------------------------------
# rebase conflict
# ---------------------------------------------------------------------------

def classify_rebase_conflict(paths, union_files=None):
    """Classify a rebase's conflicted paths.

    'none'       — no conflicts.
    'union-only' — every conflicted path is in union_files. Out of scope for
                   pmtools (union_files defaults EMPTY), so unreachable unless a
                   caller passes their own union set.
    'blocking'   — at least one non-union file conflicts → resolve manually.
    """
    if union_files is None:
        union_files = UNION_FILES
    items = [str(p).strip() for p in (paths or [])]
    items = [p for p in items if p]
    if not items:
        return "none"
    all_union = all(p in union_files for p in items)
    return "union-only" if all_union else "blocking"


# ---------------------------------------------------------------------------
# closing-commit detection
# ---------------------------------------------------------------------------

def body_closes_issue(text, issue):
    """True if the commit log text carries a GitHub close keyword for the issue.

    Accepts close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved. The
    text may be one commit body or several concatenated.
    """
    pat = re.compile(
        r"\b(clos(e|es|ed)|fix(e|es|ed)?|resolv(e|es|ed))\s+#{}\b".format(issue),
        re.I,
    )
    return bool(pat.search("" if text is None else str(text)))


# ---------------------------------------------------------------------------
# Guard 2: keyword extraction / overlap
# ---------------------------------------------------------------------------

# Stop-set for keyword extraction — role prefixes and filler words that carry no
# discriminating signal.
KEYWORD_STOP_SET = {
    "this", "that", "with", "from", "have", "been", "will", "into", "onto",
    "also", "when", "then", "than", "what", "where", "which",
    "writer", "research", "architect", "spike", "data",
}

# Short technical acronyms meaningful in this project that bypass the 4-char floor.
SHORT_TECH_WORDS = {"cli", "api", "lcc", "tdd", "e2e"}

_WORD_SPLIT_RE = re.compile(r"\W+")
_PURE_NUM_RE = re.compile(r"^\d+$")


def extract_keywords(text, stop_set=None):
    """Tokenize text into discriminating keywords for overlap checks.

    Splits on non-word chars, lowercases, keeps words ≥4 chars (or in
    SHORT_TECH_WORDS) that are neither pure numbers nor in the stop-set.
    """
    if stop_set is None:
        stop_set = KEYWORD_STOP_SET
    words = _WORD_SPLIT_RE.split(("" if text is None else str(text)).lower())
    return [
        w for w in words
        if (len(w) >= 4 or w in SHORT_TECH_WORDS)
        and not _PURE_NUM_RE.match(w)
        and w not in stop_set
    ]


def keywords_overlap(title_words, subject_words):
    """True if ≥1 word from title_words appears in subject_words. An empty array
    on either side is treated as 'no signal' and returns False."""
    s = set(subject_words or [])
    return any(w in s for w in (title_words or []))


# ---------------------------------------------------------------------------
# marker-presence (Guard) + scope audit
# ---------------------------------------------------------------------------

def marker_still_present(issue, grep_output):
    """Does a puzzle marker (todo/inprogress) for the issue still appear in the
    grep output? Returns {"found": bool, "lines": [str]}."""
    rx = re.compile(r"@(?:todo|inprogress)\s+#{}\b".format(issue), re.I)
    lines = [l.strip() for l in ("" if grep_output is None else str(grep_output)).split("\n")]
    lines = [l for l in lines if l]
    matched = [l for l in lines if rx.search(l)]
    return {"found": len(matched) > 0, "lines": matched}


def scope_audit_diff_command(base):
    """Pick the diff the scope audit shows. Prefer merge-base..HEAD (the branch's
    own delta); fall back to the bare origin/main comparison when no merge-base is
    available (offline / detached / unrelated histories)."""
    b = ("" if base is None else str(base)).strip()
    return "git diff --stat {} HEAD".format(b) if b else "git diff --stat origin/main"
