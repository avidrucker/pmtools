"""Host provider adapter — maps issue operations onto the host CLI.

`github` -> the `gh` CLI (implemented). `gitlab` -> `glab` (stub).
All calls are best-effort: an offline/missing CLI degrades to empty results
(reconcile then reports UNKNOWN) and never raises.
"""
import json
import re
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


def parse_created_issue_number(out):
    """Pure: parse the new issue NUMBER from `gh issue create`'s stdout — it prints
    the created issue's URL, e.g. `https://github.com/o/r/issues/42`. Reads the last
    non-empty line and takes the `/issues/<N>` segment. None when unparseable /
    offline. (#111)"""
    if out is None:
        return None
    lines = [ln for ln in str(out).strip().split("\n") if ln]
    line = lines[-1] if lines else ""
    m = re.search(r"/issues/(\d+)", line)
    return int(m.group(1)) if m else None


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

    def list_open_issues_with_labels(self, limit):
        """Open issues with title + label names — the `ice --auto` sweep source
        (#102). Returns [{number, title, labels:[name,...]}]. Best-effort: [] offline."""
        out = _run(["gh", "issue", "list", "--state", "open",
                    "--limit", str(limit), "--json", "number,title,labels"])
        if not out:
            return []
        return [{"number": i.get("number"), "title": i.get("title"),
                 "labels": [l.get("name") for l in (i.get("labels") or [])
                            if isinstance(l, dict)]}
                for i in json.loads(out)]

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

    # --- Write-seam born for `ice set-tier` (#112); reused by no-code close and
    #     `pmtools file`. Each returns True on success, False on ANY failure
    #     (offline / missing gh / permission) — fail-soft, never raises. ---

    def add_label(self, number, label):
        """Apply a label (`gh issue edit <N> --add-label <L>`)."""
        try:
            subprocess.run(["gh", "issue", "edit", str(number), "--add-label", str(label)],
                           capture_output=True, text=True, check=True)
            return True
        except Exception:
            return False

    def remove_label(self, number, label):
        """Remove a label (`gh issue edit <N> --remove-label <L>`)."""
        try:
            subprocess.run(["gh", "issue", "edit", str(number), "--remove-label", str(label)],
                           capture_output=True, text=True, check=True)
            return True
        except Exception:
            return False

    def create_comment(self, number, body):
        """Post a comment via stdin (`gh issue comment <N> --body-file -`)."""
        try:
            subprocess.run(["gh", "issue", "comment", str(number), "--body-file", "-"],
                           input=body, text=True, capture_output=True, check=True)
            return True
        except Exception:
            return False

    def close_issue(self, number):
        """Close an issue outright (`gh issue close <N>`). Used by no-code close
        (#113) — a comment-only ticket has no `Closes #N` commit to auto-close it."""
        try:
            subprocess.run(["gh", "issue", "close", str(number)],
                           capture_output=True, text=True, check=True)
            return True
        except Exception:
            return False

    def create_issue(self, title, body, labels):
        """Create an issue (`gh issue create --title T --body-file - --label L …`,
        body via stdin). Returns the new issue NUMBER (int), or None on any failure.
        The serialized create + number read-back structurally prevents the
        concurrent-create number race (pycats#541). Used by `pmtools file` (#111)."""
        args = ["gh", "issue", "create", "--title", str(title), "--body-file", "-"]
        for l in (labels or []):
            args += ["--label", str(l)]
        try:
            out = subprocess.run(args, input=(body or ""), text=True,
                                 capture_output=True, check=True)
            return parse_created_issue_number(out.stdout)
        except Exception:
            return None


class GitLabProvider:
    name = "gitlab"

    def _stub(self, *_args, **_kwargs):
        raise NotImplementedError(
            "gitlab adapter not yet implemented — only host:'github' is supported"
        )

    issue_states = issue_title = _stub
    list_issues_by_label = list_open_issues_with_bodies = edit_issue_body = _stub
    add_label = remove_label = create_comment = close_issue = create_issue = _stub


def get_provider(host):
    if host == "github":
        return GitHubProvider()
    if host == "gitlab":
        return GitLabProvider()
    raise ValueError(f"unknown host {host!r} (expected 'github' or 'gitlab')")
