# Audit #118 — planning/spec/meta docs: provenance, SSOT set, freshness stamps

**Role:** RESEARCH · **Author:** honeydew · **Status:** findings, no doc edits (follow-up recommended).
**Scope note:** the filed ticket held `CONTRACT.md` out of scope; per the owner's direction this audit **includes `CONTRACT.md`** and adds a **provenance** column for every doc (origin ticket, who it was made for, the value it provided) so the original need of each doc stays visible.

## Verdict

**Two living single-sources-of-truth already exist and should be named as such — `CONTRACT.md` (what the tool does) and `DESIGN.md` (why it's shaped that way) — with `ROADMAP.md` as the forward-looking companion.** A prior audit (#65, `spec-schema-audit-65.md`) already ruled a "source of truth per concern" matrix; the gaps now are (1) that matrix predates `ROADMAP.md` and `docs/specs/` so it doesn't cover them, (2) its recommended fold-into-DESIGN (#47) never landed, and (3) `DESIGN.md` §8 "Roadmap" now **overlaps** `ROADMAP.md` with no stated owner. Everything else is a **dated historical record** that should say so and stop being mistaken for live guidance.

## Provenance + disposition (every doc)

| Doc | Origin (born · author · why) | Made for | Value it provided | Status | Disposition |
|---|---|---|---|---|---|
| **`CONTRACT.md`** | 2026-06-22 · Avi · repo scaffold | every port (js/py/bb) + consumers | the behavioral SSOT — per-command I/O, exit codes, schema claims, graded by `fixtures/` | **current · SSOT** | **Keep as SSOT #1.** Add a `last-checked` stamp. |
| **`DESIGN.md`** | 2026-06-24 · Avi · #13 (§5 finalized under #17/#25) | consumers migrating (lccjs + future) | the "why + shape" architecture doc | **current · SSOT (partly stale)** | **Keep as SSOT #2**, but §8 Roadmap is superseded (see F1) and the #65 SSOT matrix should land here (F2). |
| **`ROADMAP.md`** | 2026-07-05 · Avi · 0.0.2 planning | planners / next-work pickers | future-features parking lot by theme | **current** | **Keep** as the single future-work home; DESIGN §8 defers to it. Add a `last-checked` stamp. |
| **`README.md`** | 2026-06-22 · Avi · repo scaffold | newcomers | install + one-screen overview; points at CONTRACT as SoT | **current** | **Keep** (supporting summary). Light `last-checked` stamp. |
| **`docs/specs/0.0.2.md`** | 2026-07-05 · Avi · 0.0.2 planning | 0.0.2 implementers | the release delta record (now shipped) | **current · closing to archive** | **Keep as a per-release record.** Once fully post-release, it is a historical record — mark it so. |
| **`docs/spec-schema-audit-65.md`** | 2026-06-25 · agent BANANA · #65 (architect pass) | #35's reviewers (a fixed, ratified baseline) | ruled the SSOT-per-concern matrix + 5 coherence findings (R1–R4) | **historical record** (1 commit, never updated; predates ROADMAP/specs) | **Archive-banner it.** Its matrix is the seed for F2; migrate the matrix into DESIGN, keep this as the ratification record. |
| **`docs/handoffs/handoff-92-…`** | 2026-06-28 · agent APPLE · #92 | whoever claims #92 | execution context for the lifecycle-parity research | **live** (its issue #92 is still OPEN) | **Keep until #92 closes**, then archive-banner. |
| **`docs/learnings/README.md` + 5 TILs** | 2026-06-24 → 06-29 · GRAPE/APPLE/BANANA · #23/#97/… | future agents | dated session retrospectives (non-obvious lessons) | **historical archive by nature** | **Keep as-is** — self-stamping by filename date; do NOT consolidate. |
| **`docs/research/109-…`, `115-…`** | 2026-07-06 / 07-07 · Avi · #109 / #115 | the #111 / #116-#117 implementers | spike + audit findings that scoped build tickets | **historical record** (tied to closed spikes) | **Keep as dated archives** — self-stamping; no consolidation. |

## Key findings

- **F1 — Roadmap has two homes.** `DESIGN.md` §8 "Roadmap / open issues" and `ROADMAP.md` (born later, 2026-07-05) both hold forward-looking work, with no stated owner. #65 already flagged DESIGN §7/§8 as stale (it listed a "close exits 1" gap that CONTRACT + the tests contradict, and omitted the shipped `release` command — coherence finding **C2**, owned by #47, which appears not to have trued this up). **Fix:** `ROADMAP.md` is the single future-work SSOT; shrink DESIGN §8 to a one-line pointer and delete its stale open-issues list.
- **F2 — The #65 SSOT matrix never reached DESIGN and is now outdated.** #65 §1 ruled the source-of-truth per concern *and recommended #47 fold it into `DESIGN.md`* — that fold-in isn't present (grep of DESIGN finds no "source of truth per concern" subsection). The matrix also predates `ROADMAP.md` and `docs/specs/`, so it doesn't assign them. **Fix:** land an updated matrix in DESIGN covering the newer docs (roadmap → `ROADMAP.md`; per-release delta → `docs/specs/<v>.md`).
- **F3 — No living doc carries a freshness signal.** Nothing says "checked and still true on DATE." A reader can't distinguish current-and-verified from untouched-and-rotting. (`spec-schema-audit-65.md` is the only doc with a `> Status/Date/Author` header — a good model.)
- **F4 — Historical records aren't labelled as such.** `spec-schema-audit-65.md` and the closed-spike research docs read like live guidance but are point-in-time records; only the `learnings/` and dated `research/` names hint at it.

## Proposed SSOT set (the "1–2 docs")

- **`CONTRACT.md`** — behavioral SSOT (graded by `fixtures/`). Owns: commands, I/O, exit codes, config-key shapes, schema claims.
- **`DESIGN.md`** — architecture SSOT. Owns: why/shape, the store/connect model, the naming scheme rationale, **and the SSOT-per-concern matrix** (F2).
- **`ROADMAP.md`** — forward companion (future work only). **`docs/specs/<v>.md`** — one per release, closes to a historical record on ship.
- Everything else = **dated historical archives** (research/, learnings/, handoffs/, spec-schema-audit-65).

## Proposed freshness convention

- **Living docs** (`CONTRACT`, `DESIGN`, `ROADMAP`, `README`): a greppable header line right under the title —
  `> last-checked: YYYY-MM-DD` — refreshed whenever the doc is reviewed-and-still-true, and **required** to be re-stamped at each release (the natural cadence). Trigger: on release, or on any substantive edit.
- **Historical records** (`spec-schema-audit-65`, closed-spike `research/*`, `handoffs/*` once their issue closes): a banner instead —
  `> Status: historical record (YYYY-MM-DD) — point-in-time; not maintained. Current truth: <SSOT doc>.`
- **Dated-by-name archives** (`learnings/*`, `research/<n>-*`): no stamp needed — the filename date *is* the stamp.

## Recommended follow-up (one WRITER ticket)

- Add `last-checked` stamps to the 4 living docs; add archive banners to `spec-schema-audit-65.md` and the closed-spike research docs.
- Resolve F1: shrink `DESIGN.md` §8 to a pointer to `ROADMAP.md`; drop its stale open-issues list.
- Resolve F2: fold an updated "source of truth per concern" matrix into `DESIGN.md`, covering `ROADMAP.md` + `docs/specs/`.
- (No behavior/code change; docs only.)

## Termination

Every planning/spec/meta doc (incl. `CONTRACT.md`) is classified with origin, audience, value, status, and disposition; the SSOT set + freshness convention are proposed; the follow-up WRITER ticket scope is recommended. No doc edited here.
