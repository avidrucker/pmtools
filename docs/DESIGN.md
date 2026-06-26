# pmtools — Design

> Companion to [`CONTRACT.md`](../CONTRACT.md). `CONTRACT.md` is the per-command
> behavioral spec graded by `fixtures/`; this doc is the higher-level **why +
> shape + roadmap** that consumers (lccjs and future projects) migrate against.
> Authored under avidrucker/pmtools#13; §5 (naming scheme) was decomposed out and
> finalized as part of the #17 landing (#25).

---

## 1. Purpose & scope

`pmtools` is a **stack-agnostic project-management harness** extracted from
lccjs's custom PM scripts. It provides the generic mechanics a multi-agent,
puzzle-driven workflow needs — claim a worktree, preflight an issue, log
velocity/errors, reconcile marker status, close race-safely — behind one
relocatable CLI:

```
pmtools <status|claim|preflight|close|release|error|velocity> [--port py|js] [args...]
```

**Generic-harness principle (load-bearing).** pmtools supplies **mechanism**;
the consumer project supplies **policy** via its own `.claude/orchestrate.json`
and repo conventions. A change that names a *specific* consumer's path, dir, or
filename belongs in the wrong layer — e.g. status's marker scan must read the
*consumer's* `.pddignore` (#15), never hard-code `tests/**/*.spec.js`. When in
doubt, push the project-specific bit into config and keep the tool generic.

**Out of scope (stays consumer-local):** issue *opening*/dedup, ICE scoring,
bug-log curation, and any project-specific report format. pmtools ports only the
generic core; consumers keep their own scripts for the rest (see §7).

## 2. Command surface

| Command | Does | Key side effects | Exit |
|---|---|---|---|
| `status` | Reconcile `@todo`/`@inprogress` markers vs `git worktree list` vs issue state | none (read-only) | 0 |
| `claim` | Stake a worktree+branch for an issue under an agent identity; push a cross-clone claim ref | creates worktree/branch; pushes `refs/claims/issue-N`; optional marker flip | 0 / 1 (blocked) |
| `preflight` | Gather evidence for an issue (git status, worktree list, issue body+comments, prior evidence) + stamp `started_iso` | writes a scratch `preflight-N.iso` | 0 (open) / 1 (closed/absent) |
| `close` | Race-safe land (loop fetch/rebase/push) + gated worktree teardown + claim-ref delete | pushes to `main`; removes worktree/branch; deletes claim ref | 0 / 1 |
| `release` | Abandon a claim + tear down its worktree WITHOUT closing the issue (the cleanup half of `close`) | removes worktree/branch; deletes claim ref; issue stays **OPEN** | 0 / 1 |
| `error` | Validate + insert an error row into the SQLite store (+ optional CSV mirror) | DB write; CSV re-export | 0 / 1 |
| `velocity` | Validate + insert a velocity row (+ optional CSV mirror) | DB write; CSV re-export | 0 / 1 |

Per-command inputs, flags, exit-code semantics, and the pure-vs-impure split are
specified in `CONTRACT.md`; this table is the map, not the territory.

## 3. Port model (js + py twins)

pmtools ships **two language ports** under `js/` and `py/`, kept at **parity**
by a shared fixture corpus (`fixtures/<command>/*.cases.json`): each port's pure
core is graded against the same `{name, args, expected}` cases, and a 1:1
dispatch test asserts every fixture stem maps to exactly one callable. The
canonical behavior change procedure is therefore: **edit `CONTRACT.md` + a
fixture, then make both ports green** (never one port alone).

- **Pure cores** (`*_core.{js,py}`) — no I/O, no `git`, no network; pure
  data-in/data-out. The testable seam.
- **Impure CLIs** (`claim.js`, `close.py`, …) — own `git`/`gh` shelling, file
  I/O, exit codes; thin orchestration over the pure cores.

**Default-port rule (load-bearing).** `bin/pmtools` resolves the port as
`--port` > `$PMTOOLS_PORT` > **`py` (default)**. So the **Python twin is the
load-bearing implementation on PATH** — a bug filed against `js/<x>` may not even
be reached by the default invocation. Always identify the default-on-PATH port
before deciding where a fix lands, and **fix both twins for parity**. This is
exactly what bit #10 (filed against `js/store.js`, but the default `py` path
needed the same fix).

`bin/pmtools` is **self-locating** (resolves its own clone root through symlinks),
so the clone can live anywhere and `pmtools` works from any cwd once on PATH —
no hardcoded paths in any consumer config.

## 4. Storage / `connect()` model

