# pmtools — Design

> Companion to [`CONTRACT.md`](../CONTRACT.md). `CONTRACT.md` is the per-command
> behavioral spec graded by `fixtures/`; this doc is the higher-level **why +
> shape + roadmap** that consumers (lccjs and future projects) migrate against.
> Authored under avidrucker/pmtools#13. **§5 (naming scheme) is intentionally a
> stub here — it lands with #25**, so the doc never describes an unlanded scheme
> as live.

---

## 1. Purpose & scope

`pmtools` is a **stack-agnostic project-management harness** extracted from
lccjs's custom PM scripts. It provides the generic mechanics a multi-agent,
puzzle-driven workflow needs — claim a worktree, preflight an issue, log
velocity/errors, reconcile marker status, close race-safely — behind one
relocatable CLI:

```
pmtools <status|claim|preflight|close|error|velocity> [--port py|js] [args...]
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
exports (safe to delete, never authoritative). The JS port drives the **`sqlite3`
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

## 5. Worktree/branch naming scheme — **stub (lands with #25)**

The self-describing naming scheme — `br-<agent>/<project>-<lang>-issue-N[-theme]`
branches and `wt-…` worktrees, with back-compatible parse regexes and config-
sourced `project`/`lang` — is **designed and ratified** (avidrucker/lccjs#1460)
and **implemented** (#17) but **not yet landed on `main`**. To avoid documenting
an unlanded scheme as live, **this section is finalized as part of #25** (the #17
landing), where it will specify: the branch/worktree forms, the canonical
named-group parse regexes, the `langTag`/`buildBranch`/`buildWorktreeName`/
`branchToWorktreeName` pure helpers, and the `orchestrate.json` `project` +
`languages[0]` sourcing. Until then: branches are `<fruit>/issue-N[-slug]`,
worktrees `<worktreeDir>/<fruit>-issue-N` (see `CONTRACT.md`).

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
- **Consumer/orchestration keys** — `pmtools.port`, `enrichment.*` (the resolved
  status/claim/preflight/close commands a skill invokes), `languages`, and (with
  §5) `project`. These are policy the consumer owns.

pmtools **dogfoods itself**: this repo ships a tracked `.claude/orchestrate.json`
(both stores enabled, with `docs/pmtools-{errors,velocity}.csv` mirrors) + a
`.pddignore`, so pmtools development uses pmtools.

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
| close omits lccjs's learnings-README / union-file / CSV auto-resolve + parent-tracker scan | **Still omitted** — any rebase conflict is blocking (manual resolve), by design for now |
| velocity store does not default `repo` | open (rows land `repo=NULL` unless passed) |
| per-project state (DB path, scratch dir) keys off the *worktree* toplevel, fragmenting across worktrees | **#26** |
| close exits 1 after a successful `CLOSE OK`; no PR-gated landing path | **#8 / #27** |

**Signal-after-pull rule (hand-off).** When landing a pmtools change a consumer
depends on, post the "landed + pulled (commit X)" signal **only after** running
`git pull` on the live checkout. Merged-on-GitHub-but-not-pulled means the
consumer is still testing stale code.

## 8. Roadmap / open issues

- **#17 / #25** — self-describing naming scheme (implemented; landing + §5 here).
- **#13** — this design doc.
- **#20** — `tests/integration.sh` non-hermeticity (leaks commits into the cwd
  branch from a worktree); verify-in-clone until fixed.
- **#26** — worktree-state fragmentation (DB/scratch keyed off worktree toplevel).
- **#27** — PR-gated landing path for push-protected repos.
- **#22** — `pmtools release <N>` (abandon a claim without closing).
- **#6 / #8 / #9** — docs staleness + close UX (exit-1 signal, `--as` rejection).

Consumers tracking the migration: lccjs#1456 (tracker), #1451 (go/no-go), #1461
(naming adoption), and avidrucker/claude-config#6 (skill defaults).
