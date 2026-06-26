# pmtools spec/schema design audit (#65)

> **Status:** ratified · **Date:** 2026-06-25 · **Author:** agent BANANA (architect pass)
> **Purpose:** validate the pmtools spec surface on its own terms so the
> full-codebase code review (**#35**) reviews code against a *fixed, ratified*
> baseline rather than a moving target. Architect mode: **decisions in writing,
> no implementation code changed.**

This is the durable record of the #65 ratification (mirrored as ticket comments
on #65 and its children #53/#59/#29). Two genuinely-forked decisions (R1, R2)
were ruled by the project owner; the rest follow from the evidence below.

## Method

Full read of the spec surface and the five open spec-question children:

- `CONTRACT.md` — per-command contracts, canonical parse regexes, schema claims.
- `docs/DESIGN.md` — architecture, naming scheme §5, store/connect model, roadmap.
- Store DDL — the **executed** `CREATE TABLE/INDEX` in `js/store.js` + `py/store.py`.
- Implemented `status` branch patterns — `js/status.js:16`, `py/status.py:23`.
- `fixtures/*` inventory (the behavioral spec the pure cores are graded against).
- Children: #53 (naming regexes), #59 (uq key + CSV policy), #47 (DESIGN truing),
  #29 (consumer-schema golden), #31 (claim/close contract test).

## 1. Source of truth, per concern

| Concern | **Source of truth** | Others defer to it |
|---|---|---|
| Per-command behavior (inputs, flags, exit codes, side-effects) | **`CONTRACT.md`**, graded by `fixtures/*.cases.json` | DESIGN §2 table is "the map, not the territory"; README is a summary |
| Behavioral golden cases | **`fixtures/<cmd>/*.cases.json`** | CONTRACT prose describes them |
| Store schema (columns, types, indices) | **executed DDL in `store.{js,py}`** (mirrored verbatim into CONTRACT §storage) | DESIGN §4 is rationale only |
| Naming scheme (branch/worktree forms + parse regexes) | **`CONTRACT.md` §claim canonical regexes — which code must implement+grade** (R1) | DESIGN §5 explicitly defers to CONTRACT |
| Config-key shapes (`storage`/`pdd`/`close` blocks) | **CONTRACT §storage JSONC block** | DESIGN §6 prose must agree |
| Architecture / why / roadmap | **`DESIGN.md`** | — |

**Recommendation:** #47 (the DESIGN truing pass) should fold a short "Source of
truth per concern" subsection into `DESIGN.md` so this matrix lands durably in the
architecture doc, not only in this audit + ticket comments.

## 2. Coherence findings — where the surfaces disagree (each owned by a child)

- **C1 — naming-regex over-specification.** `CONTRACT.md:195-196` + `DESIGN.md:138-139`
  publish named `project`/`lang`/`theme` groups + end-anchor + a separate
  worktree-name parser; the executed pattern (`js/status.js:16` / `py/status.py:23`,
  `^(?:br-)?(?<agent>[a-z0-9]+)/(?:[a-z0-9]+-[a-z0-9]+-)?issue-(?<issue>\d+)`)
  captures only `agent`+`issue` (non-capturing project/lang, no `theme`, no anchor),
  and **no worktree-name regex exists anywhere in the codebase**
  (`branchToWorktreeName` builds the dir via string ops; `close`/`release` locate
  worktrees by path basename + porcelain). → **#53**, ruled **R1**.
- **C2 — DESIGN §7 contradicts CONTRACT §close.** DESIGN §7 still lists
  *"close exits 1 after a successful CLOSE OK"* as a live gap; CONTRACT §close
  (exit codes) + the integration test say close returns **0**. DESIGN §1 synopsis +
  §2 table also omit the shipped `release` command. → **#47** (already scoped).
- **C3 — `repo` column defaulted inconsistently across the two stores.** `errors`
  defaults `repo` to the git-repo basename (CONTRACT §errors validation); `velocity`
  does **not** (`repo TEXT`, no DDL default, no validation default) → rows land
  `repo=NULL`, diverging from lccjs's `repo TEXT DEFAULT 'lccjs'`. → **#29**, ruled **R3**.
- **C4 — CSV mirrors tracked inconsistently.** Both lccjs **and pmtools itself**
  track the velocity CSV but not the errors CSV (this repo: `docs/pmtools-velocity.csv`
  tracked, `docs/pmtools-errors.csv` untracked). DESIGN §4 says mirrors are
  "derived… never authoritative… safe to delete," but **neither doc states a
  *tracking* policy** (and `.gitignore` asserts "CSV mirrors are committed").
  → **#59-B**, ruled **R2**.
- **C5 — `uq_velocity_session` key conflates genuinely-distinct rows.**
  `(ticket, agent, started_iso)` can't distinguish a PM row from a RESEARCH row
  logged at the same start instant (live proof: lccjs#1457 group #700 — a 1-min PM
  row + a 24-min RESEARCH row, same agent/ticket/start). A **schema-design**
  question, not a code bug. → **#59-A**, direction recorded **R4**.

No *uncaptured* coherence gaps were found — every disagreement maps onto an
existing child. (Minor doc nits — README's fixture-convention sentence, the dead
`classifyRebaseConflict` seam — are already inside #47's scope.)

## 3. Correctness rulings — decisions of record

- **R1 (#53) — Raise code to the spec (owner-ruled).** pmtools must *implement and
  fixture-grade* the canonical naming form it publishes: add `fixtures/claim/*`
  cases exercising the named `project`/`lang`/`theme` groups, and add a pure
  worktree-name parser (seam + fixtures) for the canonical worktree regex. `status`
  and consumers then parse via the same tested pattern. Rationale: DESIGN §5 already
  declares pmtools "the single canonical definition" consumers call "rather than
  re-templating the scheme" — a canonical definition that isn't fixture-graded
  isn't canonical, so it drifts silently (this bug). lccjs#1461 then mirrors a
  *tested* pattern.
- **R2 (#59-B) — Gitignore all CSV mirrors, uniformly (owner-ruled).** The DB is the
  source of truth and mirrors are derived/regenerable, so **git-track none of them**
  (velocity, errors, or future); regenerate on demand via `export`. Apply to: lccjs
  (untrack `docs/puzzle-velocity.csv`), **pmtools' own dogfood** (untrack
  `docs/pmtools-velocity.csv`, gitignore `docs/pmtools-*.csv`, and fix the
  `.gitignore` "CSV mirrors are committed" comment), and write the policy into
  DESIGN §4 + CONTRACT §storage CSV semantics. Eliminates the #57 rebase-conflict
  class at the source and makes the two stores consistent. *Side effect to review
  (not under #65):* the ported velocity-CSV auto-resolver (#313 / #36 guard 1)
  becomes dead weight for *tracked* mirrors under this policy — flag, don't remove.
  Implementation child filed and linked to #59.
- **R3 (#29) — `velocity` defaults `repo` to the git-repo basename, same as
  `errors`.** Lock it (matches lccjs `DEFAULT 'lccjs'`); the consumer-compatibility
  golden asserts a non-NULL `repo`. Resolves the one concrete cross-engine
  divergence the lccjs#1452 smoke-test surfaced.

## 4. Open schema decision deferred to its child (not forced here)

- **R4 (#59-A) — `uq_velocity_session` redesign.** Ratified as a **documented
  known-hazard**: the current `(ticket, agent, started_iso)` key is too coarse, and
  the dedup-gated `connect()` (silently skipping the index on a dirty DB) is correct
  *defense* but not a *fix*. Recommended direction (per #59 evidence + owner
  comment), **to be decided on #59, not #65**:
  - (a) widen the key with a discriminator (`role`, or a monotonic session/sequence
    id) so legitimately-distinct same-start rows coexist; and/or
  - (b) move the logger to **UPDATE-the-start-row-on-finish** instead of a second
    INSERT, removing the start-stub dup class at the source.

  #65 records only that the current key is *provisional* and the redesign is owned
  by #59.

## 5. Completeness verdict

Command contracts are **adequately specified** for #35's purposes:

- `close`'s kept-vs-omitted guards are now **written spec**, not just test
  assertions: CONTRACT §close documents all four formerly-omitted guards as ported +
  config-gated (velocity-CSV #313, union-file #290, markdown-index #971,
  parent-tracker #907), each with default + config key. **#31** is the guardrail
  test pinning that they fire when enabled / are off by default (already re-scoped
  by the owner's lccjs#1451-D1 ruling).
- Exit-code semantics (2 = usage, 1 = operational, 0 = success) are uniform and
  per-command enumerated.
- The one genuine completeness gap is the schema-key question (R4), tracked in #59.

## 6. Ratified baseline for #35

#35 may now treat as **fixed truth** and **not re-litigate**:

1. `CONTRACT.md` (graded by `fixtures/`) is the behavioral source of truth; the
   executed `store.{js,py}` DDL is the schema source of truth.
2. The five spec questions above (#53/#59/#29/#47/#31) are *known and owned* — #35
   should review code against the *ratified* spec and flag only **new** drift, not
   re-report these.
3. Rulings R1–R3 define the intended end-state for their concerns; code that doesn't
   yet match them is **tracked drift** (the named child), not a fresh #35 finding.

---

_Cross-refs: #35 (the gated review), #53 / #59 / #29 / #47 / #31 (children),
lccjs#1452 (smoke-test), lccjs#1457 (uq-key live proof), lccjs#1460/#1461 (naming
scheme + consumer adoption), lccjs#1451-D1 (close-guard disposition)._
