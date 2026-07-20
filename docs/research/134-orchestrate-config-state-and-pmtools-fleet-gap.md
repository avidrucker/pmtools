# #134 — orchestrate.json state across the four repos + pmtools fleet-config gap

**Role:** RESEARCH · **area:** config · **as-of:** 2026-07-19 (agent FIG)
**Feeds:** #129 (canonical-shape decision). **Builds on:** #123 (audit). **Does not** ratify a shape.

Findings doc for #134. Four repos read directly from their `.claude/orchestrate.json`:
`pycats`, `statecharts-py` (both `~/Documents/Study/Python/`), `pmtools`
(`~/Documents/Study/Python/pmtools/`), `lccjs` (`~/Documents/Study/JavaScript/lccjs/`).

## TL;DR

- The #123 key-presence matrix still holds, with **one drift finding**: statecharts-py's legacy
  `claims` block is being removed in an **uncommitted** working-tree edit (claims→ledger migration,
  claude-config#22). The #123 audit read the pre-removal state; both are correct at their timestamps.
- **pmtools is the sole non-fleet repo.** Bringing it to fleet needs ~9 keys added; two of them
  (`roster`, `close.verify` command) are genuine decisions, not mechanical fills.
- **Shape stance (for #129): recommend Option 2 — minimal shared superset.** The real divergences
  split into *accidental gaps* (pmtools) and *intentional differences* (language, close-flavor,
  velocity, `pdd`). Option 2 catches the first while leaving the second legal; Option 1 can't detect
  a missing key; Option 3 forces language-specific keys into repos that don't use them.

---

## Q1 — Current state (re-verified 2026-07-19)

The #123 matrix is accurate as posted. Re-reading the four files confirms every row. The blocks each
repo carries:

| Block / key | pmtools | pycats | statecharts-py | lccjs |
|---|:--:|:--:|:--:|:--:|
| `host` / `languages` / `mode` / `issueLimit` | — | ✓ python | ✓ python | ✓ javascript |
| `roster` | — | ✓ (9) | ✓ (11) | — |
| `worktreeBranchPattern` | — | ✓ | — | — |
| `defaultBase` / `paths.worktreeDir` | — | ✓ | ✓ | — |
| `pmtools.{home,port}` | — | ✓ null/py | ✓ null/py | ✓ ~/code/pmtools /js |
| `close.verify` | — | ✓ ruff | ✓ zero-dep runners | — |
| `close.autoResolve` / `updateParentTrackers` | — | — | — | ✓ |
| `enrichment.statusCommand` | ✓ | ✓ | ✓ | ✓ |
| `enrichment.{claim,preflight,close}Command` | — | ✓ | ✓ | ✓ |
| `advisory` | — | ✓ | ✓ | ✓ |
| `storage.dbPath` | — (default) | ✓ null | ✓ null | ✓ ~/.lccjs |
| `storage.velocity.enabled` | ✓ true | ✓ true | ✓ **false** | ✓ true |
| `storage.{velocity,errors}.logCommand` | — (default) | ✓ | ✓ | ✓ |
| `storage.*.csvMirror` | ✓ set | null | null | ✓ set |
| `pdd` | ✓ | — | — | — |
| `claims` (legacy) | — | — (→ ledger, pycats#739) | **being removed (uncommitted)** | — |

### Drift finding — statecharts-py `claims` block

The #123 audit listed statecharts-py as carrying a legacy `claims` block (prefix `SCP`). The current
working tree has none. Run down:

- Committed state (`9fd8734`, "convert to fleet mode", 2026-07-19 10:22) **kept** the `claims` block.
- The working tree has an **uncommitted** edit deleting the whole block (the SCP prefix,
  `evidenceDir`, `overloadedTerms`, …).
- `.claude/ledger.json` now exists (created 2026-07-19 14:43) and `claims-data/` is populated.

So statecharts-py is **mid claims→ledger migration** (the same move pycats already did in #739; tracked
for verify-claims by claude-config#22). The removal is intentional live WIP — **do not disturb**. The
audit and this doc are both correct at their respective timestamps; the block existed when the audit
ran and is being removed now.

**Implication for #129/#130:** any coherence check must read *committed* config, and cross-repo
config work should expect statecharts-py's `orchestrate.json` to change shape (lose `claims`) shortly.

## Q2 — pmtools fleet-config gap

pmtools carries only `storage`, `pdd`, and `enrichment.statusCommand` — it runs in the schema's
generic/solo default. To run as a fleet repo (dogfooding its own tooling), comparing against the two
Python fleet exemplars (pycats, statecharts-py), it would need to add:

| Key to add | Suggested value for pmtools | Notes |
|---|---|---|
| `host` | `"github"` | Same as all. |
| `languages` | `["python", "javascript"]` | pmtools is **dual-port** — a Python port (`py/`) and a Node port (`js/`), both exercised by `run-tests.sh`. |
| `mode` | `"fleet"` | The switch itself. |
| `issueLimit` | `50` | Matches the other three. |
| `roster` | **decision** | Which agent names work pmtools? Reuse the fruit roster, or a distinct set? |
| `defaultBase` | `"origin/main"` | Same as the Python fleet repos. |
| `paths.worktreeDir` | `".claude/worktrees"` | pmtools already has `.claude/worktrees/` untracked locally. |
| `pmtools.{home,port}` | `{ home: null, port: "py" }` | pmtools *is* the tool; `home: null` = self. `py` is the default port; `js` is selectable via `--port`/`$PMTOOLS_PORT`. |
| `enrichment.{claim,preflight,close}Command` | `pmtools claim` / `preflight` / `close` | statusCommand already present. |
| `close.verify` | **decision** | pmtools's own test gate — command TBD (see below). |
| `storage.{velocity,errors}.logCommand` | `pmtools velocity log` / `pmtools error log` | Currently defaulted; fleet repos set them explicitly. |

**Keep** pmtools's unique `pdd` block. **`worktreeBranchPattern`** is optional even for fleet
(statecharts-py, a fleet repo, omits it) — pmtools can omit it.

### Two open questions before pmtools can go fleet (not mechanical)

1. **Roster** — fleet mode needs a named agent roster. Who works pmtools? (Reuse `APPLE…INCABERRY`,
   or a pmtools-specific set?) Human call.
2. **`close.verify` command** — pycats uses a venv-resolved `ruff` gate; statecharts-py uses zero-dep
   `python3` runners. pmtools's test entrypoint is **`run-tests.sh`** (4 stages: `python3 -m unittest
   discover -s py`, `node --test 'js/*.test.js'`, `bash tests/integration.sh`, `bash
   tests/dispatcher.sh`) — there is **no Makefile**. A `close.verify` block would wrap `run-tests.sh`
   or a subset; note the integration stage spins up temp git remotes and is environment-sensitive, so
   the close gate may want the zero-dep unit stages (py + js), not the full script.

Bringing pmtools to fleet is the **edit** — a downstream DEV ticket, gated on the #129 shape ruling
(so pmtools is filled in to the *ratified* shape, not a guess). This doc scopes it; it doesn't do it.

## Q3 — Canonical-shape stance (recommendation for #129)

Three stances, unchanged from the #129 options:

1. **Optional-with-defaults (status quo).** Every key optional; document the shape, don't force
   convergence. A coherence check can flag an *unknown* key but never a *missing* one — so it can't
   catch the pmtools gap that started this.
2. **Minimal shared superset (recommended).** Name a required-key set every *fleet* repo must carry;
   values still differ per repo. Catches "missing required key"; leaves language + leaf differences
   legal.
3. **Strict parity.** Identical keys/nesting/types everywhere; only leaf values differ. Forces
   JS-only / Python-only / `pdd` keys into repos with no use for them.

**Recommendation: Option 2.** The audit's divergences fall in two buckets:

- *Accidental gaps* — pmtools missing fleet keys. This is the exact thing #134 was opened to fix.
- *Intentional differences* — `languages: javascript` vs `python`; `close.verify` (ruff / zero-dep)
  vs `close.autoResolve` (lccjs markdown-index merges); velocity off in statecharts-py; `pdd`
  pmtools-only.

Option 2 fixes bucket 1 and keeps bucket 2 legal. Option 1 is blind to bucket 1. Option 3 turns
bucket 2 into schema noise.

### The line #129 still has to draw (required vs optional)

Keys **all three current fleet repos share** (candidate "required"): `host`, `languages`, `mode`,
`issueLimit`, `pmtools.port`, `enrichment.{status,claim,preflight,close}Command`,
`storage.{velocity,errors}.{enabled,logCommand}`, `storage.dbPath`, an `advisory` block, and a
`close` block.

Keys **not universally shared** (candidate "optional / conditional"): `roster`, `defaultBase`,
`paths.worktreeDir` (present in the two worktree-flow repos, absent in lccjs),
`worktreeBranchPattern` (pycats only), `pdd` (pmtools only).

**Tension #129 must resolve:** lccjs omits `roster` / worktree keys precisely *because* its close
flow is `close.autoResolve` (markdown-index merges), not worktree-based. So "required keys" may need
to be **conditional on close-flavor** (worktree-verify repos require `roster`+`paths`; autoResolve
repos don't). That is the substance of the #129 decision — this doc frames it, it does not settle it.

## Q4 — What was actually decided today (2026-07-19), faithfully

- **Settled:** #123 was split into #129 (shape) + #130 (coherence check, blocked-by #129); #123
  narrowed to the audit + coordination parent.
- **Steer (not yet ratified):** @avidrucker wants pmtools itself to be fleet-configured.
- **Recommended, not ratified:** shape Option 2 (minimal shared superset).
- **Still open:** the canonical-shape stance (#129); the required-vs-optional line; pmtools's roster
  and `close.verify` command.

## Handoff

- **#129** decides the shape (Option 1/2/3) and the required-vs-optional line, incl. whether "required"
  is conditional on close-flavor. This doc's Q3 is the input.
- **#130** builds the coherence check against whatever #129 ratifies; must read *committed* config
  (see the statecharts-py drift finding).
- **Downstream DEV (unfiled):** bring pmtools to fleet config per the ratified shape — needs the
  roster + `close.verify` answers from Q2.
