# Handoff — pmtools#92: document the ticket lifecycle + prove byte-parity with lccjs

- **Issue (full spec + acceptance):** https://github.com/avidrucker/pmtools/issues/92
- **Sibling (the other half):** avidrucker/lccjs#1487 — handoff at lccjs `docs/handoffs/handoff-1487-ticket-lifecycle-parity.md`
- **Written by:** APPLE · **For:** whichever agent claims #92. Read the issue first; this doc is the *execution context*, not the spec (don't duplicate the acceptance list — it's in #92).

## Mission in one line
Produce pmtools' authoritative end-to-end ticket-lifecycle spec (every phase: trigger · inputs · outputs/side-effects · guards · exit codes · ordering), then a reconciliation table proving it matches lccjs's exactly. See #92 for the checklist.

## ⚠ The independence rule IS the deliverable — do not break it
- You author the **pmtools** side only. A **different** agent authors lccjs#1487. **Do NOT read lccjs's docs/code while drafting** — derive pmtools' lifecycle from *pmtools'* own code/scripts. Copying the sibling voids the whole point.
- A **third** agent (or each verifying the other) runs the field-by-field cross-check. The verifier ≠ you, and is named alongside you in the closing comment.
- The ONLY sanctioned difference between repos is the invocation surface (`pmtools <cmd>` vs `npm run <cmd>`). Anything else that differs is a **finding** → file a follow-up ticket; never silently "reconcile" it.

## Your sources — derive the spec from the CODE, not from memory
- `CONTRACT.md` — authoritative command specs. §`claim`, §`preflight`, §`close` (the **guard/flow sequence in `main()` order, steps 1–13**, plus the exit-codes block), §`release`, §`sweep` (#71), §storage.
- `py/close.py` / `js/close.js` — the real close ordering: branch checks → `findClosingCommitSha` → recovery (already-pushed) path → scope audit → velocity-row guard (Guard 1) → keyword guard (Guard 2) → marker-deleted guard → clean-tree/no-rebase → land loop → on-origin-main gate → `deleteClaimRef` → verify-issue → parent-tracker → `finalizeClose` (ff-pull + report + teardown). *Note: `finalizeClose` was just extracted in #76 — it's the shared recovery/normal tail.*
- `py/claim.py` / `js/claim.js` — identity resolution, worktree stake, `refs/claims/*` push, marker flip, stale-claim nag.
- `bin/pmtools` — which subcommands exist (the dispatcher allow-list).
- `.claude/orchestrate.json` — storage/pdd/enrichment config.

## The lifecycle as I ran it ~5× this session (orientation — VERIFY against the code, don't just trust this)
1. **Orchestrate/triage** → assignment (`/fruit-agent-orchestrate`).
2. **Verify issue OPEN** (`gh issue view N`).
3. **Claim** — `pmtools claim N --as <fruit>`: stakes `.claude/worktrees/wt-<fruit>-…issue-N`, pushes `refs/claims/issue-N`, flips `@todo #N`→`@inprogress`. Refuses if local main is behind origin (pull --ff-only first) or the issue is CLOSED (unless `--force`).
4. **Preflight** — `pmtools preflight N` (stamp start time; assert OPEN).
5. **Work** in the worktree (TDD; pure seams graded by `fixtures/<cmd>/*.cases.json`, BOTH py + js ports).
6. **Velocity** — `pmtools velocity log '<json>'` **before** close (close Guard 1 requires the row).
7. **Commit** `Closes #N` in the worktree.
8. **Close** — `pmtools close N --branch <branch>` run from the **MAIN root** (not inside the worktree — avoids the cosmetic getcwd artifact). Lands trunk-based (`push HEAD:main`), then tears down.
9. **Post-close** — comment naming the deliverable.

## Gotchas that will save you time (hit this session)
- **Canonical clone is `~/Documents/Study/Python/pmtools`** — the `pmtools` CLI self-locates there. An older `~/code/pmtools` was removed mid-session; if a path 404s, `readlink -f "$(which pmtools)"`.
- **CSV mirrors** (`docs/pmtools-*.csv`) are gitignored (#68) — never stage them.
- **Marker-guard footgun (#85, OPEN):** the close marker-deleted guard `git grep @todo/@inprogress #N` false-positives on fixture test-data (e.g. `fixtures/claim/apply_marker_flip.cases.json` embeds `#7`; `js/status.test.js` + `py/test_status.py` embed `#42`/`#99`/`#7`). If your ticket number collides, close needs `--skip-marker-check`.
- **Twin-port parity:** every change touches `py/` AND `js/`; a `test_every_fixture_has_a_dispatch_entry` test forces fixture↔function 1:1 per port.
- `run-tests.sh` = py unit + node unit + `tests/integration.sh` + `tests/dispatcher.sh`. Run it before closing.

## Suggested skills
- `yegor-spikes` — this is a bounded research/scope spike; produce the spec, don't over-build.
- `yegor-tickets` — the spec + parity result live in the repo + the closing comment, not chat.
- `next-best-action` (at close) — every divergence found becomes a follow-up ticket.
- `puzzle-velocity` — log the row before closing.

## Done when
#92's acceptance boxes are all checked AND lccjs#1487's are too — they close in **lockstep**, each independently verified by a different agent.
