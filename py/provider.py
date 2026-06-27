"""Host provider adapter — maps issue operations onto the host CLI.

`github` -> the `gh` CLI (implemented). `gitlab` -> `glab` (stub).
All calls are best-effort: an offline/missing CLI degrades to empty results
(reconcile then reports UNKNOWN) and never raises.
"""
import json
import subprocess


def _run(cmd, timeout=5):
    """Return stdout on success, else None (never raises). A 5s timeout keeps a
    hung `gh` from blocking the caller — parity with js provider's run() (#40)."""
    try:
        out = subprocess.run(
            cmd, capture_output=True, text=True, check=True, timeout=timeout
        )
        return out.stdout
    except Exception:
        return None


def parse_issue_state_row(out, number):
    """Pure: map one `gh issue view --json state,labels,blockedBy` payload (the
    raw stdout string, or None when offline) to a reconcile-ready row, or None
    when the issue is absent / unparseable / not OPEN|CLOSED (-> UNKNOWN).
    `blockedByCount` is the `blockedBy.totalCount` (active blocked-by relation
    count, #87). Mirrors js parseIssueStateRow."""
    if out is None:
        return None
    try:
        data = json.loads(out)
    except (ValueError, TypeError):
        return None
    state = str(data.get("state") or "").upper()
    if state not in ("OPEN", "CLOSED"):
        return None
    labels = [lab.get("name") for lab in (data.get("labels") or [])
              if isinstance(lab, dict)]
    blocked_by = data.get("blockedBy") or {}
    blocked_by_count = blocked_by.get("totalCount") or 0
    return {"number": number, "state": state, "labels": labels,
            "blockedByCount": blocked_by_count}


def parse_issue_list_rows(out):
    """Pure: map a `gh issue list --json number,state,labels` payload (a JSON
    array, or None when offline) to reconcile-ready rows (#88). Drops rows whose
    state is not OPEN|CLOSED. `blockedByCount` defaults to 0 (the list query does
    not fetch the relation; label-discovered rows are blocked via their label).
    Mirrors js parseIssueListRows."""
    if out is None:
        return []
    try:
        data = json.loads(out)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    rows = []
    for item in data:
        state = str((item or {}).get("state") or "").upper()
        if state not in ("OPEN", "CLOSED"):
            continue
        labels = [lab.get("name") for lab in (item.get("labels") or [])
                  if isinstance(lab, dict)]
        rows.append({"number": item.get("number"), "state": state,
                     "labels": labels, "blockedByCount": 0})
    return rows


class GitHubProvider:
    name = "github"

    def issue_states(self, numbers):
        """[{number, state, labels:[<name>...], blockedByCount}] for the given
        issue numbers (best-effort). `labels` + the `blockedBy` relation drive the
        BLOCKED overlay (#78/#87); `blockedBy` rides the same per-issue lookup
        status already makes — one extra json field, no extra gh calls."""
        rows = []
        for n in numbers:
            out = _run(["gh", "issue", "view", str(n), "--json", "state,labels,blockedBy"])
            row = parse_issue_state_row(out, n)
            if row:  # None -> offline / not found / non-OPEN|CLOSED -> UNKNOWN
                rows.append(row)
        return rows

    def list_issues_by_label(self, label):
        """Open issues carrying a given label — the discovery query for
        marker-less blocked rows (#88). One `gh issue list` call regardless of
        count. [] offline."""
        return parse_issue_list_rows(
            _run(["gh", "issue", "list", "--label", str(label), "--state", "open",
                  "--json", "number,state,labels"]))

    def list_open_issues_with_bodies(self, limit):
        """Open issues incl. each issue body — used by the parent-tracker
        scan (#36 guard 3). Best-effort: [] offline."""
        out = _run(["gh", "issue", "list", "--state", "open",
                    "--limit", str(limit), "--json", "number,title,body"])
        return json.loads(out) if out else []

    def edit_issue_body(self, number, body):
        """Write a new issue body via stdin (`gh issue edit <N> --body-file -`).
        Returns True on success, False on any failure (offline / missing gh /
        permission). The only provider WRITE; used by parent-tracker (#36 guard 3)."""
        try:
            subprocess.run(
                ["gh", "issue", "edit", str(number), "--body-file", "-"],
                input=body, text=True, capture_output=True, check=True,
            )
            return True
        except Exception:
            return False

    def issue_title(self, number):
        """Best-effort `gh issue view <N> --json title -q .title`. None on
        failure (offline / missing gh / not found). Mirrors js issueTitle."""
        out = _run(["gh", "issue", "view", str(number), "--json", "title",
                    "-q", ".title"])
        if out is None:
            return None
        t = out.strip()
        return t or None


class GitLabProvider:
    name = "gitlab"

    def _stub(self, *_args, **_kwargs):
        raise NotImplementedError(
            "gitlab adapter not yet implemented — only host:'github' is supported"
        )

    issue_states = issue_title = _stub
    list_issues_by_label = list_open_issues_with_bodies = edit_issue_body = _stub


def get_provider(host):
    if host == "github":
        return GitHubProvider()
    if host == "gitlab":
        return GitLabProvider()
    raise ValueError(f"unknown host {host!r} (expected 'github' or 'gitlab')")
