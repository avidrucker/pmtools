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
| `claim <issue> [slug] --as <name> [--base <ref>] [--dry-run] [--lane-check] [--copy-env] [--worktree-dir D] [--roster a,b,c]` | Stake a worktree under an agent identity | fleet-only |
| `preflight <issue>` | Stamp start time, run start-of-task reads, assert issue OPEN | fleet-only |
| `close <issue> [--branch N] [--max N] [--dry-run] [--keep] [--no-verify-issue] [--skip-marker-check] [--skip-keyword-check] [--skip-scope-audit] [--worktree-dir D]` | Land the close commit on `origin/main`, then (and only then) tear down the worktree | fleet-only |
| `error <log\|export> '<json>' [--db-path P] [--csv P\|--no-csv]` | Log an agent error into the SQLite errors store (+ optional derived CSV mirror) | storage |
| `velocity <log\|export> '<json>' [--db-path P] [--csv P\|--no-csv]` | Log a velocity row into the SQLite velocity store (+ optional derived CSV mirror) | storage |

`status` is specified in full below; `claim`, `preflight`, and `close` are
specified in their own sections (all now ported to py + js). See §claim /
§preflight / §close.

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

## `preflight` (fleet-only) — ported (py + js)

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
are unit-tested. Python twin: `py/preflight.py` (reuses `py/preflight_core.py`);
same flags, same steps, graded against the same fixtures as the JS pure core.

## `claim` (fleet-only) — ported (py + js)

`claim <issue> [slug] --as <name> [flags]` stakes a worktree under an agent
identity. Ported from lccjs `scripts/claim.js`; the pure decision seams live in
`claim_core.{py,js}` (graded against `fixtures/claim/*`), the impure
orchestration in `claim.{py,js}`. The two language ports are faithful twins.

### Convention

```
branch   = <fruit>/issue-<N>[-<slug>]
worktree = <worktreeDir>/<fruit>-issue-<N>      (worktreeDir relative to main repo root)
```

### Identity precedence (highest first)

`--as <name>` → `CLAUDE_AGENT_NAME` env → branch-inferred (`<fruit>/issue-N`) →
auto. **Auto (no identity) is a hard error** — agents must be named by the human
orchestrator. A forced identity is a single candidate; auto walks the roster
minus already-taken names, falling back to `<roster[0]>-2` when all are taken.

### Flags

| Flag | Default | Effect |
|---|---|---|
| `--as <name>` | — | Forced agent identity (single candidate). |
| `--base <ref>` | `main` | Base ref for the new worktree. |
| `--dry-run` | off | Print the `WOULD CLAIM` plan, stake nothing, exit 0. |
| `--force` | off | Bypass the CLOSED guard, the live-worktree guard, the same-issue rollback, and the cross-clone block. |
| `--allow-stale-main` | off | Skip the local-`main`-behind-`origin/main` guard. |
| `--custom` | off | Documented opt-in for a non-roster name (name is used + noticed either way). |
| `--worktree-dir <dir>` | `.claude/worktrees` | **Parameterized** (lccjs hardcoded it). Worktree parent dir, relative to main repo root. |
| `--roster a,b,c` | `FRUITS` | **Parameterized.** Comma-separated auto-claim roster. |
| `--lane-check` | **off** | **INVERTED from lccjs.** Lane gate is OFF by default; pass this to *enforce* a real `area:*` label (only then is `shouldBlockUncategorized` consulted). lccjs blocked by default with `--allow-uncategorized` to bypass. |
| `--copy-env` | **off** | **Opt-in** (lccjs always copied). Copy `<root>/.env` into the new worktree. |

### Guard sequence (in `main()` order)

1. `parseArgs` → `resolveIdentity(opts, env, currentBranch)`; **auto → die**.
2. `checkIdentityName` notice (non-roster name warns, never blocks).
3. `readIssue` (one best-effort `gh` round-trip).
4. CLOSED guard: `shouldBlockClaim` (definitive `CLOSED` → die unless `--force`).
5. Lane gate: only when `--lane-check` → `shouldBlockUncategorized` → die if no real `area:*`.
6. Slug derivation (CLI slug, else from issue title).
7. Base-ref resolves (`git rev-parse --verify`) else die.
8. Stale-main guard: `assessBaseStaleness` (unless `--allow-stale-main`).
9. `warnOrphanedWorktrees` + `warnStaleClaimRefs` (warn-only).
10. Live-worktree guard: `findLiveWorktreeForIssue` + `shouldBlockWorktreeGuard` (die unless `--force`/`--dry-run`).
11. Pick candidates; `--dry-run` prints the banner and returns here.
12. Per candidate: `branchExists` check → `git worktree add` → auto same-fruit rollback → same-issue TOCTOU rollback (`findSameIssueCollision`, applies even to `--as`; `--force` bypasses) → cross-clone claim-ref push (`commit-tree` off base tree → push `refs/claims/issue-N` → `classifyClaimPushResult` → `claimPushAction`: `ROLLBACK_DIE` / `WARN_PROCEED` / `PROCEED`) → optional `.env` copy (`--copy-env`) → `createSessionSentinel` in auto mode → `flipMarker` → report `CLAIMED`, return.
13. Final die if no candidate succeeded.

