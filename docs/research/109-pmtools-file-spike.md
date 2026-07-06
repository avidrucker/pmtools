# Spike #109 — should pmtools own issue creation (`pmtools file`) to gate creation on requirements?

**Role:** RESEARCH/SPIKE · **Time box:** H: 60m · **Author:** honeydew · **Status:** findings, no implementation.

## Verdict

**Yes — build it, and it is now on the critical path, not a nice-to-have.** A `pmtools file`
command that wraps issue creation and gates it on config-driven pre-flight requirements is
both viable and the right home for the "every ticket carries exactly one `area:*` label"
rule. Two things raise it above ergonomic sugar:

1. **A ruling already assigned this job to pmtools.** The driver ticket — pycats#570 (the
   "enforce one area-label per ticket" decision) — was **closed `wont-do` + `superseded`**.
   The reporter declined a per-repo CI Action and ruled that enforcement is *generic PM
   policy that belongs in pmtools*, parameterized by each repo's valid `area:*` set. A
   downstream pycats "declare areas in config" ticket is **deliberately not filed yet
   because it is blocked on #109 defining the config schema.** So this spike's config-shape
   output is a contract other repos are waiting on.
2. **It structurally fixes the number-minting race (pycats#541).** A single serialized
   `pmtools file` reads the new issue number back from the create response, which prevents
   the concurrent-`gh issue create` race that swaps numbers — a correctness win independent
   of label gating, and arguably the strongest standalone reason to build it.

The one correction to the ticket's own hypothesis: it pre-seeded "both, layered — pmtools
front door + CI backstop." The CI-backstop half **in the consumer repo was explicitly
rejected** in #570. A backstop is still defensible, but only as a *generic, pmtools-owned*
one — never a per-consumer-repo Action. See Area 3.

---

## Area 1 — Command shape & fit

**Fits the lifecycle family cleanly.** The existing surface is a set of thin verbs dispatched
by `bin/pmtools` (`status|claim|preflight|close|release|sweep|error|velocity|ice`), each a
`py/<cmd>.py` + `js/<cmd>.js` faithful-twin pair with a pure `*_core` seam. `file` (alias
`create`) slots in as one more verb — same dispatcher case, same pure/impure split.

**Wrap `gh issue create`, don't hit the API directly.** The provider adapter
(`provider.{js,py}`) already centralizes host-CLI calls and already has the exact pattern
needed: `editIssueBody` shells `gh issue edit <N> --body-file -` (body via stdin). Creation
adds a sibling `createIssue({title, body, labels})` that shells
`gh issue create --title … --body-file - --label … --label …` and parses the returned issue
URL/number back out. This keeps auth, the 5s timeout, and the offline-degrades-to-null
discipline in one place, and keeps GitLab (`glab`) a future adapter swap rather than a rewrite.

**Sketched interface:**

```
pmtools file --title "<t>" --area <a> [--role <r>] [--body-file <f> | --body <s>]
             [--label <l> ...] [--severity <s>] [--dry-run] [--allow-uncategorized]
```

- `--dry-run` runs every gate and prints the resolved `gh issue create` invocation **without
  creating** — mirrors `claim --dry-run` and lets an author preview the gate result.
- `--allow-uncategorized` is the documented escape hatch (parity with claim's
  `--allow-uncategorized`), so the gate is enforce-by-default but never a hard wall.
- Pure seam `fileGateVerdict(opts, config)` returns `{ok, violations:[…]}`; the impure wrapper
  only creates when `ok`, then echoes the **verified** number read from the create response.

## Area 2 — Requirements it could enforce (enumerated + feasibility)

| Requirement | Feasibility | Notes |
| --- | --- | --- |
| **Exactly one `area:*` label** (the driver) | **High — reuse existing seam.** | `claim_core.needs_area_label(labels)` already computes "lacks a real area:* / only area:uncategorized." `file` validates the `--area` value against the config's valid set (Area 4) and rejects zero or ≥2. |
| **A role tag present** (DEV/RESEARCH/…) | **High.** | Validate `--role` against `VALID_ROLES` (already a closed list in `store_core`). Could inject it as a label or a body prefix, per project convention. |
| **Body shape** (yegor `have/should/repro` for bug/dev) | **Medium.** | A pure predicate can check for the required section headers per role. Fuzzy by nature; keep it a `note:`-style soft warning rather than a hard block to avoid false rejects. |
| **`severity:*` only on defects** | **High.** | Pure check: `severity:*` present ⟹ issue is a bug/`type:bug`. Cheap, deterministic. |
| **Title hygiene** (em-dash not colon, no banned words) | **High.** | Reuse the glossary DENIED-word list + a punctuation check. Pure, fixture-gradeable. |
| **Number-minting discipline** (pycats#541) | **Free / structural.** | Not a gate to *add* — it falls out of a single serialized create that reads the number back. Document it as an inherent property, not a toggle. |

**Recommended default set:** hard-gate the two cheap deterministic ones — **one `area:*`** and
**severity-only-on-defects** — plus **role present**; keep **body-shape** and **title-hygiene**
as soft `note:` warnings (enforce-later once they prove low-false-positive). Everything is a
toggle in config (Area 4) so a repo can tighten or loosen per its own rules.

## Area 3 — Soft gate vs hard gate (coverage limits)

A create-command only gates issues filed **through pmtools**; the web UI, raw `gh issue
create`, and the API still bypass it. The ticket pre-seeded "both, layered." That needs one
correction from the #570 ruling:

- **`pmtools file` = the ergonomic front door.** Catches the common (agent) path, gives great
  DX, and independently fixes the minting race. Opt-in / soft by construction.
- **A per-consumer-repo CI Action = rejected.** pycats#570 declined
  `.github/workflows/require-area-label.yml` in the game repo: enforcement is generic PM
  policy and must not leak into a consumer repo. So the "hard backstop" cannot be a
  per-repo Action.
- **A generic backstop is still possible — but as pmtools' own concern.** If a
  catches-every-path gate is wanted, it should ship *from pmtools* (e.g. a reusable workflow
  or a documented `needs:area` triage-label reconciler that any repo installs by reference),
  not be hand-authored per repo. That keeps the rule in one place and the per-repo data
  (valid areas) in config.

**Recommendation:** build `pmtools file` now as the front door; treat a generic pmtools-owned
CI backstop as a **separate, later** decision (it is not blocked on this spike and #570
already removed the per-repo version). Layering is still the end state — just with both
layers owned by pmtools.

## Area 4 — Config surface

**A new top-level `create` block in `.claude/orchestrate.json`**, sibling to
`storage`/`pdd`/`close`/`enrichment`, read through the existing `readOrchestrateBlock` /
`_read_orchestrate_block` plumbing (adding a `load_create_config` twin — same shape as
`load_close_config`). This is the exact separation #570 mandated: **the rule is generic
(pmtools code); the valid area set is per-repo data (config).**

```jsonc
"create": {
  "validAreas": ["lifecycle", "config", "storage", "docs"], // per-repo; [] => any (gate off)
  "requireArea": true,        // exactly one area:<validAreas> label required
  "requireRole": true,        // a VALID_ROLES tag required
  "severityOnlyOnDefects": true,
  "requireBodyShape": false,  // soft note: when true (default off until proven)
  "titleHygiene": true,       // em-dash-not-colon + DENIED-word check → note:
  "uncategorizedFallback": "area:uncategorized" // label applied under --allow-uncategorized
}
```

- **`validAreas` is the contract pycats is waiting on.** Once this schema lands, the deferred
  pycats "declare areas in config" ticket populates its own list here. The valid-area *set*
  is also the same data `pmtools#69` (`labels suggest`) reasons about — see Area 5.
- Defaults must make an **unconfigured repo a no-op** (empty `validAreas` ⟹ area gate off),
  matching the shared-tool rule that a shared harness reads consumer config and never
  hardcodes a consumer's taxonomy. pmtools' own `orchestrate.json` would opt in with its
  real area list.

## Area 5 — Prior art / interplay

- **`pmtools#69` (`labels suggest`)** — complementary, not overlapping. #69 *creates and
  suggests* a project's `area:*` taxonomy (the reproducible-bootstrap + recommend-a-set
  half); #109 *enforces one area per issue at file time*. They share one concept — the
  project's valid `area:*` set — so they should read the **same** config key (`create.validAreas`
  or a shared `areas` list). Worth a cross-note so the two don't invent parallel sources.
