# pmtools — CLI contract (language-neutral source of truth)

`pmtools` centralizes project-management helpers used by the
`fruit-agent-orchestrate` skill. It has **per-language ports** (`js/`, `py/`,
later `bb/`) that MUST behave identically. This file is the single behavioral
source of truth; `fixtures/` are the golden cases every port is graded against.

**Parity rule:** a behavior change = edit this contract + a fixture, then make
*every* port green. Ports never diverge silently.

## Commands

| Command | Purpose | Tier |
|---|---|---|
| `status [--strict] [--json]` | Reconcile `@todo`/`@inprogress` markers against worktrees + issue state | solo-relevant |
| `claim <issue> [slug] --as <name> [--base <ref>] [--dry-run]` | Stake a worktree under an agent identity | fleet-only |
| `preflight <issue>` | Stamp start time, run start-of-task reads, assert issue OPEN | fleet-only |

Only `status` is specified in full below (the first to be ported to every
language). `claim`/`preflight` are documented when extracted (see §claim/preflight).

---

## `status`

### Inputs (three language-neutral sources)

The CLI gathers these from the live repo; the **pure `reconcile` core** accepts
them directly so it is testable without a real repo.

```
grep:       [ { "file": str, "line": int,
                "keyword": "@todo" | "@inprogress", "issue": int } ]
worktrees:  [ { "branch": str, "issue": int, "agent": str } ]
issues:     [ { "number": int, "state": "OPEN" | "CLOSED" } ]
```

- `grep` rows come from scanning tracked files for `@todo`/`@inprogress` markers
  that reference an issue number (`#<N>`).
- `worktrees` rows come from `git worktree list --porcelain`, with `issue`/`agent`
  parsed from the branch via the caller's `worktreeBranchPattern`.
- `issues` rows come from the host provider adapter (`gh`/`glab`). When the
  provider is offline, `issues` may be empty → affected markers get `state: "UNKNOWN"`.

### Output of `reconcile(grep, worktrees, issues)`

```json
{
  "markers": [
    { "issue": 179, "file": "src/a.py", "line": 42, "keyword": "@todo",
      "state": "OPEN" | "CLOSED" | "UNKNOWN",
      "worktree": "<agent>" | null,
      "status": "IDLE" | "CLAIMED" | "STALE" }
  ],
  "stale": [ /* the subset of markers whose status == "STALE" */ ]
}
```

- `markers` preserves the input `grep` order.
- `state` = the matching issue's state, or `"UNKNOWN"` if the issue is absent from `issues`.
- `worktree` = the `agent` of a live worktree on the marker's issue, else `null`.

### Status derivation (exact)

For each grep marker, in this precedence:

1. **CLAIMED** — a live worktree exists for the marker's issue
   (`worktree != null`). This covers both a `@todo` whose issue is being worked
   and an `@inprogress` with a live worktree.
2. **STALE** — either:
   - the issue `state == "CLOSED"` but the marker still exists, **or**
   - `keyword == "@inprogress"` with **no** live worktree (the human-only
     in-progress convention whose worktree went away).
3. **IDLE** — otherwise (`@todo`, issue OPEN or UNKNOWN, no worktree).

`state == "UNKNOWN"` never by itself makes a marker STALE (offline `gh` must not
manufacture false staleness).

### CLI behavior

```
pmtools status            # human table to stdout
pmtools status --json     # the reconcile object as JSON to stdout
pmtools status --strict   # exit 1 if any marker is STALE (else 0)
```

- Exit code `0` always, **except** `--strict` with ≥1 STALE marker → exit `1`.
- A missing/offline provider degrades to `state: "UNKNOWN"`; never throws.

---

## `preflight` (fleet-only) — ported (JS)

`preflight <issue> [--scratch-dir <dir>] [--evidence-dir <dir> ...]`

Seeded from lccjs `scripts/preflight.js`, with the two lccjs-specific paths
parameterized:

- scratch timestamps: `<scratchDir>/preflight-<issue>.iso`
  (default `~/.pmtools/<repo>/`, where `<repo>` = basename of the git toplevel).
- evidence scan dirs: `<evidenceDirs>` (default `["docs/logs","docs/research"]`).

Steps: (1) stamp `started_iso` to the scratch file; (2) start-of-task reads
(`git status`, `git worktree list`, `gh issue view`); (2.5) surface in-repo
evidence `<dir>/<N>-*` for every referenced `#N` (match anchored to the `<N>-`
basename prefix); (3) assert the issue is OPEN — exit 1 otherwise, warn-and-proceed
when `gh` is offline. Pure functions `preflightIssueGate` / `preflightEvidence`
are unit-tested.

## `claim` (fleet-only) — DEFERRED

`claim` (lccjs `scripts/claim.js`, ~870 lines: agent-identity precedence,
session sentinels, worktree race-safety) is **not yet centralized here**. It is
fleet-only, lccjs already runs it via its `npm run claim` shim, and there is no
second fleet project consuming it. Centralize it (with a fixture-backed spec for
its pure parts) when a second project actually adopts the parallel-worktree
workflow — copying 870 untested lines ahead of a consumer would be cargo. Python
ports of `claim`/`preflight` are likewise deferred until a Python project goes fleet.
