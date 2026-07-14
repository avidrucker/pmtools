# Meta-meta #121 — screening the claims made *about the verification tooling*

**Role:** RESEARCH · **Author:** claude · **Status:** findings.
**Companions:** `121-muda-waste-audit-2026-07-13.md` (the audit) · `121-report-findings-meta.md` (screening the audit's summary).

## Verdict

**The tell held a third time, at 19 of 19.** Screening the claims made about the verification
*instruments* — the layer built specifically to stop unfounded claims — produced the same result as
screening the audit itself: **every failure is a ranking word, a universal, or a causal claim. Zero
failures are in a number.**

The screen also found **three real defects in the instruments**, all by testing rather than by care:

1. **`121-hypothesis-rework.py` could not report a refutation.** A reversed effect (fixes deleting
   *old* code — enrichment 0.49×, z = −4.1) printed **"AMBIGUOUS."** An instrument that cannot say
   *"the opposite of your hypothesis is true"* is broken. Fixed; four verdict branches now tested.
2. **The audit's "88%" figure is population-dependent** and was stated as a fact about the world.
3. **"Monotonic decrease is exactly the signature of a real effect" is mechanically wrong** — the
   decay toward 1.0 is forced by a ceiling, not by the effect.

---

## The claims, screened

### PASS — 7/7 on the admission screen

| Claim | Evidence |
|---|---|
| At `c83d41b`, over a 30-day cohort, lccjs `fix:` commits deleted **61** code lines; **39** were <14d old (63.9%) against a **41.1%** base rate in the same files → **1.56× enrichment, z = +3.5** | `[E1·query]` `121-hypothesis-rework.py --repo lccjs` · repin: same command · data-pin: `@c83d41b` (immutable) |
| The 14-day window is **not tuned to the answer**: enrichment is **2.87× at 7d**, 1.56× at 14d, 1.33× at 21d, 1.21× at 30d | `[E1·query]` window sweep, same script |
| Jackknife: dropping the largest contributing commit moves 1.56× → 1.46× | `[E1·query]` same script |
| pycats replicates weakly: **1.20×** (n = 115 lines, 40 fixes) | `[E1·query]` `--repo pycats` |
| Two independent implementations disagree on population but agree on effect: DRAGONFRUIT 690 lines / 87.8% / 55.7% base → **1.58×**; this one 61 / 63.9% / 41.1% → **1.56×** | `[E1·quote]` his ledger + `[E1·query]` this run |
| `121-hypothesis-rework.py` prints `H1 NOT SUPPORTED` when observed rate == base rate | `[E1·test]` synthetic null case, executed |
| `121-verify.sh` goes red under data mutation — 7 checks fired on 3 mutations | `[E1·test]` mutation run |

### FAIL — the admission screen rejects these

| # | Assertion | Criterion failed | Note |
|---|---|---|---|
| 1 | "The window sweep is **the strongest evidence in the whole audit**." | **2 — objective** | A superlative over a comparison never run. **Identical in kind to "highest-cost waste," asserted three messages after that failure was named and the tell described.** |
| 2 | "…and **nobody** ran it." | **1 — falsifiable** | A negative universal about six agents' work, asserted without reading their ledgers. |
| 3 | "That's **exactly the signature** of a real effect." | **2 — objective** | And wrong on the mechanics — see below. |
| 4 | "**My filter is stricter** (code extensions only, `fix:`/`bug:` subjects only)" — offered as the *cause* of the 690-vs-61 gap | **1 — falsifiable** | The cause was asserted without reading the other implementation's method. The gap is real; the explanation was a guess in a fact's clothing. |
| 5 | "That's **the only** kind of evidence worth anything." | **1, 2** | Unfalsifiable superlative. |
| 6 | "It **had the ability to refute me** and didn't exercise it." | **1 — falsifiable** | True *now*. **Untested when asserted** — and the refutation branch was in fact half-broken. |
| 7 | "You were right that it's the better shape." | — | Not a claim. Agreement. |

---

## The mechanical error worth keeping

**"Enrichment decays monotonically as the window widens, therefore the effect is real"** — this is
wrong, and the wrongness is instructive.

As the window widens, *both* the observed rate and the base rate climb toward 100%. Their ratio is
therefore **forced** toward 1.0 by a ceiling, under H1 **and** under the null. The decay carries far
less information than it appears to.

**The evidence that actually matters:** enrichment stays **> 1 at every window tested**, and is
**largest at the shortest window** (2.87× at 7 days). *That* is what a concentration-on-fresh-code
effect looks like, and it is also what rules out window-tuning — a tuner would have reported the 7-day
figure.

Same finding. Correct reason. The original reason was a pattern that *felt* diagnostic.

---

## The pattern, now at 19 of 19

Across two screens — the audit's summary (40 assertions) and the tooling claims (7) — the split is
absolute:

| | Count | Failures |
|---|--:|--:|
| Assertions containing **a number and nothing else** | 27 | **0** |
| Assertions containing **a ranking word, a universal, or a causal "because"** | 19 | **19** |

The failing words, every time: *highest · strongest · oldest · most · every · nobody · only · exactly ·
because · therefore.*

**This is a filter that can be applied mechanically, by a reader, without understanding the SQL.**
It does not require trusting the author, and it does not require the author's cooperation — which is
the only property that has been shown to work.

---

## Why this document exists

The audit found that **documentation does not change behavior** — a banned-word rule was written, and
the class recurred 5+ times across 6 agents in 8 days, twice with agents citing the rule as they broke
it.

**That finding applied to the finder, and this document is the proof.** Between the first screen and
this one, the failure mode was named, its tell was described, and the reader was warned about it —
**and it recurred immediately, in the very next message, in the very act of describing the tooling
built to prevent it.**

Knowing the rule does not confer the ability to follow it. What worked was never a promise:

| Mechanism | Caught |
|---|---|
| `lint_claims.py` `DUPLICATE_FILE` | copy-instead-of-move, **twice** — invisible to the eye both times |
| The `NOT ASSESSED` rule | three confident, well-cited, wrong numbers, pre-ship |
| The kind-matching gate | a behavior claim "verified" by a source quote |
| An **adversarial** verifier | causal readings in 3 of 5 analysts |
| `git cherry` (patch-id, not SHA) | a near-deletion of 57 commits |
| A **mutation test** | that the verify script's checks were live, not decoration |
| A **synthetic reversed case** | that the hypothesis script could not report a refutation |
| **The word-filter above** | 19 of 19 |

Every one is a check that **runs without the author's cooperation.** That is the entire finding.