- **`area:uncategorized`** — already the soft default lane. `pmtools file` should either apply
  it under `--allow-uncategorized` (explicit "I'll triage later") or refuse without it, mirroring
  claim's existing `--lane-check` / `needs_area_label` behavior. Reuse that seam, don't fork it.
- **`preflight`** — the sibling gate pattern to imitate: a pure predicate + a clear operator
  message naming the fix. `file`'s gate messages should likewise name the exact remedy
  ("add `--area <one-of: …>`").
- **pycats#541 (number-minting discipline)** — `file` is the structural enforcement of the
  "file sequentially, verify the number" rule: one serialized command, number read from the
  response, echoed verified.

---

## Recommended requirement set (the ask)

1. **Exactly one `area:*`** from `create.validAreas` — hard gate (default on when `validAreas`
   non-empty), `--allow-uncategorized` escape hatch.
2. **A role tag** from `VALID_ROLES` — hard gate (default on).
3. **`severity:*` only on defects** — hard gate (default on).
4. **Body shape** per role — soft `note:` (default off until false-positive rate is known).
5. **Title hygiene** — soft `note:` (default on; never blocks).

Plus the free structural property: **serialized creation returns a verified number** (fixes
pycats#541).

## Recommended config shape

The `create` block above — a new `load_create_config` twin over `readOrchestrateBlock`, with
defaults that make an unconfigured repo a no-op.

## Soft-vs-hard-gate recommendation

Ship `pmtools file` as the **enforce-by-default front door** (hard on gates 1–3, soft on 4–5,
all toggleable). Do **not** rebuild the rejected per-repo CI Action; if a
catches-every-path backstop is later wanted, design it as a **generic pmtools-owned** layer
in its own ticket.

## Follow-up (recommended — not filed by this spike)

If greenlit, **file one DEV ticket**: "feat(file): `pmtools file` — gated issue creation
(both ports)", scoped to the recommended set above, with acceptance = the pure `fileGateVerdict`
seam fixture-graded + a `provider.createIssue` twin + CONTRACT `§file` + the `create` config
block. Sequence a small **pycats populate-config** ticket after it (blocked on this schema),
per the #570 deferral. This spike does **not** file either.
