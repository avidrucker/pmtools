# TIL 2026-07-13 CLAUDE — documentation does not change agent behavior; only checks that run without the agent's cooperation do

**Session:** a nine-waste (muda) audit of lccjs, pycats, and pmtools (#121). Five analysts, one
adversarial verifier, a frozen snapshot, a claim ledger with a seven-criterion admission screen, and
a linter. The audit's findings are in `docs/research/121-*`. **This is what the session taught about
working, not about waste.**

---

## The one lesson, stated once

> **An agent that knows a rule still breaks it. A check that runs without the agent's cooperation
> does not.**

The audit found this in the data, and then the audit *demonstrated it on itself*, three times.

**In the data:** a banned-word lesson was written to agent memory after error #29. The class then
recurred **5+ more times, across 6 distinct agents, in 8 days** — and **in two of those rows the agent
cites the memory note while committing the violation.** Meanwhile **three separate agents each
independently hand-rolled the same pre-commit grep**, and each threw it away at session end. Four
banned-word documents exist across the machine. **Zero are enforced.**

**On itself:** the failure mode was named, its tell was described, and it recurred **in the very next
message**, in the act of describing the tooling built to prevent it. Then again in the message after
that. Knowing the rule did not confer the ability to follow it — for the humans' agents, or for the
agent writing this.

**What actually caught things** — every one is a check the agent cannot talk its way past:

| Check | What it caught |
|---|---|
| `lint_claims.py` `DUPLICATE_FILE` | copy-instead-of-move, **twice** — invisible to the eye both times |
| The `NOT ASSESSED` rule | three confident, well-cited, wrong numbers, before they shipped |
| The kind-matching gate (behavior → executed evidence) | a behavior claim "verified" by a source quote |
| An **adversarial** verifier (brief: refute, do not confirm) | causal readings in 3 of 5 analysts |
| `git cherry` (patch-id, not SHA) | a near-deletion of 57 commits |
| A **mutation test** on the verify script | proved its checks were live rather than decoration |
| A **synthetic reversed case** | that the hypothesis script *could not report a refutation* |

---

## Lessons that generalize

### 1. Re-running a command is not verification

A verifier re-ran 23 numbers and reported *"all reproduced byte-exactly."* That establishes nobody
**fabricated**. It does **not** establish the numbers are **right** — it re-ran their *commands*, which
reproduces their arithmetic, not their claim.

An **independent reimplementation**, written from the claim's English rather than from the original
SQL, returned **151/1133** where the analysts reported **153/1059**. The defect reproduced; the exact
count did not.

> **Re-running someone's command tests their arithmetic. Re-deriving the number independently tests
> their claim.** Only the second is verification.

Corollary, from the same session: two implementations of the rework finding measured *different
populations* (690 lines vs 61) with *different raw rates* (87.8% vs 63.9%) and *different base rates*
(55.7% vs 41.1%) — and landed on the same **enrichment** (1.58× vs 1.56×). **A convergent effect
across divergent methods is stronger evidence than an exact reproduction, which only proves you ran
the same code.**

### 2. The ranking-word tell — 19 of 19

Screening every assertion made to the human across the session produced an absolute split:

| Assertion shape | n | Failures |
|---|--:|--:|
| Contains a number and nothing else | 27 | **0** |
| Contains a ranking word, a universal, or a causal *because* | 19 | **19** |

The failing words, every single time: **highest · strongest · oldest · most · every · nobody · only ·
exactly · because · therefore.**

**Zero fabrications. Every failure was in the sentence that says what a number MEANS.** The worst was
*"this is the highest-cost waste"* — a ranking asserted over an axis (**cost**) that was never
measured, for any waste, at any point.

> **This is a filter a reader can apply mechanically, without reading a line of SQL, and without the
> author's cooperation.** That is what makes it worth more than the author's confidence — which was
> uncorrelated with correctness all session.

### 3. A verifier that agrees is not evidence. Only one that *tried to refute and failed* is.

The verifier was briefed to **refute, not confirm**, and to run three queries nobody asked for. It
found a Simpson's paradox, a missing null hypothesis, and three defects nobody was looking for
(including agent names being **case-split** — `cherry` vs `CHERRY` — across all three DBs, silently
breaking every per-agent `GROUP BY` ever run).

It also flagged its own bias unprompted: it *wanted* two findings to die, they didn't, and it recorded
them as REFINED rather than REFUTED.

### 4. An instrument that cannot refute you is broken

The hypothesis script was fed a **synthetic reversed effect** — fixes deleting *old* code, enrichment
0.49×, z = −4.1 — and printed **"AMBIGUOUS."** It had no branch for *"the opposite of your hypothesis
is true."*

> **Test that your test can fail.** A verify script that never goes red is decoration. Mutation-test
> it: corrupt the data and confirm the right checks fire. Feed the hypothesis harness a synthetic null
> and a synthetic reversal, and confirm it says so.

### 5. `count(*) != max(id)` is a hypothesis, not arithmetic

`velocity` had 1493 rows and `max(id)` 1520, and this was reported as **"27 rows were deleted."** It was
an **inference presented as an observation**. These tables use `AUTOINCREMENT`, under which a
**rolled-back or failed insert burns an id exactly as a delete does**. pmtools exposes **no delete path
at all**. The likeliest cause is an agent erroring mid-log — in which case **nothing was ever lost.**

The gap proves an id was **issued**, never that a row was **removed**.

### 6. Ask the human *before* building the story, not after

Four hundred words were spent on *"pycats lost 645 commits of calibration data"* — a self-disabling
safeguard, a tool that watched the data evaporate, a measurement catastrophe. Then the human was asked
whether he **wanted** the data.

He had turned velocity off **on purpose.**

> **You cannot lose data you deliberately chose not to collect.** The question cost one sentence and
> was asked last. **A waste finding nobody experienced as a loss is not a finding.**

### 7. Report NOT ASSESSED, never a proxy

Three analysts independently reached the same conclusion:

> **A metric that is computable and confounded is worse than one that is missing — because a missing
> metric announces itself.**

Flow efficiency for lccjs *computes*. It returns 0.2%, against a 15–40% benchmark, and reads as
"catastrophic waiting waste, 75× worse than any team on record." It is garbage: `closedAt − createdAt`
on a solo project counts nights, weekends, and the day job. A filtered version reverses its own
conclusion when the cutoff moves from 8 hours to 4.

**The reason a proxy gets substituted is not laziness. It is structural**, and the diagnosis is the
most useful sentence of the session:

> **An audit that finds waste feels successful; one that finds nothing feels failed.** That incentive
> is what turns "27 ids missing" into "27 rows deleted."

---

## Concretely, for this repo

- **`AUTOINCREMENT` id-gaps are not deletions.** Nothing in `py/` or `js/` deletes from `errors`,
  `velocity`, or `ice`.
- **Agent names are case-split across all three stores.** Every per-agent aggregate ever produced is
  suspect. Normalize on write, or `lower()` on every read.
- **`errors.occurred_iso` and `velocity.started_iso` mix `-1000` and `-10:00` offsets in one column.**
  SQLite's `date()` returns **NULL** on the first form — for **275 of 403** lccjs rows — and
  `min`/`max`/`avg` skip NULLs **silently**. **Never wrap these columns in `date()`.**
- **`closed_commit` is filled on 63 of 1493 velocity rows (4%).** *Enforce it or delete it.* 96%-empty
  is strictly the worst of the three options, and it is the one in place — **a field nobody fills is
  worse than no field, because it looks like data.**
- **`error_type` has 15 mechanical types and no category for an agent-judgment error.**
  `BEHAVIORAL_FAIL` appears in the `log-error` skill **zero times** and has **30 rows in use**. The
  vocabulary is being extended by the workers because it was never shipped.

## Related

`docs/research/121-muda-waste-audit-2026-07-13.md` (findings) ·
`121-report-findings-meta.md` (screening the audit's own claims — 30% failure rate) ·
`121-report-findings-meta-meta.md` (screening the claims about the verification tooling — the tell held) ·
`121-verify.sh` (19 checks, PASS/FAIL, mutation-tested) ·
`121-hypothesis-rework.py` (derives a finding from raw data and tries four ways to kill it).
