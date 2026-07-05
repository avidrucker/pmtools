# pmtools roadmap

Future features, grouped by theme. This is the parking lot for work **not** in the current
release. The living behavioral contract is [`CONTRACT.md`](CONTRACT.md); per-release specs
live under [`docs/specs/`](docs/specs/).

- **Current release spec:** [`docs/specs/0.0.2.md`](docs/specs/0.0.2.md) — lifecycle
  completeness (`pmtools file`, no-code close, seven cheap fixes).
- **Baseline:** 0.0.1 = today's `main`.

Each item links its tracking issue. Placement here is a *default*, not a commitment — a
future release spec pulls items up when they're ready.

## New surfaces (build effort, no correctness pressure)

- **#69 — `pmtools labels suggest`.** Recommend & audit a project's label taxonomy (shared
  labels + project-local `area:*`). Becomes the taxonomy source for `pmtools file`'s
  area gate once it lands (until then `file` carries its own `areas:` config list).
- **#42 — batch `gh` lookups.** Replace N serial `gh issue view` calls in `status`/`claim`
  with one `gh issue list` (or a GraphQL call), keeping the per-issue loop as an offline
  fallback. Performance; both twins. (Child of the #35 audit.)

## Research-first (investigate before building)

- **#85 — close marker-guard false-positives on fixture data.** The marker-deleted guard
  `git grep`s all tracked files, so fixture test-data mentioning `@todo #N` collides with a
  live marker for issue N. Has a `--skip-marker-check` workaround; needs a repro + a rule
  (exclude fixtures? scope the scan?).
- **#59 — velocity dedup / `uq_velocity_session`.** Duplicate `(ticket, agent, started_iso)`
  rows block the unique index from ever being created. Decide whether the dups are
  legitimate and whether that tuple is the right uniqueness key.
- **#96 — TRIAGE/QA velocity role.** Decide *with data* whether the closed role vocabulary
  needs a role for ticket-readiness review / backlog triage / decision facilitation.
  Explicitly gated on having enough logged data. Related to #95 (role glosses, in 0.0.2).
- **#98 — audit pmtools vs `yegor-pm` guidance.** Where does the tool support, only
  partially support, or conflict with the project-management guidance agents follow?
- **#92 — document the end-to-end ticket lifecycle + prove byte-parity with lccjs.** A
  single authoritative lifecycle description for each repo, independently authored and
  cross-verified to be identical.

## Hardening (tests, quality)

- **#29 — consumer-compatibility golden.** A committed golden (exact rows + CSV bytes)
  against the lccjs-equivalent schema, so the storage layer can't silently drift on
  schema/encoding across engines (`sqlite3` CLI vs `better-sqlite3`).
- **#35 — full-codebase quality/modularity/performance/parity audit.** Umbrella; sweeps the
  grown surface and files findings as child tickets (e.g. #42). Ongoing rather than a single
  shippable unit.

## Status / triage

- **#75 — uniform puzzle-triage across projects (status-overlay epic).** Umbrella for
  #77–#80; most children landed. Remaining: **#80 (LOCKED cluster soft-lock)** is
  deliberately deferred — the contract is fixed but there are no consumers yet.

## Docs / cross-harness

- **#91 — Codex agents read `.claude/orchestrate.json`.** Document the pmtools/Codex
  workflow as a first-class path: which fields a Codex agent should honor (mode, roster,
  worktree path, command names, storage, port).

## Superseded / drop

- **#58 — pmtools-claim + npm-close mismatch (research).** Root cause is understood; the
  actionable fix is **#63** (in 0.0.2). Close #58 as superseded, or keep it only as #63's
  rationale doc.
