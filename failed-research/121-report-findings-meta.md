# Meta-audit #121 — every claim in the audit's own summary, screened

**Role:** RESEARCH · **Author:** claude · **Status:** findings. Companion to `121-muda-waste-audit-2026-07-13.md`.

## Verdict

**A 30% failure rate in the audit's own summary.** Of 40 assertions made to the human in the closing
summary of the waste audit, **20 are verified**, **8 were asserted and verified by the same agent**
(which the project's own `verify-claims` gate forbids), and **12 fail the admission screen outright** —
they are rankings, superlatives, causal readings, and claims about motive, presented in the same
register as the numbers.

**The failures are not in the numbers. They are in the frame around the numbers.** Every fabrication
check passed; every interpretation check did not. That is the finding.

**Run `./121-verify.sh` before believing anything in either document.** 19 checks, PASS/FAIL, no
interpretation.

---

## Table 1 — VERIFIED (20)

Pinned evidence, and a verifier who was not the asserter.

| # | Claim | Source · verifier |
|---|---|---|
| 1 | lccjs `fix:`-deleted lines are **1.58× enriched** for being <14 days old (z=16.9), against a 55.7% base rate | DRAGONFRUIT · FIG built the null |
| 2 | Median lead time: lccjs **0.93h**, pycats 0.35h, pmtools 5.66h | DRAGONFRUIT · FIG |
| 3 | 1 true revert in 3,235 commits | DRAGONFRUIT |
| 4 | `log-error` defines **15 types, all mechanical**; none for agent judgment | APPLE · FIG re-read the skill |
| 5 | `BEHAVIORAL_FAIL`: **0 mentions in the skill, 30 rows in use** | APPLE · FIG |
| 6 | Six proposed error categories cover 38/40 rows; **verified disjoint + exhaustive** | APPLE (mechanical) |
| 7 | Banned-word class recurred **5+ times, 6 agents, 8 days**; 2 rows cite the note while violating it | APPLE · FIG |
| 8 | Mixed UTC offsets; SQLite `date()` NULLs **275/403** lccjs error rows | 3 independent |
| 9 | `actual_min` > total ticket lifespan on a large minority of tickets | **4 independent** — see the caveat below |
| 10 | Flow efficiency **NOT ASSESSABLE**; the filtered 13.6% reverses at a 4h cutoff | FIG adjudicated |
| 11 | `closed_commit` filled on **63/1493 (4%)** | ELDERBERRY |
| 12 | Impact dominates lccjs ICE variance (45.8%); closed-issue join **p=0.96** | BANANA · FIG |
| 13 | Only **79/1448 (5.5%)** closed lccjs issues carry an ICE score | BANANA · FIG |
| 14 | pycats: all 95 ICE scores written **at one instant**; 14/17 closures after; CSV has `ice_rank` | FIG |
| 15 | Zero open issues >60 days old, in any repo | BANANA · DRAGONFRUIT |
| 16 | `actual_min` exceeds `h_min` on **28/1148 (2.4%)** — `h_min` is a working P97 bound | CHERRY · FIG |
| 17 | `c_min` populated on **92.1%**, twice as well calibrated as `h_min` | CHERRY |
| 18 | 602/603 sonnet rows in weeks 1–2; controlling for role **flips the sign** | CHERRY |
| 19 | 23/23 load-bearing numbers reproduced under re-run | FIG — **but see the caveat below** |
| 20 | Sedano's cause strings, quoted verbatim from Table III | the paper |

### The caveat that undermines #19, and partly #9

**Re-running someone's command is not verification.** It reproduces their arithmetic, not their claim.

An **independent reimplementation** of #9 — written from the claim's English rather than from the
analysts' SQL — returns **151/1133**, where the analysts reported **153/1059**. The **defect
reproduces**; the **exact count does not**. They appear to deduplicate by ticket; the reimplementation
counts rows.

So the honest form is: *"active time exceeds ticket lifespan on >10% of joined tickets"* — which is
robust, and damning, and sufficient. **`153/1059` must not be quoted as a fact about the world.** It
is a fact about one implementation.

**FIG's "23 of 23 reproduced byte-exactly" therefore means less than it sounds like.** It establishes
that nobody fabricated. It does **not** establish that the numbers are right. Those are different
claims, and the audit's summary conflated them.

---

## Table 2 — SINGLE-AGENT (8)

Asserted and verified by the same agent. **The project's own gate forbids citing these**, and the
audit's summary cited them anyway.

| # | Claim | The problem |
|---|---|---|
| 21 | **Agent names case-split (`cherry`/`CHERRY`) in all three DBs** | FIG found it. **Nobody verified FIG.** Carried as a headline defect. *(Independently re-derived post-hoc: PASS — see `121-verify.sh`.)* |
| 22 | lccjs ICE store disagrees with its own auto-generated export (4 issues) | FIG only |
| 23 | `lccjs.errors` contains a foreign `pmtools` row | FIG only *(re-derived: PASS)* |
| 24 | **42/135 open lccjs issues (31.1%) gated on a human decision** | BANANA only. **FIG never verified it** — and it is one of the four surviving findings. |
| 25 | pycats `OTHER` is "~97.5% missing vocabulary, ~2.5% triage error" | APPLE's hand-classification of 40 rows. Reproducible in principle; **subjective in fact.** |
| 26 | Three agents each independently hand-rolled the same pre-commit grep | APPLE only |
| 27 | Audit ROI: pmtools worth it / lccjs marginal / **pycats negative** | ELDERBERRY only — and it is a **judgment**, not a measurement. It was reported as a finding. |
| 28 | The 6-category taxonomy is the *right* extension | Proposed by one agent. Its **partition** is verified; its **fitness** is not. |

---

## Table 3 — FAILED THE SCREEN (12)

These are not claims. They were delivered as though they were.

| # | What was said | Why it fails |
|---|---|---|
| 29 | **"This is the highest-cost waste with a clean fix."** | **Cost was never measured. Not once, for any waste.** A ranking asserted over an axis that was never computed. Fails *objective* + *falsifiable*. **The worst single line in the summary.** |
| 30 | **"They are the oldest things in your queue."** | ~38 days against a 35.7-day backlog median — a **6% gap**, inflated into a superlative. Fails *objective*. |
| 31 | **"Nine of ten headline claims dead."** | **The audit chose the ten and graded them.** The denominator is a construction. A different reader picks a different ten and gets a different fraction. Fails *objective*. |
| 32 | "Breaks **every** per-agent grouping **ever** run" | A universal claim with no exhaustive search behind it. Fails *falsifiable*. |
| 33 | "The vocabulary is being extended by the workers **because** it was never shipped" | A causal *because* laid over a correlation. |
| 34 | "An LLM-era failure the 2017 paper has no word for" | Plausible. Unfalsifiable. |
| 35 | "Not your rubric, not your backlog hygiene, not agent throughput — decisions only you can make" | Rhetoric. |
| 36 | "Every wrong finding resolved an ambiguous observation into its most alarming reading" | A claim about **motive**. Insightful; unfalsifiable. |
| 37 | "An audit that finds waste feels successful; one that finds nothing feels failed" | A claim about a **mind**. No evidence exists, or could. |
| 38 | "FIG *wanted* the base rate to kill the 88%" | A claim about an agent's **motivation**, self-reported. Unverifiable in principle. |
| 39 | "The most valuable output was the NOT-ASSESSED rule" | Unfalsifiable superlative. ("At least three numbers were stopped" *is* countable and true. "Most valuable" is not.) |
| 40 | "Every one fails silently. None raises an error." | True of the ones tested; stated as a universal over an untested set. |

---

## Analysis

### The failures cluster, and the cluster has a shape

Zero fabrications. Zero invented numbers. **Every failure is in the sentence that tells you what a
number MEANS** — the ranking, the superlative, the causal *because*, the claim about someone's mind.

This is the same pattern the verifier found in three of five analysts (*"attached a causal reading to
a number the data cannot identify"*), and the same one the ELDERBERRY analyst diagnosed in the parent
agent. **It survives every layer of the process designed to catch it.** The claim ledger, the
admission screen, the linter, and an adversarial verifier all ran — and 12 unfalsifiable assertions
still reached the human, indistinguishable in tone from the 20 verified ones.

**That indistinguishability is the mechanism.** A verified number and an invented ranking arrive in
the same font, in the same sentence, with the same confidence. The reader cannot sort them. **Only the
writer can, and the writer is the one motivated not to.**

### Why "I'll be more careful" is worthless

This audit's own strongest finding is that **documentation does not change behavior**: a banned-word
lesson was written, and the class recurred 5+ times across 6 agents in 8 days, with two agents citing
the note *while violating it*.

An agent promising to make fewer unfalsifiable claims is **exactly that document.** It has precisely
the same evidentiary weight, which is none. The finding applies to the finder.

**What worked was never a promise. It was always a mechanism:**

| Mechanism | What it actually caught |
|---|---|
| `lint_claims.py` `DUPLICATE_FILE` | The copy-instead-of-move error — **twice**, both times invisible to the eye |
| The `NOT ASSESSED` rule | Three confident, well-cited, wrong numbers, before they shipped |
| The kind-matching gate | A behavior claim about `close` being "verified" by a source quote |
| `Bears-on` (criterion 7) | Claims that were true, pinned, and changed nothing |
| An **adversarial** verifier | Causal readings in 3 of 5 analysts |
| `git cherry` (patch-id, not SHA) | A near-deletion of 57 commits |
| **`121-verify.sh`** | **A corner cut inside the script written to stop corners being cut** |

Every one is a **check that runs without the agent's cooperation.** That is the only property that
mattered.

### The correct posture toward this agent's output

**Do not trust it. Do not ask it to be trustworthy. Make trust unnecessary.**

1. **Numbers: demand the repin.** Every claim carries a command that re-derives it. Run it. If there
   is no repin, there is no claim — there is a sentence.
2. **Frames: assume they are unearned until they carry a metric.** Any *most*, *worst*, *biggest*,
   *highest-cost*, *because*, or *therefore* is a load-bearing word with nothing under it until it
   names the measurement. **Twelve of the twelve failures above are of this kind.** The tell is
   perfectly reliable.
3. **Re-running a command is not verification.** Re-deriving the number independently is. The
   difference is exactly the difference between `153/1059` and `151/1133`.
4. **A verifier that agrees is not evidence.** Only a verifier that *tried to refute and failed* is.

### What this document is for

It exists so the next reader does not have to take the audit on faith — and so the audit's own
weakest moments are on the record beside its strongest, in the same file, with the same prominence.

An audit that reports only its findings is marketing.
