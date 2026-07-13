# Audit #121 — software-waste audit of lccjs, pycats, pmtools

**Role:** RESEARCH · **Author:** claude · **Status:** findings, no implementation (follow-ups below).

## Verdict

**Nine of the ten headline claims in the prior sandbox review are refuted, reframed, or struck.** Four
findings survive: fixes repair fresh work rather than old debt (1.58× enrichment, z=16.9); the
`error_type` taxonomy has no category for agent-judgment errors (two types are in use and undefined);
documentation demonstrably fails to prevent a recurring class (6 agents, 8 days, 2 citing the note
while violating it); and 31% of the open lccjs backlog is gated on a human decision, forming the
oldest items in the queue. Five silent instrumentation defects were found — the worst is that agent
names are case-split across all three databases, retroactively breaking every per-agent grouping ever
run. Five of the nine wastes are reported NOT ASSESSED with the missing field named.

**Date:** 2026-07-13 · **Taxonomy:** Sedano, Ralph & Péraire, *"Software Development Waste,"* ICSE 2017
**Method:** 5 analysts against a frozen, sha256-pinned snapshot; 1 adversarial verifier; every finding a pinned claim
**Snapshot:** `$SCRATCH/muda-T0/` — `lccjs.db` `c549050128e7a1d4…` · `pycats.db` `4c38e0e113fa3afd…` · `pmtools.db` `57b991810826d939…`

> **Grounded Theory does not support statistical generalization.** The authors: *"organizations with
> different development cultures may experience different waste types."* This is **a lens for
> structured noticing, not a scoring rubric.** No waste is scored, totalled, or averaged.

---

## The headline

**Of the ten headline claims in the prior (sandbox) review, nine are refuted, reframed, or struck.**
The tenth survives only in the repository that review barely examined.

That review reasoned over committed CSVs — stale mirrors of databases it could not read. This one
reasoned over the databases, and got four things wrong anyway, in the first twenty minutes, before
any discipline was applied. **Both failures share one mechanism**, diagnosed by the ELDERBERRY
analyst and confirmed by the FIG verifier against all five ledgers:

> Each wrong finding **resolved an ambiguous observation into its most alarming reading**, and never
> ran the sub-minute check that would have disambiguated it. That reading is not chosen at random:
> **an audit that finds waste feels successful; one that finds nothing feels failed.**

The verifier re-ran **23 load-bearing numbers and every one reproduced byte-exactly.** Nobody
fabricated. Three of five analysts nonetheless **attached a causal reading to a number the data
cannot identify** — the same failure, in a more sophisticated register. The bias survives the process
built to catch it.

---

## Findings, ranked by cost

### 1. Rework — fixes repair fresh work, not old debt · Sedano #3

**Observed cause (verbatim):** *"Defects (poor testing strategy; no root-cause analysis on bugs)."*

In lccjs, **88% of the code lines deleted by `fix:` commits were written in the previous 14 days**;
55.9% of them by a `feat:` commit within the same fortnight. pycats: 64% / 40.8%.

**The honest effect size** — because the verifier built the null nobody else did: the base rate of
sub-14-day lines *in the very files those fixes touch* is **55.7%**. So the real result is a
**1.58× enrichment (z = 16.9)**, not "88% of fixes repair new code." The conclusion stands; the bare
number misleads.

**The tension** (name it, or the fix creates the opposite waste): median lead time is **under one
hour**. The project already trades correctness for cycle time, deliberately. **So the lever is a test
at feat-authoring time — NOT a merge gate**, which would only manufacture waiting.

Reverts are near-nil: **1 true revert in 3,235 commits.**

### 2. Extraneous cognitive load — the error taxonomy has no word for the errors actually being made · Sedano #5

**Observed cause (verbatim):** *"Inefficient tools and problematic APIs, libraries, and frameworks."*

The `log-error` skill defines **15 error types, all mechanical** — a command exited nonzero, a hook
blocked, a permission was denied. **There is no type for an agent-judgment error.**

Two types are in active use that the skill never defines:

| Type | Mentions in the skill | Rows in use |
|---|--:|--:|
| `BEHAVIORAL_FAIL` | **0** | 30 (lccjs 19 + pycats 11) |
| `COMPLIANCE_FAIL` | 1 — as a *future* type | 19 |

The vocabulary is being extended by the workers because it was never shipped. The agents diagnosed
this themselves, in their own error notes: *"a judgment/process error, **outside the mechanical
taxonomy**"* · *"behavioral/scope-discipline (not a tool failure) — **OTHER is the only fitting
code**."*

pycats' `OTHER` rate (40/141 = 28.4%, against lccjs's 20/403 = 5.0%) is therefore **~97.5% missing
vocabulary, ~2.5% triage error.** It is not sloppiness.

**Proposed extension** — 6 categories, 38 of 40 rows covered, verified as a clean partition
(disjoint + exhaustive). The 2 leftover singletons were **not** promoted: one example is a coincidence.

