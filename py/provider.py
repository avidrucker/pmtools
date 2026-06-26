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


class GitHubProvider:
    name = "github"

    def issue_states(self, numbers):
        """[{number, state}] for the given issue numbers (best-effort)."""
        rows = []
        for n in numbers:
            out = _run(["gh", "issue", "view", str(n), "--json", "state",
                        "-q", ".state"])
            if out is None:
                continue  # offline / not found -> omit -> UNKNOWN
            state = out.strip().upper()
            if state in ("OPEN", "CLOSED"):
                rows.append({"number": n, "state": state})
        return rows

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
    list_open_issues_with_bodies = edit_issue_body = _stub


def get_provider(host):
    if host == "github":
        return GitHubProvider()
    if host == "gitlab":
        return GitLabProvider()
    raise ValueError(f"unknown host {host!r} (expected 'github' or 'gitlab')")
