"""Pure `status` reconciliation core. See ../CONTRACT.md for the spec.

`reconcile` joins three language-neutral inputs and derives a marker status
for each puzzle marker, with no I/O — so it is testable without a real repo.
"""

from status_core import is_blocked


def reconcile(grep, worktrees, issues, blocked_issues=None):
    """Join markers + worktrees + issue state into a status report.

    Args:
        grep:      [{file, line, keyword(@todo|@inprogress), issue}]
        worktrees: [{branch, issue, agent}]
        issues:    [{number, state(OPEN|CLOSED), labels}]

    Returns:
        {"markers": [...], "stale": [<markers with status==STALE>]}
    """
    blocked_issues = blocked_issues or []
    state_by_issue = {row["number"]: row["state"] for row in issues}
    labels_by_issue = {row["number"]: row.get("labels") for row in issues}
    blocked_by_count_by_issue = {row["number"]: row.get("blockedByCount") for row in issues}
    agent_by_issue = {row["issue"]: row["agent"] for row in worktrees}

    markers = []
    for m in grep:
        issue = m["issue"]
        state = state_by_issue.get(issue, "UNKNOWN")
        worktree = agent_by_issue.get(issue)  # None if no live worktree

        if worktree is not None:
            # A live worktree exists: distinguish actively-in-progress work
            # (@inprogress) from claimed-but-not-started (@todo). (#77)
            status = "IN-PROGRESS" if m["keyword"] == "@inprogress" else "CLAIMED"
        elif state == "CLOSED" or m["keyword"] == "@inprogress":
            status = "STALE"
        else:
            status = "IDLE"

        markers.append({
            "issue": issue,
            "file": m["file"],
            "line": m["line"],
            "keyword": m["keyword"],
            "state": state,
            "worktree": worktree,
            "status": status,
            # Overlay flag (#78, extended #87), orthogonal to status: true iff the
            # issue carries the `blocked` label OR has an active `blocked-by`
            # relation. Missing labels/count (issue absent) -> false.
            "blocked": is_blocked(labels_by_issue.get(issue), blocked_by_count_by_issue.get(issue) or 0),
        })

    # Marker-less blocked issues (#88): a `blocked` issue with no @todo/@inprogress
    # marker produces no marker row, so it is invisible to triage. Append a
    # synthetic BLOCKED row for each blocked_issue NOT already represented by a
    # marker — after the marker rows (which keep grep order). file/line/keyword are
    # None (no marker site). Generic: the caller supplies the blocked set.
    marker_issues = {m["issue"] for m in grep}
    for b in blocked_issues:
        if b["number"] in marker_issues:
            continue
        markers.append({
            "issue": b["number"],
            "file": None,
            "line": None,
            "keyword": None,
            "state": b["state"],
            "worktree": agent_by_issue.get(b["number"]),
            "status": "BLOCKED",
            "blocked": is_blocked(b.get("labels"), b.get("blockedByCount") or 0),
        })

    stale = [m for m in markers if m["status"] == "STALE"]
    return {"markers": markers, "stale": stale}
