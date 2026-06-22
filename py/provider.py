"""Host provider adapter — maps issue operations onto the host CLI.

`github` -> the `gh` CLI (implemented). `gitlab` -> `glab` (stub).
All calls are best-effort: an offline/missing CLI degrades to empty results
(reconcile then reports UNKNOWN) and never raises.
"""
import json
import subprocess


def _run(cmd):
    """Return stdout on success, else None (never raises)."""
    try:
        out = subprocess.run(
            cmd, capture_output=True, text=True, check=True
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

    def list_open_issues(self, limit):
        out = _run(["gh", "issue", "list", "--state", "open",
                    "--limit", str(limit), "--json",
                    "number,title,labels"])
        return json.loads(out) if out else []

    def create_label(self, name, color, description, repo=None):
        cmd = ["gh", "label", "create", name, "--color", color,
               "--description", description, "--force"]
        if repo:
            cmd[2:2] = ["-R", repo]
        return _run(cmd) is not None


class GitLabProvider:
    name = "gitlab"

    def _stub(self, *_args, **_kwargs):
        raise NotImplementedError(
            "gitlab adapter not yet implemented — only host:'github' is supported"
        )

    issue_states = list_open_issues = create_label = _stub


def get_provider(host):
    if host == "github":
        return GitHubProvider()
    if host == "gitlab":
        return GitLabProvider()
    raise ValueError(f"unknown host {host!r} (expected 'github' or 'gitlab')")
