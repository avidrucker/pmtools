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


# --- injection safety (#37) ------------------------------------------------
# A branch/ref is safe to interpolate into a git command iff it is a non-empty
# string of ref-legal characters only (letters, digits, dot, underscore, slash,
# dash). Every shell metacharacter is rejected. close/release pass `--branch`
# (or a porcelain-parsed branch) through this before any interpolation; the
# arg-array exec migration is defense-in-depth on top. Twin of claim_core's.
# fullmatch (not `$`) so a trailing newline is rejected, matching the JS twin.
SAFE_REF_RE = re.compile(r"[A-Za-z0-9._/-]+")


def is_safe_ref(s):
    return isinstance(s, str) and SAFE_REF_RE.fullmatch(s) is not None


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


def pushed_commit_references_issue(text, issue):
    """True if the commit text REFERENCES #issue (e.g. `(#N)` or a bare `#N`) but
    does NOT carry a close keyword for it — the already-pushed-without-`Closes #N`
    case (#7). False when the text closes the issue (body_closes_issue owns that),
    when #issue is not mentioned at all, or when text is empty/None. The `\\b` after
    the number keeps `#250` from matching issue 25.
    """
    if text is None:
        return False
    s = str(text)
    references = re.search(r"#{}\b".format(issue), s) is not None
    return references and not body_closes_issue(s, issue)


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


# --- velocity-row guard (ported from lccjs scripts/close.js; #5) --------------
# pmtools is DB-only (no velocity-CSV commit), so the I/O wrapper in close.py
# reads the rows from SQLite and feeds these PURE decisions. The guard is
# config-gated upstream (skipped when storage.velocity is disabled).

def velocity_row_present(rows):
    """Check A decision (lccjs #359): does at least one velocity row exist for the
    ticket? Pure: takes the rows the DB returned, returns bool."""
    return isinstance(rows, list) and len(rows) > 0


def velocity_ticket_mismatch(tickets, issue):
    """Guard 1 helper (lccjs #310): which of the given ticket numbers disagree
    with the issue being closed. Empty == consistent. Pure: tickets + issue."""
    n = int(issue)
    # A null ticket is an issueless PM/triage row (#56) — it pertains to no issue,
    # so it is neither a match nor a mismatch; skip it rather than report it.
    return [t for t in (tickets or []) if t is not None and int(t) != n]


def compute_velocity_mismatch(rows, issue, closing_agent):
    """Guard 1 decision (lccjs #361): given the velocity rows {ticket, agent}, the
    issue, and the closing agent, return the mismatching ticket numbers (empty =
    pass). If ANY row records the correct ticket the close is consistent; only
    when none do, filter to the closing agent's own rows to catch a wrong-ticket
    log (#278 transposition) without false-blocking on a concurrent agent's row."""
    n = int(issue)
    all_rows = rows or []
    if any(r["ticket"] is not None and int(r["ticket"]) == n for r in all_rows):
        return []
    if closing_agent is not None:
        mine = [r for r in all_rows
                if str(r["agent"]).lower() == str(closing_agent).lower()]
    else:
        mine = all_rows
    return velocity_ticket_mismatch([r["ticket"] for r in mine], issue)


def is_velocity_csv_only_conflict(paths, csv_mirror):
    """A rebase whose ONLY conflicted path is the velocity CSV mirror is
    auto-resolvable: the mirror is a full-table SQLite export, and the DB (the
    source of truth) already holds both agents' rows, so the conflict resolves by
    re-exporting rather than aborting. Pure: conflicted paths + the configured
    mirror (repo-root-relative). False when the mirror is unset, no paths
    conflicted, or any non-mirror file also conflicted. (#57; lccjs #313)"""
    if not csv_mirror:
        return False
    items = [p for p in (str(x).strip() for x in (paths or [])) if p]
    return len(items) > 0 and all(p == csv_mirror for p in items)


def is_markdown_index_only_conflict(paths, files):
    """A rebase whose ONLY conflicted paths are consumer-configured append-only
    markdown indexes is auto-resolvable: each agent appended a row at the bottom,
    a trivially mergeable conflict (keep both rows). Pure: conflicted paths + the
    configured file list (repo-root-relative). False when the list is empty, no
    paths conflicted, or any non-index file also conflicted. (#36 guard 4 / lccjs #971)"""
    cfg = [f for f in (str(x).strip() for x in (files or [])) if f]
    if not cfg:
        return False
    items = [p for p in (str(x).strip() for x in (paths or [])) if p]
    return len(items) > 0 and all(p in cfg for p in items)


