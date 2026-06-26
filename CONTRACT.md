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

**Storage CSV mirrors.** The `error`/`velocity` stores' CSV mirrors (`--csv P`, or
the configured `storage.<store>.csvMirror`) are **derived** from the SQLite store
(the source of truth) and are **never git-tracked** — `.gitignore` excludes them
and they regenerate on demand via `<store> export`. Tracking them produced
spurious rebase conflicts on concurrent `close`. (#65 audit finding C4 / ruling R2, #68)

---

## Output conventions (all commands, both ports)

Diagnostics follow one cross-command dialect so a single `grep` catches every
failure (and every warning) across all tiers and both ports (#44):

- **Failure** → a stderr line `[<cmd>] ✗ <message>` (e.g.
  `[error] ✗ usage: …`). Every command's `die()` stamps this, so
  `grep -F '✗'` finds all failures — including the `error` / `velocity` store
  commands, which previously stamped a bare `error:` / `velocity:` that the
  glyph-grep missed.
- **Warning / note** (non-fatal) → a stderr line `[<cmd>] note: <message>`
  (e.g. `[velocity] note: model "x" is new or non-canonical …`). *Residual:*
  `claim` still emits a few `[claim] warn:` and `close`/`release` a
  `[<cmd>] warning:` line on best-effort I/O / teardown paths; migrating those
  to `note:` is a tracked follow-up, not part of this change.
- **Unknown-subcommand render** is byte-identical across ports: the offending
  token is rendered as a **JSON literal** — `got "foo"`, `got null` (JS
  `JSON.stringify`, Python `json.dumps`) — never a language-native repr
  (`got 'foo'` / `got None`). New commands inherit this so the faithful-twin
  parity check (`tests/integration.sh`) stays byte-exact.
- **Usage strings** read `usage: <cmd> …` (the bare command name, no `pmtools`
  prefix), uniformly across commands and ports.

**Exit codes** follow one convention across every command and both ports (#44
thread 3): **2** for a usage/argument error — an unknown/missing subcommand,
unknown flag, missing required argument, or bad-typed positional (detectable from
argv alone, so it matches the dispatcher, which already exits 2); **1** for an
operational failure — the invocation was well-formed but the work failed (bad
data content, validation, world state, I/O); **0** for success. The line is
*structural invocation* (→2) vs *the world said no* (→1): e.g. `error log '{bad'`
is exit 1 (the `log` invocation is valid; the payload content is not), and a
rejected unsafe `--as`/`--branch` value is exit 1 (input validation, not a
malformed command line). Per-command sections below note each command's
operational exit-1 cases.

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

- `grep` rows come from scanning tracked files for **canonical** PDD markers —
  `@(todo|inprogress) #N:<estimate>` (the estimate after the colon is required,
  e.g. `#252:30m`). Estimate-less mentions (`@todo #208`) and incidental prose
  are **not** actionable. Files matched by the repo-root `.pddignore` (gitignore-
  style globs) are skipped. This keeps pmtools generic — a consumer expresses its
  own exclusions (e.g. `tests/**/*.spec.js`, `docs/**`) in **its** `.pddignore`;
  no consumer path is hard-coded. The two pure decisions live in the `status_core`
  seams (`parse_canonical_marker`, `parse_pddignore`, `is_pdd_ignored`), graded
  against `fixtures/status/*`; `status.{js,py}` do the `git grep` + `.pddignore`
  read. Marker scanning is **config-gated** (#16): the `pdd` block of
  orchestrate.json toggles it (`pdd.enabled`, default **true**). When disabled,
  `status` skips the marker scan entirely (worktree + issue reconciliation still
  run); `pdd.ignoreFile` (default `.pddignore`) names the exclude list, and when
  scanning is enabled but the file is absent, `status` warns once to stderr and
  scans everything. See `.pddignore.example` for a starter exclude list.
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

- Exit code `0` always, **except**: an unknown flag (usage error) → `2`;
  `--strict` with ≥1 STALE marker → `1` (an operational result, not a usage error).
- A missing/offline provider degrades to `state: "UNKNOWN"`; never throws.

---

## `preflight` (fleet-only) — ported (py + js)

`preflight <issue> [--scratch-dir <dir>] [--evidence-dir <dir> ...]`

Seeded from lccjs `scripts/preflight.js`, with the two lccjs-specific paths
parameterized:

- scratch timestamps: `<scratchDir>/preflight-<issue>.iso`
  (default `~/.pmtools/<repo>/`, where `<repo>` = basename of the **main
  checkout** — `git --git-common-dir`'s parent, so all worktrees of one repo
  share one scratch dir, #26).
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
branch   = br-<agent>/<project>-<lang>-issue-<N>[-<theme>]
worktree = <worktreeDir>/wt-<agent>-<project>-<lang>-issue-<N>   (worktreeDir relative to main repo root)
```

The name is self-describing: agent, project, language, and issue are all
readable at a glance, with the `br-`/`wt-` prefix marking the artifact type.
`<project>` and `<lang>` come from `.claude/orchestrate.json` (`project` key →
else repo basename, normalized to `[a-z0-9]`; `lang` = `langTag(languages[0])`,
e.g. `javascript`→`js`). `<theme>` is an optional slug, branch-only.

**Back-compat (no flag day):** parsing tolerates BOTH the new form and the
legacy `<fruit>/issue-<N>[-<slug>]` / `<fruit>-issue-<N>` — the `br-`/`wt-`
prefix and the `<project>-<lang>-` segment are optional in every parse regex,
and the `issue-<N>` token is always present, so in-flight legacy worktrees still
claim, reconcile, and close. The canonical regexes:

```
branch:   ^(?:br-)?(?<agent>[a-z0-9]+)/(?:(?<project>[a-z0-9]+)-(?<lang>[a-z0-9]+)-)?issue-(?<issue>\d+)(?:-(?<theme>.+))?$
worktree: ^(?:wt-)?(?<agent>[a-z0-9]+)-(?:(?<project>[a-z0-9]+)-(?<lang>[a-z0-9]+)-)?issue-(?<issue>\d+)$
```

> **Canonical contract vs what pmtools' code implements today (#53).** The two
> regexes above are the **canonical, consumer-facing contract** — the form a
> consumer (lccjs#1461) mirrors to parse a name into
> `{agent, project, lang, issue, theme}`, and the form the construction helpers
> below emit. pmtools' *own* `status` marker-reconciliation scan currently
> implements only the **reduced subset it needs** —
> `^(?:br-)?(?<agent>[a-z0-9]+)/(?:[a-z0-9]+-[a-z0-9]+-)?issue-(?<issue>\d+)`
> (`DEFAULT_BRANCH_PATTERN` in `js/status.js` / `py/status.py`): `agent` and
> `issue` are the only *named* groups, `project`/`lang` are non-capturing, and
> there is no `theme` group or end-anchor. And there is **no worktree-name
> *parser*** in pmtools — the worktree regex is the canonical *form*, not an
> implemented seam: `buildWorktreeName` / `branchToWorktreeName` construct the
> dir via string ops, and `close`/`release` locate a worktree by path basename +
> `git worktree list` porcelain. Consumers mirroring the canonical regexes get
> correct results (the names are self-describing); the gap is purely that pmtools
> does not yet itself implement + fixture-grade the full form. Raising the code
> to do so (named `project`/`lang`/`theme` everywhere + a worktree-name parser +
> fixtures) is tracked in #72.

Pure helpers (graded by `fixtures/claim/*`): `langTag`, `buildBranch`,
`buildWorktreeName`, `branchToWorktreeName` (the branch→worktree-dir bridge that
close uses, handling both forms), plus the prefix-tolerant `inferFruitFromBranch`
and `worktreesWithIssue`. Design + rationale: avidrucker/lccjs#1460.

### Identity precedence (highest first)

`--as <name>` → `CLAUDE_AGENT_NAME` env → branch-inferred (`[br-]<agent>/…issue-N`) →
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

`0` on success (claim or dry-run). A **usage error** (unknown flag, missing/
invalid issue number) → `2`. Any **operational** `die` → `1`: auto identity (no
resolvable agent name), CLOSED, lane-gate block, unresolved base, stale main,
live-worktree, injection-rejected identity (#37), same-issue/cross-clone
collision, or "no candidate succeeded".

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
| `--branch <name>` | current branch | Supply the branch (e.g. `br-<agent>/<project>-<lang>-issue-N`, or legacy `<fruit>/issue-N`) when invoking from the main checkout; `close` chdirs into the worktree dir resolved by `branchToWorktreeName` (new `wt-…` or legacy `<fruit>-issue-N`). |
| `--max N` | `5` | Push-race retry budget (invalid → default). |
| `--dry-run` | off | Print the `WOULD CLOSE` plan, change nothing, exit 0. |
| `--keep` | off | Land the commit but do NOT tear down the worktree/branch. |
| `--no-verify-issue` | off | Skip the post-close `gh issue close` fallback. |
| `--skip-marker-check` | off | Skip the marker-deleted guard. |
| `--skip-keyword-check` | off | Skip the Guard 2 issue-title keyword spot-check. |
| `--skip-scope-audit` | off | Suppress the informational `git diff --stat` scope summary. |
| `--skip-velocity-check` | off | Skip the velocity-row guard (PM/triage closes without a logged session). |
| `--update-trackers` | off | After a successful close, tick the parent tracker's `- [ ] #N` checkbox (also enabled by `close.updateParentTrackers`). #36 guard 3. |
| `--worktree-dir <dir>` | `.claude/worktrees` | **Parameterized** (lccjs hardcoded it). Worktree parent dir, relative to main repo root. |

### Pure seams (`close_core`, graded against `fixtures/close/*`)

`classify_push_error` (`race`/`rejected-other`; race regexes checked first,
unrecognized → `rejected-other`), `should_cleanup` (`onOriginMain === true`
only), `claim_ref_delete_command` + `classify_claim_ref_delete`
(`DELETED`/`ABSENT`/`WARN`, idempotent), `classify_rebase_conflict`
(`none`/`union-only`/`blocking` — `unionFiles` comes from
`close.autoResolve.unionFiles` (default **EMPTY** = off); a conflict confined to
configured union files classifies as `union-only` and auto-resolves via
`merge=union`, #36 guard 2), `body_closes_issue` (GitHub close-keyword matcher),
`extract_keywords` + `keywords_overlap` (+ `KEYWORD_STOP_SET` / `SHORT_TECH_WORDS`),
`marker_still_present`, `scope_audit_diff_command`, `velocity_row_present`
(Check A — any row for the ticket), `velocity_ticket_mismatch` +
`compute_velocity_mismatch` (Guard 1 — closing agent's row must carry this
ticket; a correct-ticket row by any agent passes; concurrent agents' off-ticket
rows never false-block). Conflict-resolver predicates `is_velocity_csv_only_conflict`
(#313) / `is_markdown_index_only_conflict` (#971) + the `resolve_append_only_markdown_conflict`
transform; and the parent-tracker seams `find_parent_trackers` +
`tick_checkbox_for_issue` (#907, single-ref-safe).

### Guard / flow sequence (in `main()` order)

1. `parseArgs`; pre-flight: branch must match `[-/]issue-<N>` AND the given issue;
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

`0` on success (close, recovery clean-close, dry-run, or `--keep`). A **usage
error** (unknown flag, missing/invalid issue number) → `2`. Any **operational**
`die` → `1`: not a worktree branch / wrong issue, missing worktree under
`--branch`, no `Closes #N` commit, blocking rebase conflict, `rejected-other`
push, exhausted `--max` race retries, the on-origin-main gate failing, a missing/
mismatched velocity row (guard enabled), marker still present, or keyword
mismatch.

### Landing model — trunk-based direct push (and gated-repo workaround)

`close` lands **trunk-based**: step 9 pushes the close commit straight to
`origin/main` (`git push origin HEAD:main`), matching lccjs's `npm run close`.
This assumes the agent may push directly to the default branch.

In a repo whose `main` is **push-protected** — GitHub branch protection, a
pre-receive hook, or an agent harness that gates direct pushes — that push is
rejected. `close` classifies it as `rejected-other` and **dies with your work
safe and local** (the worktree is left intact; nothing is torn down). It does
**not** currently open a pull request.

To land in a push-gated repo, drive the PR by hand (the steps `close` would
otherwise automate):

```bash
# from inside the worktree, after committing `Closes #N`:
git push origin HEAD                      # push the branch (not main)
gh pr create --base main --head <branch> --fill
gh pr merge <PR> --rebase --delete-branch
git -C <main-root> checkout main && git -C <main-root> pull --ff-only
```

A first-class `--via-pr` landing path (push → open + merge a PR → reuse the
existing on-origin-main gate + teardown) is tracked as a **possible** enhancement
in #27; it is a superset of the trunk-based model, not required for lccjs parity
(lccjs is itself trunk-based).

### Conflict auto-resolve (config-gated) + still-omitted

The velocity-row guard **is** ported (DB-based + config-gated; see the guard
sequence above and the §close pure seams). Both lccjs rebase-conflict
auto-resolvers are now ported too, each **config-gated and generic** (no consumer
paths baked into the shared harness — the #23 rule):

- **velocity-CSV** (#313, #36 guard 1): a conflict confined to the velocity CSV
  mirror re-exports the full table from SQLite (the source of truth, already
  holding both rows) and continues the rebase — gated by `storage.velocity.csvMirror`.
- **union-file** (#290, #36 guard 2): a conflict confined to consumer-configured
  append-only logs (`close.autoResolve.unionFiles`, default empty) is union-merged
  (`git merge-file --union`, keeping both sides) and continues — **no committed
  `.gitattributes` required**.
- **append-only markdown index** (#971, #36 guard 4): a conflict confined to
  consumer-configured markdown indexes (`close.autoResolve.markdownIndexes`,
  default empty) is resolved by stripping the conflict markers (keep both
  appended rows, collapse an adjacent identical row) and continues — the
  generalized learnings-README resolver. Pure seams `is_markdown_index_only_conflict`
  + `resolve_append_only_markdown_conflict` (fixture-graded, both ports).

Any conflict touching a file outside the three configured sets is still
**blocking** (`classify_rebase_conflict`).

### Parent-tracker auto-check (config-gated, #907 / #36 guard 3)

After a **successful** close, if `close.updateParentTrackers: true` (default
**false**) or `--update-trackers` is passed, `close` scans open issues for an
unchecked checklist box referencing the just-closed child (`- [ ] … #N`) and
flips it to `- [x]`, writing the parent body back via the provider. Pure seams
`find_parent_trackers` + `tick_checkbox_for_issue` (fixture-graded, both ports);
only a box whose **sole** issue ref is the child is ticked — a multi-ref umbrella
line is never prematurely checked. Best-effort: every fetch/parse/write failure
warns and skips; it never blocks or fails the close. Uses the provider's
`list_open_issues_with_bodies` (read) + `edit_issue_body` (the one provider
**write**). With all four guards ported (#313/#290/#971/#907), nothing of the
lccjs close behavior remains omitted — only the lccjs *CSV-diff* parsers
(`extractTicketFromCsvDiff` / `extractRowsFromCsvDiff`), which are
lccjs-velocity-CSV-specific and unneeded.

---

## `release` (fleet-only) — ported (py + js)

`pmtools release <issue> [--force]` — **abandon** a claim and tear down its
worktree **without closing the issue** (a.k.a. "unclaim"). The cleanup half of
`close`, minus land-on-main + provider-close: it frees the claim ref and removes
the worktree, leaving the issue **OPEN** so it is immediately re-claimable. Use
when work is deferred, re-scoped to another ticket, or a mis-scoped commit must
be discarded.

### Flow (in `main()` order)

1. `parseArgs`: a single issue number + optional `--force`.
2. `parseWorktreePorcelain(git worktree list --porcelain)` → `[{path, branch}]`;
   the main checkout is row 0. `findWorktreeForIssue(rows, issue)` matches a
   non-main worktree by branch `/issue-<N>` (digit boundary — `issue-9` ≠
   `issue-99`) or path basename `-issue-<N>`.
3. **No worktree** → free the (possibly orphaned) claim ref and return `0`
   ("nothing to tear down"); the issue is left as-is.
4. **Data-loss guard FIRST** (skipped by `--force`), so a refusal leaves the
   claim + worktree fully intact: `git fetch origin`; compute `ahead`
   (`git rev-list --count origin/main..<branch>`) and `dirty`
   (`git -C <wt> status --porcelain`); `releaseGuardVerdict(ahead, dirty, force)`
   → `unpushed` (die, listing the commits) | `dirty` (die, listing the changes)
   | `ok`.
5. Delete the claim ref `refs/claims/issue-<N>` (reuses `close_core`'s
   `claimRefDeleteCommand` + `classifyClaimRefDelete`; `--no-verify` +
   best-effort + idempotent).
6. Teardown **synchronously** from the main root: `git worktree remove --force
   <wt>` + `git branch -D <branch>` + `git worktree prune`. This reverts any
   uncommitted `@inprogress` flip for free (claim writes it uncommitted in the
   worktree); the issue is never committed/pushed/closed.

### Flags / exit codes

`--force` bypasses the data-loss guard (discard unpushed commits / a dirty tree).
Exit `0` on success or nothing-to-do; a **usage error** (missing issue number,
unknown/extra arg) → `2`; an **operational** guard refusal (unpushed / dirty) → `1`.

### Pure seams (`close_core`, graded against `fixtures/close/*`)

`parse_worktree_porcelain`, `find_worktree_for_issue`, `release_guard_verdict` —
plus the shared `claim_ref_delete_command` / `classify_claim_ref_delete` from
`close`. Host-agnostic: `release` never calls a provider, so github/gitlab work
identically. (Port of lccjs#1437.)

---

## storage (error + velocity stores) — ported (py + js)

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
},
"pdd": {                           // sibling block; gates `status`'s marker scan
  "enabled": true,                 // default true — false skips the PDD scan
  "ignoreFile": ".pddignore"       // gitignore-style exclude list at repo root
},
"close": {                         // sibling block; gates close's auto-resolve + trackers
  "autoResolve": {
    "unionFiles": [],              // append-only logs to union-merge (#36 guard 2)
    "markdownIndexes": []          // append-only markdown indexes to marker-strip
  },                               //   (#36 guard 4); both default empty = off
  "updateParentTrackers": false    // tick parent tracker checkboxes on close (#36 guard 3)
}
```

- `dbPath: null` → `~/.pmtools/<repo>/pmtools.db` (`<repo>` = basename of the
  **main checkout**, not the worktree — so every worktree of one repo logs to one
  DB; same convention as `preflight`'s scratch dir and the `repo` data column, #26).
- `enabled: false` → the store's `log`/`export` refuses with
  `"<store> store disabled for this project"` and **exits 0** (a disabled store is
  not an error). **errors defaults enabled; velocity defaults disabled (opt-in).**
- `csvMirror: "path"` → after each write (and on `export`) the full table is
  re-exported to that path (relative to cwd). `csvMirror: null` → DB only.
- `pdd.enabled` (**default true**) gates only `status`'s marker scan; `false`
  skips it (worktree + issue reconciliation still run). `pdd.ignoreFile` (default
  `.pddignore`) names the exclude list; enabled-but-absent → one-line stderr warn
  + scan everything. Loaded by `config.load_pdd_config` (twin). See `§status` and
  `.pddignore.example`.
- `close.updateParentTrackers` (**default `false`**) — when true (or `close
  --update-trackers`), a successful close ticks the parent tracker issue's
  `- [ ] #N` checkbox for the closed child (#36 guard 3). Loaded by
  `config.load_close_config` (twin). See `§close` parent-tracker auto-check.
- `close.autoResolve.markdownIndexes` (**default `[]`** = off) lists append-only
  markdown index files (repo-relative) that `close` resolves on a confined rebase
  conflict by stripping the conflict markers — keep both appended rows, collapse an
  adjacent identical row (#36 guard 4). Consumer-supplied. Loaded by
  `config.load_close_config` (twin). See `§close` conflict auto-resolve.
- `close.autoResolve.unionFiles` (**default `[]`** = off) lists append-only logs
  (repo-relative paths) that `close` union-merges (`git merge-file --union`, keep
  both sides) when a rebase conflict is confined to them — no committed
  `.gitattributes` needed. Consumer-supplied (the #23 generic rule). Loaded by
  `config.load_close_config` (twin). See `§close` conflict auto-resolve.
- A missing file / missing `storage`/`pdd`/`close` key / partial block all fall
  back to the defaults above.

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
- Exit `0` on success or disabled-store; a **usage error** (missing/unknown
  subcommand, unknown flag, missing payload argument) → `2`; an **operational**
  failure (invalid JSON, payload not an object, validation failure, or DB
  error) → `1`.

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

### Parity (py + js)

`store_core` is pure and language-neutral; its fixtures (`fixtures/error/*`,
`fixtures/velocity/*`) are shared `{name, args, expected}` cases. **Validation-
failure** cases use the convention `{name, args, expected_error: true}` — every
port asserts a raised/thrown error for those (rather than comparing a value). The
JS port (`js/store_core.js` + a sqlite engine driving the **`sqlite3` CLI**, since
better-sqlite3 is not assumed) is **implemented**, graded against these same
fixtures and verified byte-for-byte against the Python port (the cross-port
parity check in `tests/integration.sh`).