**SQLite is the source of truth.** Two stores — `errors` and `velocity` —
configurable per-project, with CSV mirrors as *derived, regenerated-on-write*
exports (safe to delete, never authoritative). Because they are derived, **CSV
mirrors are never git-tracked** — `.gitignore` excludes them and they are
regenerated on demand via `<store> export`; tracking them created spurious rebase
conflicts on concurrent `close` (the #65 audit's finding C4; ruling R2, #68). The JS port drives the **`sqlite3`
CLI** (Node has no bundled SQLite and better-sqlite3 is not assumed); the Python
port uses stdlib `sqlite3`. Both produce byte-identical rows + CSV (graded by
`fixtures/{error,velocity}/*` + a cross-port parity test).

**`connect()` runs on every store op** and is idempotent (`CREATE TABLE/INDEX IF
NOT EXISTS`) — it self-seeds the schema so no external seed script is required.

**The `uq_velocity_session` hazard (and #10's fix).** The velocity store wants a
partial unique index `uq_velocity_session ON velocity(ticket, agent, started_iso)
WHERE started_iso IS NOT NULL`. But `IF NOT EXISTS` suppresses only "index
already exists" — **not** a uniqueness violation over *pre-existing duplicate*
rows. Since `connect()` runs on every write to *either* store, creating the index
unconditionally against a legacy DB that already holds duplicate sessions would
throw and **abort all logging — errors included**. (This is precisely what blocked
the lccjs migration: avidrucker/lccjs#1457.) **#10's fix:** `connect()` detects
duplicates first; if any exist it **skips the unique index and warns** (logging
continues), and a fresh/clean DB still gets the index + full constraint
enforcement. Hardening a self-seeding connect path means treating index creation
as best-effort over dirty legacy data, never as a precondition for writes.

## 5. Worktree/branch naming scheme

`claim` emits **self-describing** branch and worktree names so that an agent,
its project, its language, and its issue are all readable at a glance from
`git branch` / `git worktree list` across a fleet that shares one machine.
Designed and ratified in avidrucker/lccjs#1460; implemented in #17; the
canonical written convention (forms + regexes) lives in `CONTRACT.md`.

### Forms

```
branch       = br-<agent>/<project>-<lang>-issue-<N>[-<theme>]
worktree dir = <worktreeDir>/wt-<agent>-<project>-<lang>-issue-<N>
```

The `br-`/`wt-` prefix marks the artifact type; `<theme>` is an optional
branch-only slug. `<agent>`, `<project>`, `<lang>` each normalize to a single
`[a-z0-9]` token (the scheme delimiter is `-`).

### Field sourcing (the consumer-owns-policy rule)

`<project>` and `<lang>` come from the consumer's `.claude/orchestrate.json`,
read from the **main checkout** (`mainRoot()` = `git --git-common-dir`'s parent),
never the worktree dir — keying off the worktree basename is the pmtools#26 /
lccjs#1454 trap. `project` = the explicit `"project"` key, else the main-repo
basename; `lang` = `langTag(languages[0])` (a tag map: `javascript`→`js`,
`python`→`py`, `clojure`→`clj`, …). Both fall back to a safe default when
absent, so an unconfigured repo still produces a valid name.

### Back-compatibility — no flag day

Parsing tolerates **both** the new form and the legacy
`<fruit>/issue-<N>[-<slug>]` / `<fruit>-issue-<N>`: in every parse regex the
`br-`/`wt-` prefix and the `<project>-<lang>-` segment are optional, and the
`issue-<N>` token is always present. So in-flight legacy worktrees still
reconcile, claim, and close while new claims adopt the richer name — there is
no migration step and no cutover. The canonical named-group regexes:

```
branch:   ^(?:br-)?(?<agent>[a-z0-9]+(?:-[0-9]+)?)/(?:(?<project>[a-z0-9]+)-(?<lang>[a-z0-9]+)-)?issue-(?<issue>\d+)(?:-(?<theme>.+))?$
worktree: ^(?:wt-)?(?<agent>[a-z0-9]+(?:-[0-9]+)?)-(?:(?<project>[a-z0-9]+)-(?<lang>[a-z0-9]+)-)?issue-(?<issue>\d+)$
```

These are the **canonical, consumer-facing contract** (the form lccjs#1461
mirrors), and pmtools now implements + fixture-grades them (#72): `parseBranchName`
/ `parseWorktreeName` in `claim_core.{js,py}` parse via the exact patterns above
(`CANONICAL_BRANCH_PATTERN` / `CANONICAL_WORKTREE_PATTERN`), graded across both
ports against `fixtures/claim/parse_{branch,worktree}_name.cases.json`. The `-N`
collision-fallback agent (#49) the published regex had omitted is corrected here.
`status`'s `DEFAULT_BRANCH_PATTERN` stays a **deliberate reduced** scan (it only
needs `agent`+`issue`, with `--branch-pattern` for overrides) — a scoped read, no
longer a capability gap. See `CONTRACT.md` §claim (#53 → #72).

### Pure helpers (the testable seam)

Name construction and the branch→worktree-dir bridge are pure functions in
`claim_core.{js,py}`, graded byte-for-byte across both ports against shared
`fixtures/claim/*` cases: `langTag`, `buildBranch`, `buildWorktreeName`,
`branchToWorktreeName` (used by `close` to find a worktree from a branch name,
handling both new and legacy forms), `parseBranchName` / `parseWorktreeName` (the
canonical name parsers — #72), plus the prefix-tolerant
`inferFruitFromBranch` and `worktreesWithIssue`. Construction is exposed so
consumers (lccjs) **call pmtools** rather than re-templating the scheme — keeping
pmtools the single canonical definition. Consumer follow-on: avidrucker/lccjs#1461.

## 6. Configuration

Per-project config lives in the consumer's **`.claude/orchestrate.json`**.
pmtools reads (tolerant of missing file/keys, falling back to defaults):

- **`storage`** — `dbPath` (null ⇒ `~/.pmtools/<repo>/pmtools.db`, `<repo>` =
  git-toplevel basename), and per-store `{enabled, csvMirror, logCommand}` for
  `errors` and `velocity`. **Defaults: errors enabled, velocity opt-in
  (disabled).** A disabled store's `log` refuses with a notice and exits 0 (not
  an error). CSV target precedence: `--no-csv` > `--csv P` > `storage.<store>.csvMirror`;
  `--db-path P` overrides `dbPath`.
- **`pdd`** — `{enabled, ignoreFile}`: gates status's marker scan and points at
  the consumer's ignore file (the generic-harness principle — pmtools reads it,
  never hard-codes it).
- **`enrichment`** — `{statusCommand, clusterFile}`: the status reconciler an
  external ranker (e.g. the puzzle-triage skill) invokes, and the cluster
  soft-lock map (reserved for LOCKED, #80). Both consumer-supplied, default unset.
  Loaded by `config.load_enrichment_config` (#79).
- **Consumer/orchestration keys** — `pmtools.port`, the rest of `enrichment.*`
  (e.g. `claimCommand`/`preflightCommand` a skill invokes), `languages`, and (with
  §5) `project`. These are policy the consumer owns.

pmtools **dogfoods itself**: this repo ships a tracked `.claude/orchestrate.json`
(both stores enabled, with `docs/pmtools-{errors,velocity}.csv` mirror *paths*
configured — the CSV files themselves are gitignored, §4) + a `.pddignore`, so
pmtools development uses pmtools.

## 7. Migration coverage map (lccjs → pmtools)

**Ported (generic core):** `status`, `claim`, `preflight`, `close`, `error`,
`velocity`.

**Stays lccjs-local (no pmtools equivalent — by design, §1):** issue
opening/dedup (`file-issue`, the #1253 guard), ICE scoring (`ice:score`),
bug-log curation (`open_bugs.md`), and any lccjs-specific report format.

**Known fidelity gaps — current as of this writing:**

| Concern | Status |
|---|---|
| status ignores `.pddignore` / non-canonical-grammar marker flood | **Landed** — canonical-grammar + `.pddignore` filtering (#15); toggle via the `pdd` config block (#16) |
| velocity-row guard at close | **Landed** — config-gated, DB-based (#5) |
| `connect()` aborts all logging on a legacy dup'd DB | **Landed** — dedup-gate `uq_velocity_session` (#10); see §4 |
| close omits lccjs's learnings-README / union-file / CSV auto-resolve + parent-tracker scan | **Landed** — all four ported config-gated (#36): velocity-CSV (#313), union-file (#290), markdown-index (#971), parent-tracker (#907); each off by default |
| velocity store does not default `repo` | open (rows land `repo=NULL` unless passed) |
| per-project state (DB path, scratch dir) keys off the *worktree* toplevel, fragmenting across worktrees | **#26** |
| no PR-gated landing path for push-protected `main` (close lands trunk-based, exits 0 on success since #8) | **#27** |

**Signal-after-pull rule (hand-off).** When landing a pmtools change a consumer
depends on, post the "landed + pulled (commit X)" signal **only after** running
`git pull` on the live checkout. Merged-on-GitHub-but-not-pulled means the
consumer is still testing stale code.

## 8. Roadmap / open issues

- **#17 / #25** — self-describing naming scheme (implemented + landed; specified in §5).
- **#13** — this design doc.
- **#20** — `tests/integration.sh` non-hermeticity (leaks commits into the cwd
  branch from a worktree); verify-in-clone until fixed.
- **#26** — worktree-state fragmentation (DB/scratch keyed off worktree toplevel).
- **#27** — PR-gated landing path for push-protected repos.
- **#22** — `pmtools release <N>` (abandon a claim without closing): **implemented + landed** (§2 table; CONTRACT §release).
- **#6 / #9** — docs staleness + close UX (`--as` rejection); the close exit-1-after-`CLOSE OK` signal (#8) is fixed (close exits 0).

Consumers tracking the migration: lccjs#1456 (tracker), #1451 (go/no-go), #1461
(naming adoption), and avidrucker/claude-config#6 (skill defaults).