| Type | n | Definition |
|---|--:|---|
| `SCOPE_DEVIATION` | 9 | Action taken ≠ action authorized |
| `LANGUAGE_COMPLIANCE` | 9 | Banned word / non-English token in output |
| `UNGROUNDED_ASSERTION` | 8 | Fact asserted from a **proxy** (title, grep, symlink) rather than the source |
| `SILENT_TOOL_NOOP` | 5 | Tool **exited 0** while doing nothing |
| `CODE_DEFECT` | 4 | Ordinary bug, caught by a gate |
| `PROCESS_SKIP` | 3 | Mandated workflow step skipped |

**STRUCK by the verifier:** the analyst's attribution of `OTHER` to the *model* (`opus-4.8`).
`INCABERRY ⟺ gpt-5.0 ⟺ week-1` is a single perfectly-confounded 16-row cell — he ruled out the agent
axis while keeping the model axis, **and they are the same axis.** His refutation of the
"classification decay over time" hypothesis survives; the positive attribution does not.

**`CODE_DEFECT` maps to NO waste, and is reported as such.** All four were caught by the gate built to
catch them. That is the process working.

### 3. Documentation does not fix a recurring class — and this maps to no Sedano cause at all

The banned-word lesson was written to agent memory after error row #29. The class then recurred
**5+ more times, across 6 distinct agents, within 8 days** — and **in two of those rows the agent
cites the memory note while committing the violation.** Meanwhile **three separate agents each
independently hand-rolled the same pre-commit grep**, and each threw it away.

Four banned-word documents exist across the machine. **Zero are enforced.**

**The grep is the fix. It is being reinvented once per session instead of living in a hook.**
Writing a fifth document is the one intervention with direct evidence that it *does not work*.

**This fits neither of Sedano's knowledge-loss causes** (team churn, knowledge silos). Nothing was
lost; nothing was siloed; **every agent had the note.** It is an LLM-era failure mode — *knowing the
rule does not confer the ability to follow it* — and the 2017 paper has no word for it. **Named, not
forced into a bucket.**

→ Filed: `claude-config#18` (research the mechanism, not a fifth document).

### 4. Waiting — the human is the bottleneck · Sedano #7

**Observed cause (verbatim):** *"Missing information, people, or equipment."*

**42 of 135 open lccjs issues (31.1%) are gated on a human decision or an external party — and they
are the oldest items in the queue** (median ~38 days; `waiting-on-external` ~47 days, against a
backlog median of 35.7).

This is the only Sedano waste that survives contact with the data cleanly. The bottleneck is not the
scoring rubric, not backlog hygiene, and not agent throughput. **It is decisions only Avi can make.**

### 5. Instrumentation defects — cross-cutting, and they silently corrupt everything downstream

Every one of these fails **silently**. None raises an error. Each hands back a well-formed,
confident, wrong answer.

| Defect | Consequence |
|---|---|
| **Agent names are case-split** (`cherry` / `CHERRY`) in **all three DBs** | Silently breaks **every** per-agent `GROUP BY` ever run |
| **Mixed UTC offsets** (`-1000` and `-10:00`) in one column | SQLite `date()` returns NULL on `-1000` — **275 of 403 lccjs error rows (68%)** — and `min`/`max`/`avg` skip NULLs wordlessly |
| **`actual_min` > total ticket lifespan on 153/1059 tickets (14.4%)**, max 32.7× | Physically impossible. **Flow efficiency is NOT ASSESSABLE.** |
| **`closed_commit` filled on 63/1493 rows (4%)** | Rework cannot be attributed to a ticket. *Enforce it or delete it — 96%-empty is strictly the worst of the three options, and it is the one in place.* |
| lccjs ICE store **disagrees with its own auto-generated export** | 4 open issues scored in the CSV, absent from the DB |
| `lccjs.errors` contains a foreign `pmtools` row; `velocity` contains `claude-config` rows | Any un-filtered per-repo statistic is contaminated |

Clean positive: **zero ghost tickets.** The join key everyone relied on is sound.

---

## NOT ASSESSED — and why

`muda-analyze` requires that a waste the data cannot reach be reported as NOT ASSESSED with the
missing field named — **never as "no waste found," and never filled with a proxy.** Substituting a
proxy is precisely how the prior review went wrong.

