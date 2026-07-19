# TIL 2026-06-28 — BANANA

**Context:** A mixed session in the `area:status` lane. Ran a research spike — a
short, time-boxed investigation that produces findings, not code — on #80 (the
config-gated LOCKED cluster soft-lock contract); reviewed #30 and #78 for
readiness; then, prompted by the human repeatedly reaching for the `eli5` skill,
filed and worked a two-ticket clarity thread (#89 communication-style rules, #90
term glossary). Lessons below are mostly about *judgement and process*, not code.

---

## 1. A spike's deliverable can be "not yet" — but only if you prove zero consumers

**What happened:** #80 asked me to define the contract for LOCKED (a status
overlay — an extra true/false flag on a status row, independent of the main
status — meaning "a clustermate is in progress, so this code-area is hands-off").
I read the reference implementation in lccjs (`scripts/puzzle-status.js`,
`docs/puzzle-clusters.csv`) and could have specced an implementation. The
decisive finding wasn't *how* to build it — it was *whether to*. Three signals
said no live consumer existed: lccjs still ran `npm run puzzle:status` (no
cutover, script + 10+ docs intact, no retirement commit); pmtools' own
`orchestrate.json` has no `clusterFile`, so LOCKED would be a permanent no-op
here; and the downstream `🔒` consumer in the puzzle-triage skill isn't built.
So I landed the *contract* as a comment and recommended **defer the build**.

**What I learned:** The parent epic (#75) had explicitly said "don't build
cluster machinery ahead of demand," and the spike's real value was confirming
the trigger hadn't fired. A defer recommendation is not a cop-out — but it has a
burden of proof: enumerate the would-be consumers and show each is absent.

**The rule:** **A spike that recommends DEFER must prove zero live consumers (not
"it's hard") — name each downstream that would read the feature and show it's
unbuilt or unwired.**

---

## 2. "Held" / "blocked" in an orchestration brief is a claim to verify, not a fact

**What happened:** My assignment brief said #78 (the BLOCKED overlay) was "held
this round" behind a `tests/integration.sh` collision. When the human asked if
#78 was ready to take, I checked the tracker first — #78 was already **CLOSED**,
landed in commit `ceb0c4b` before the session even started. The brief was stale.

**What I learned:** A brief is a snapshot from whenever it was written; ticket
state moves underneath it. Trusting "held" would have had me trying to take work
that was already done. The 10-second `gh issue view` paid for itself.

**The rule:** **Before acting on a brief's "blocked"/"held"/"available" claim,
confirm the ticket's actual state from the tracker — the brief is a hint, the
tracker is truth.**

---

## 3. Readiness and availability are orthogonal axes of "can I take this?"

**What happened:** #30 scored READY on the issue-review rubric (a scoring guide;
14/15). But "ready" only means *well-specified* — it said nothing about whether I
could start *right now*. Its real gate was a file collision: grape held a
reserved worktree (a separate working copy on its own branch) for #46, whose
scope touched the same `fixtures/status/` and test files. I checked grape's
worktree directly — empty, no committed or uncommitted work — so the collision
was latent, not active. And it was *avoidable*: #30's own scope steers the work
to the unit-fixture layer (a fixture being a saved input + expected-output pair),
so by staying out of `tests/integration.sh` I dodge grape's only shared file
entirely.

**What I learned:** I almost answered "is #30 ready?" with the rubric score and
stopped. The human's actual question was "can I take it," which is rubric-score
**plus** a claim/worktree collision check **plus** a scoping move to avoid the
contested file.

**The rule:** **A ready ticket can still be unavailable — separately check
claims/worktrees for file overlap, and prefer a scope that sidesteps the
contested file rather than racing for it.**

---

## 4. `pmtools close` is worktree teardown, not "land the commit and close the issue"

**What happened:** I worked #90 directly on `main` (no claim, no worktree),
committed `Closes #90` on a branch, then tried `pmtools close 90 --branch …` as
the human asked. It refused twice: first because the branch name didn't match the
required `br-<agent>/[<project>-<lang>-]issue-<N>` pattern, then because there was
**no worktree for #90 to tear down**. close's whole job is the symmetric mirror
of claim — land on `origin/main`, then dismantle the worktree. With no worktree,
it has nothing to finish. I did the manual equivalent (fast-forward merge + push;
the `Closes #90` keyword auto-closed the issue) — but that skipped the lifecycle
the tool assumes.

**What I learned:** I'd been thinking of close as "the land-and-close button." It
isn't — it's the *teardown* half of a claim→work→close cycle. Working on `main`
put me outside the cycle the tooling is built for. (This is also what the TIL
skill's pitfall table means by "Worked on main → workflow miss / claim a worktree,
RULES.md rule 4.")

**The rule:** **To use `pmtools close`, claim first so a worktree exists for it to
tear down; close is the end of a lifecycle, not a standalone land-and-close.**

---

## 5. "Write clearly" is unenforceable without a committed term glossary

**What happened:** The human kept invoking `eli5` to make my routine answers
legible — my first drafts were dense with undefined jargon and bare ticket
numbers. Rather than just "try to write better," we made it a contract: I filed
#89 (a `CLAUDE.md` "Communication style" section) and its prerequisite #90 (a
project glossary), then ran the `guide-human-decision` skill to rule each
candidate term **APPROVED** (use freely), **APPROVED-WITH-GLOSS** (define in one
clause at first use), or **DENIED** (use a plain alternative). The useful axis
that emerged: *load-bearing* jargon (a precise term with no plain equivalent —
keep it, define it) versus *gratuitous* slang ("soft-lock" → "temporarily
hands-off"; "baked in" → "hardcoded" — just drop it).

**What I learned:** "Be clearer" is a taste judgement every agent re-guesses, and
the guesses skew jargon-heavy. Turning it into a committed `docs/glossary.md` with
per-term verdicts makes it checkable — and the same three-verdict format
generalizes to other repos.

**The rule:** **Make clarity enforceable: a committed glossary ruling each term
APPROVED / APPROVED-WITH-GLOSS / DENIED beats an exhortation to "write clearly."**

---

## What landed

| Artifact | Change |
|---|---|
| GH #80 | Spike contract for LOCKED + defer recommendation; closed |
| GH #75 | Annotated the LOCKED child as deferred with re-trigger conditions |
| `docs/glossary.md` | New: approved/denied term glossary + reusable ruling process (#90) |
| GH #89 | Filed: `CLAUDE.md` communication-style section (unblocked once #90 landed) |
| GH #90 | Filed, ruled in a pair session, closed (commit `c550ffb`) |

## Open threads

- #89 is ready but unworked — write the `CLAUDE.md` rules that consume the glossary.
- #30 remains takeable at the unit-fixture layer (avoid `tests/integration.sh`).
- `marker` and `.pddignore` were carried into the glossary at their proposed
  verdict without an explicit in-session ruling — flagged for veto.

## Related artifacts

- Issues #80, #75, #89, #90, #30
- Prior lane TIL: [TIL 2026-06-26 APPLE](./today-i-learned-2026-06-26-apple.md)