### Exit codes

`0` on success (claim or dry-run); `1` on any `die` (auto identity, CLOSED,
lane-gate block, unresolved base, stale main, live-worktree, same-issue/cross-clone
collision, or "no candidate succeeded").

### Timestamp / pid in the claim message

Feeds `buildClaimMessage` (format fixture-tested). Python uses
`datetime.now(timezone.utc).isoformat()` + `time.monotonic_ns()` + `os.getpid()`;
JS uses `new Date().toISOString()` + `process.hrtime.bigint()` + `process.pid`.

## `close` (fleet-only) — ported (py + js)

`close <issue> [flags]` lands the close commit on `origin/main` and, **only
after** confirming it landed, tears down the worktree. The symmetric mirror of
`claim`. Ported from lccjs `scripts/close.js`; the pure decision seams live in
`close_core.{py,js}` (graded against `fixtures/close/*`), the impure
orchestration in `close.{py,js}`. The two language ports are faithful twins.

**Boundary:** `close` does NOT author the closing commit. The agent commits the
marker deletion + `Closes #N` message FIRST; `close` owns only the racy push +
the gated teardown — so it can never fabricate a close.

### Flags

| Flag | Default | Effect |
|---|---|---|
| `--branch <name>` | current branch | Supply the `<fruit>/issue-N` branch when invoking from the main checkout; `close` then chdirs into `<root>/<worktreeDir>/<fruit>-issue-N`. |
| `--max N` | `5` | Push-race retry budget (invalid → default). |
| `--dry-run` | off | Print the `WOULD CLOSE` plan, change nothing, exit 0. |
| `--keep` | off | Land the commit but do NOT tear down the worktree/branch. |
| `--no-verify-issue` | off | Skip the post-close `gh issue close` fallback. |
| `--skip-marker-check` | off | Skip the marker-deleted guard. |
| `--skip-keyword-check` | off | Skip the Guard 2 issue-title keyword spot-check. |
| `--skip-scope-audit` | off | Suppress the informational `git diff --stat` scope summary. |
| `--skip-velocity-check` | off | Skip the velocity-row guard (PM/triage closes without a logged session). |
| `--worktree-dir <dir>` | `.claude/worktrees` | **Parameterized** (lccjs hardcoded it). Worktree parent dir, relative to main repo root. |

### Pure seams (`close_core`, graded against `fixtures/close/*`)

`classify_push_error` (`race`/`rejected-other`; race regexes checked first,
unrecognized → `rejected-other`), `should_cleanup` (`onOriginMain === true`
only), `claim_ref_delete_command` + `classify_claim_ref_delete`
(`DELETED`/`ABSENT`/`WARN`, idempotent), `classify_rebase_conflict`
(`none`/`union-only`/`blocking` — `unionFiles` defaults **EMPTY** in pmtools, so
any conflict is `blocking`), `body_closes_issue` (GitHub close-keyword matcher),
`extract_keywords` + `keywords_overlap` (+ `KEYWORD_STOP_SET` / `SHORT_TECH_WORDS`),
`marker_still_present`, `scope_audit_diff_command`, `velocity_row_present`
(Check A — any row for the ticket), `velocity_ticket_mismatch` +
`compute_velocity_mismatch` (Guard 1 — closing agent's row must carry this
ticket; a correct-ticket row by any agent passes; concurrent agents' off-ticket
rows never false-block).

### Guard / flow sequence (in `main()` order)

1. `parseArgs`; pre-flight: branch must match `/issue-<N>` AND the given issue;
   with `--branch`, chdir into the worktree.
2. `findClosingCommitSha`: scan `origin/main..HEAD` for a `Closes #N` body.
   Recovery path: if none, fetch + scan `origin/main -100` for an already-pushed
   close; if the issue is non-OPEN, treat as a clean close (delete claim ref,
   sync main, teardown).
3. Scope audit (skippable, **informational**): `git fetch origin main`; diff
   `merge-base..HEAD` (fallback `origin/main`).