def resolve_append_only_markdown_conflict(text):
    """Resolve an append-only markdown conflict in text: drop git conflict-marker
    lines (keeping both sides' appended rows), then collapse any adjacent
    exact-duplicate non-blank line (two agents appending an identical row, which
    lands adjacent once the `=======` separator is removed). Blank lines are never
    deduped, so document spacing is preserved. The diff3 base marker (|||||||) is
    stripped too; for an append-only file the base section is empty, so the result
    is correct regardless of merge.conflictstyle. Pure text->text. (#36 guard 4 / lccjs #971)"""
    markers = ("<<<<<<<", "|||||||", "=======", ">>>>>>>")
    out = []
    for line in str(text).split("\n"):
        if any(line.startswith(m) for m in markers):
            continue
        if line != "" and out and out[-1] == line:
            continue
        out.append(line)
    return "\n".join(out)


def find_parent_trackers(issues, issue_number):
    """Scan open tracker issues for an UNCHECKED checklist box referencing the
    given child issue. Pure: takes [{number, body}] + issue number (int or
    string), returns [{trackerNumber, line}] (line trimmed) per matched line, in
    document order. (#36 guard 3 / lccjs #907)"""
    pat = re.compile(r"- \[ \].*#" + re.escape(str(issue_number)) + r"\b")
    matches = []
    for iss in (issues or []):
        body = str((iss or {}).get("body") or "")
        for line in body.split("\n"):
            if pat.search(line):
                matches.append({"trackerNumber": iss.get("number"), "line": line.strip()})
    return matches


def tick_checkbox_for_issue(body, issue_number):
    """Tick the checklist box(es) referencing the given child issue in a tracker
    body: flip `- [ ]` -> `- [x]` on a line whose SOLE issue ref is that child (a
    multi-ref line is left alone — never prematurely check an umbrella box). Pure
    text->text; returns the body unchanged when nothing safe matches.
    (#36 guard 3 / lccjs #907)"""
    pat = re.compile(r"- \[ \].*#" + re.escape(str(issue_number)) + r"\b")
    out = []
    for line in str(body or "").split("\n"):
        if not pat.search(line):
            out.append(line)
            continue
        refs = re.findall(r"#\d+", line)
        if len(refs) != 1:
            out.append(line)
            continue
        out.append(line.replace("- [ ]", "- [x]", 1))
    return "\n".join(out)


# --- release-command seams (#22; the cleanup half of close, shared core) ------

def parse_worktree_porcelain(porcelain):
    """Parse `git worktree list --porcelain` into [{path, branch}] (branch short
    name, refs/heads/ stripped; detached entries keep branch None). Pure."""
    rows = []
    cur = None
    for line in str(porcelain or "").split("\n"):
        if line.startswith("worktree "):
            cur = {"path": line[len("worktree "):].strip(), "branch": None}
            rows.append(cur)
        elif line.startswith("branch ") and cur is not None:
            cur["branch"] = line[len("branch "):].strip().replace("refs/heads/", "")
    return rows


def find_worktree_for_issue(rows, issue):
    """The worktree staked for issue N: branch matching `[-/]issue-<N>` (so both
    legacy `<agent>/issue-<N>` and new-scheme `…-issue-<N>` branches match by
    branch, mirroring claim_core.worktrees_with_issue, #51) or path basename
    ending `-issue-<N>`. Skips the main entry (rows[0]). The `(?:[^0-9]|$)`
    boundary keeps `issue-9` from matching `issue-99`. Pure: rows + issue →
    {path, branch} | None."""
    re_branch = re.compile(r"[-/]issue-{}(?:[^0-9]|$)".format(issue))
    re_path = re.compile(r"-issue-{}$".format(issue))
    for r in (rows or [])[1:]:
        base = str(r["path"]).split("/")[-1]
        if (r.get("branch") and re_branch.search(r["branch"])) or re_path.search(base):
            return r
    return None


def release_guard_verdict(ahead, dirty, force):
    """The release data-loss guard decision (#22). ahead = commits on the branch
    not on origin/main; dirty = worktree has uncommitted changes; force = --force.
    Returns 'unpushed' | 'dirty' | 'ok' (ahead checked first). Pure."""
    if force:
        return "ok"
    if int(ahead) > 0:
        return "unpushed"
    if dirty:
        return "dirty"
    return "ok"
