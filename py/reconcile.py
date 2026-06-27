"""Pure `status` reconciliation core. See ../CONTRACT.md for the spec.

`reconcile` joins three language-neutral inputs and derives a marker status
for each puzzle marker, with no I/O — so it is testable without a real repo.
"""

from status_core import is_blocked


def reconcile(grep, worktrees, issues):
    """Join markers + worktrees + issue state into a status report.

    Args:
        grep:      [{file, line, keyword(@todo|@inprogress), issue}]
        worktrees: [{branch, issue, agent}]
        issues:    [{number, state(OPEN|CLOSED), labels}]

    Returns:
        {"markers": [...], "stale": [<markers with status==STALE>]}
    """
    state_by_issue = {row["number"]: row["state"] for row in issues}
    labels_by_issue = {row["number"]: row.get("labels") for row in issues}
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
            # Overlay flag (#78), orthogonal to status: true iff the issue carries
            # the `blocked` label. Missing labels (issue absent / none) -> false.
            "blocked": is_blocked(labels_by_issue.get(issue)),
        })

    stale = [m for m in markers if m["status"] == "STALE"]
    return {"markers": markers, "stale": stale}