4. Velocity-row guard (skippable via `--skip-velocity-check`): **config-gated** —
   no-ops unless `storage.velocity.enabled`. SQLite is the source of truth (reads
   the DB, not the CSV); absent DB → warn + skip (first run / CI). Else
   `velocity_row_present` (Check A): die unless a velocity row exists for the
   ticket; `compute_velocity_mismatch` (Guard 1): when none does and the closing
   agent logged a *different* ticket, die naming the mismatch (the #278
   transposition). Runs before the land loop, so a block never touches origin.
5. Guard 2 keyword check (skippable): closing subject vs `gh` issue title;
   degrades gracefully offline.
6. Marker-deleted guard (skippable): `git grep` for `@todo/@inprogress #N` over
   **all tracked files** (language-agnostic — not just `*.js/*.ts`).
7. No rebase/merge in progress; working tree clean.
8. `--dry-run` → print the `WOULD CLOSE` plan, return.
9. Land loop: up to `--max` rounds of `tryLand()` = fetch → `git rebase
   origin/main` (any conflict → abort + die "resolve manually"; the commit is
   safe/local) → `git push origin HEAD:main`. Exit 0 ⇒ `ok`; else
   `classifyPushError` → retry `race`, abort `rejected-other`.
10. Gate: `git fetch origin main`; `shouldCleanup({onOriginMain})` where
    `onOriginMain` checks `git branch -r --contains <sha>` ⊇ `origin/main`. Not
    on origin/main → die (refuse teardown).
11. `deleteClaimRef` (best-effort, idempotent).
12. Verify-issue (skippable): if `gh issue view N` still OPEN → `gh issue close`.
13. Teardown (unless `--keep`): chdir to main root; `git pull --ff-only origin
    main`; `git worktree remove` + `git branch -D` + `git worktree prune`. Run
    synchronously (no detached-subprocess trick needed; there is no npm getcwd
    bug to dodge), but always chdir to root first.

### Exit codes

`0` on success (close, recovery clean-close, dry-run, or `--keep`). `1` on any
`die`: not a worktree branch / wrong issue, missing worktree under `--branch`,
no `Closes #N` commit, blocking rebase conflict, `rejected-other` push,
exhausted `--max` race retries, the on-origin-main gate failing, a missing/
mismatched velocity row (guard enabled), marker still present, or keyword
mismatch.

### Deferred / omitted (lccjs-specific, intentionally NOT ported)

The velocity-row guard **is** ported (DB-based + config-gated; see the guard
sequence above and the §close pure seams) — what stays omitted is the lccjs
*CSV*-specific machinery: the velocity-CSV diff parsers (`extractTicketFromCsvDiff`
/ `extractRowsFromCsvDiff`) and CSV-conflict auto-resolve, the learnings-README
conflict resolver (`isReadmeLearningsConflict` / `resolveReadmeConflict`),
union-file auto-resolve, and the parent-tracker scan (`scanParentTrackers`).
Consequently `unionFiles` defaults EMPTY and **any** rebase conflict is
`blocking`.

---

## storage (error + velocity stores) — ported (py; js a follow-on)

A configurable SQLite-primary storage layer. **SQLite is the source of truth.**
The CSV mirror is ONLY a derived, shallow full-table dump (atomic temp→rename,
`# AUTO-GENERATED` preamble) — never written to directly; it is regenerated on
every write and on demand via `export`. Two stores ship: **errors** (agent
error log) and **velocity** (per-ticket time tracking). Seeded from lccjs
`scripts/{errors,velocity}-seed.js` + `{error,velocity}-log.js` +
`velocity-export.js`.

Pure seams live in `store_core.{py,…}` (constants, validators, delta derivation,
CSV encoders — graded against `fixtures/{error,velocity}/*`). The impure sqlite
engine is `store.{py,…}`; the per-project config loader is `config.{py,…}`; the
CLIs are `error.{py,…}` / `velocity.{py,…}`.

### Configuration — per-store, per-project (`.claude/orchestrate.json`)

```jsonc
"storage": {
  "dbPath": null,                  // null => ~/.pmtools/<repo>/pmtools.db
  "velocity": { "enabled": false, "csvMirror": null, "logCommand": null },
  "errors":   { "enabled": true,  "csvMirror": null, "logCommand": null }
}
```