| Waste | Why not assessed | What would fix it |
|---|---|---|
| **6 — Psychological distress** | **PROHIBITED, not missing.** No commit, ticket, or velocity row licenses a claim about a person's stress. Sedano's evidence came from humans saying so in retrospectives. **Add no field.** | Ask the human. |
| **7 — Waiting** (flow efficiency) | `actual_min` exceeds total lifespan on 14.4% of tickets. A field where 14% of rows are physically impossible is not a metric with outliers — it is a metric with an integrity defect, **and that defect is the finding.** | Fix `actual_min`; add `velocity.claimed_iso` (one column, zero new discipline — it rides a command that already runs). |
| **1 — Building the wrong feature** | `stateReason` is never captured — though `gh --json` already offers it. | Add one field to a flag already being passed. |
| **9 — Ineffective communication** | Issue `body` / `comments` never captured. | Same — one flag. |
| Reopen rate | `gh` state is a partition at one instant: open ∩ closed = ∅. Reopens need the timeline API. | Timeline API. |

**A metric that is computable and confounded is worse than one that is missing — because a missing
metric announces itself.** Two analysts independently reached this conclusion; a third nearly
published "catastrophic waiting waste, 75× worse than typical" before catching it.

---

## The prior review's claims — final disposition

| Claim | Verdict |
|---|---|
| Measurement has gone dark | **DEAD.** Logging did not stop; work did — deliberately (owner ruling). |
| Errors corpus unversioned / lost | **DEAD.** Nothing was lost. |
| Velocity silent 11 days | **DEAD.** It runs to 2026-07-05 — four days *past* the last commit. |
| Error taxonomies drifted between repos | **DEAD.** pycats' 16 types are a strict **subset** of lccjs's 17. Produced by reading a `LIMIT 8` as a domain. |
| ICE is ease-driven → manufactures overproduction | **DEAD in lccjs** (Impact dominates: 45.8% of variance; closed-issue join p = 0.96). **MIS-FRAMED in pycats** — all 95 scores were written at one instant and 14/17 closures came after, so that is **the ranking being obeyed**, on 2.7% of throughput. The **"low-impact" half is dead in both.** |
| RESEARCH ~4× / ARC ~3.9× over-padding | **CATEGORY ERROR.** `actual_min` exceeds the hard cap `h_min` on **28 of 1148 rows (2.4%)** — `h_min` is a P97 upper bound doing its job. Grading a P97 bound against the median outcome is like calling a speed limit "over-padded." |
| opus 2.0× vs sonnet 3.3× | **STRUCK.** Unreproducible (actual marginals 2.91 / 4.70), and unanswerable regardless: 602 of 603 sonnet rows sit in weeks 1–2; controlling for role **flips the sign.** |
| `c_min` frequently blank → two fields doing one job | **FALSE PREMISE.** `c_min` is populated on **92.1%** of rows and is **twice as well calibrated** as `h_min` (1.79× vs 3.60×). The proposed fix would have deleted the better field. |
| 277 open issues = months of WIP inventory | **FALSE.** **Zero** open issues in any repo exceed 60 days. Median lead time: lccjs 0.93h, pycats 0.35h. The tracker is an **agent work-log**, not a planning backlog. |
| Handoffs / transportation / inventory / motion | **NOT WASTES.** Handoffs is an explicit empirical **negative result** in the source taxonomy; the rest are manufacturing categories with no support in software. |

**Calibration plateau — half true, and worse than claimed.** It is real (7.50× → 2.86×, disjoint
bootstrap intervals) but sits at **~3×, not ~2×**, and the trend since is **positive (+8.5%/week)** —
drifting *away* from calibration, not flat. And the one improvement coincides exactly with the
sonnet→opus switch: **improvement and model change are the same event. Neither can be credited.**

---

## What to do

1. **A test at feat-authoring time.** Not a merge gate — lead time is already sub-hour, and a gate
   manufactures waiting. This is the single highest-cost waste with a clean lever.
2. **Extend the `error_type` taxonomy** with the six proposed categories, and **define
   `BEHAVIORAL_FAIL` / `COMPLIANCE_FAIL`**, which are in use and undefined.
3. **A hook, not a document** — for banned words, and as a template for every other "recurring class
   that documentation failed to fix." → `claude-config#18`.
4. **Fix the case-split on agent names.** It silently breaks every per-agent analysis, retroactively.
5. **Normalize the UTC offsets**, or every SQL analysis of these stores stays a landmine.
6. **`closed_commit`: enforce or delete.** 96%-empty is the worst of the three options.
7. **Batch the 42 human-gated tickets.** They are the oldest things in the queue and only one person
   can move them.

## Audit ROI — self-assessment, requested and unsoftened

- **pmtools — worth it.** Its product is a defect list for pmtools' own instrumentation, and pmtools
  *is* the instrumentation.
- **lccjs — marginal.** Two real wastes; half the report is "we cannot say."
- **pycats — negative.** Four wastes structurally unreachable. *The audit spent more effort generating
  a false finding about it ("645 commits of lost calibration data") than it would have taken to read
  the commit that refutes it — the disable is in the commit subject line.*

**The most valuable output of this audit was not a metric. It was the NOT-ASSESSED rule**, which
prevented at least three confident, well-cited, wrong numbers from shipping — and the discovery that
the bias which produces them is structural, not accidental.