- `dbPath: null` → `~/.pmtools/<repo>/pmtools.db` (`<repo>` = basename of the git
  toplevel — the same convention as `preflight`'s scratch dir).
- `enabled: false` → the store's `log`/`export` refuses with
  `"<store> store disabled for this project"` and **exits 0** (a disabled store is
  not an error). **errors defaults enabled; velocity defaults disabled (opt-in).**
- `csvMirror: "path"` → after each write (and on `export`) the full table is
  re-exported to that path (relative to cwd). `csvMirror: null` → DB only.
- A missing file / missing `storage` key / partial per-store block all fall back
  to the defaults above.

### Commands

```
pmtools error    log '<json>' [--db-path P] [--csv P | --no-csv]
pmtools error    export        [--db-path P] [--csv P]
pmtools velocity log '<json>' [--db-path P] [--csv P | --no-csv]
pmtools velocity export        [--db-path P] [--csv P]
```

- `--db-path P` overrides `storage.dbPath`. CSV target precedence: `--no-csv`
  (DB only) > `--csv P` > `storage.<store>.csvMirror`.
- `log` validates the JSON payload via `store_core`, inserts via `store`, then
  exports to the resolved CSV mirror if one is set. `export` re-exports the whole
  table from the DB on demand.
- Exit `0` on success or disabled-store; `1` on missing arg, invalid JSON,
  validation failure, or DB error.

### errors schema (verbatim from lccjs errors-seed.js)

```
errors(
  id INTEGER PK AUTOINCREMENT, occurred_iso TEXT NOT NULL, agent TEXT,
  model TEXT, ticket INTEGER, repo TEXT, error_type TEXT, message TEXT,
  context TEXT, notes TEXT)
indices: (agent, occurred_iso); (error_type); (ticket)
```

**Validation** (`validate_error_row`): required `occurred_iso` (non-empty) +
non-empty `message`; `error_type` ∈ {TOOL_DENIED, HOOK_BLOCK, CLAIM_FAIL,
BASH_FAIL, GIT_FAIL, GIT_STATE, GH_FAIL, GH_INFO, DB_FAIL, FILE_FAIL,
EDIT_PRECOND, SKILL_FAIL, NETWORK_FAIL, VALIDATION_FAIL, COMPLIANCE_FAIL,
BEHAVIORAL_FAIL, OTHER}; `model` matches `^[a-z]+-\d+\.\d+$` (hard reject);
`ticket` a positive int; `context` serialized to compact JSON if an object/array,
and required to *parse* as JSON if a string (guards `json_extract()` queries).
`repo` defaults to the git-repo basename when omitted.

### velocity schema (verbatim from lccjs velocity-seed.js)

```
velocity(
  id INTEGER PK AUTOINCREMENT, ticket INTEGER, title TEXT, role TEXT,
  h_min REAL, c_min REAL, actual_min REAL, delta_h_min REAL, delta_c_min REAL,
  started_iso TEXT, finished_iso TEXT, closed_commit TEXT, notes TEXT,
  agent TEXT, model TEXT, repo TEXT)
index: UNIQUE(ticket, agent, started_iso) WHERE started_iso IS NOT NULL  (partial)
```

**Validation** (`validate_velocity_row`): required `role` ∈ {DEV, TEST, WRITER,
RESEARCH, SPIKE, ARC, PM, COMBO, DATA, CHORE, REVIEW} (closed vocabulary, hard
reject) + `agent`; `ticket` nullable but a positive int when present;
`h_min`/`c_min`/`actual_min` optional non-negative numbers. `delta_h_min` =
`h_min − actual_min` and `delta_c_min` = `c_min − actual_min` are **derived**
(null if either operand is null). `model` is NOTICE-not-reject (a non-canonical
model is recorded with a one-line notice, never rejected — models are open-
growth). When `title` is omitted and a `ticket` is present, the title is fetched
best-effort via `gh issue view <N> --json title -q .title` (falls back to
`#<N> (title unavailable)`).

### CSV mirror semantics (derived, never authoritative)

Fixed column order = the table's column order (the `*_COLS` constants). Line 1 =
`# AUTO-GENERATED by pmtools — do not edit directly. Source: <dbPath>`; line 2 =
the header (`col,col,…`); then one line per row ordered by `id`. RFC-4180 field
encoding: a field containing `,` `"` CR or LF is wrapped in double-quotes with
internal quotes doubled. The write is atomic (temp file → rename), so a crash
mid-write never leaves a partial CSV. **SQLite is the source of truth — the CSV is
a derived mirror, regenerated on write/on-demand and safe to delete.**

### Parity (JS follow-on)

`store_core` is pure and language-neutral; its fixtures (`fixtures/error/*`,
`fixtures/velocity/*`) are shared `{name, args, expected}` cases. **Validation-
failure** cases use the convention `{name, args, expected_error: true}` — every
port asserts a raised/thrown error for those (rather than comparing a value). The
JS port (`js/store_core.js` + a sqlite engine driving the **`sqlite3` CLI**, since
better-sqlite3 is not assumed) is a follow-on graded against these same fixtures.
