# pmtools glossary — approved / denied terms for agent answers

This file is the source of truth for the terminology agents may use in **answers to the
human** (chat, PR descriptions, ticket comments). It exists so "write clearly" is
enforceable rather than a matter of taste. Ruled in a pair session under #90; consumed by
#89's `CLAUDE.md` "Communication style" rules.

## Verdicts

Each term carries one of three verdicts:

- **APPROVED** — precise, common, no plain equivalent. Use freely, no definition needed.
- **APPROVED-WITH-GLOSS** — usable, but **define it in one clause the first time it
  appears in a given answer**. The canonical gloss is in the table; reuse it.
- **DENIED** — a plain phrase is equally precise. Use the **plain alternative** instead.

## APPROVED — use freely, no gloss

| Term | Note |
|------|------|
| worktree | common lingo; no definition needed |

## APPROVED-WITH-GLOSS — define in one clause at first use

| Term | Canonical gloss (reuse verbatim) |
|------|----------------------------------|
| overlay | an extra true/false marker on a status row, independent of the main status |
| lifecycle status | the one mutually-exclusive state: IDLE / CLAIMED / IN-PROGRESS / STALE |
| marker (`@todo` / `@inprogress`) | a code comment that registers a work item against an issue |
| fixture / case file | a saved input + expected-output pair used to test a function |
| port / both ports | one of pmtools' parallel JS and Python implementations |
| .pddignore | a file of path patterns to exclude from the work-item scan |
| spike | a short, time-boxed research session that produces findings, not code |
| TDD | test-driven development — write the failing test first |

## DENIED — use the plain alternative

| Term | Plain alternative |
|------|-------------------|
| canonical (marker / grammar) | "the standard (approved) marker format" |
| soft-lock | "temporarily hands-off" |
| battery (test battery) | "set of tests" |
| baked in | "hardcoded" |
| "STALE wins" | "STALE takes precedence" |
| bare `#NN` with no gloss | add a 3–5 word gloss on first use — e.g. "#15 (the marker-flood fix)" |
| agent codenames in user-facing text (BANANA, grape, …) | name the role plainly |
| a glyph as the only signal (🔒 / ⛔ / ✗) | pair the glyph with a word |
| rubric | "scoring guide" |
| reconcile / reconciler | "the step that matches markers to worktrees and issues" (noun: "the matcher") |
| "the #NN rule" shorthand | describe the rule in words; don't make the reader resolve a number to grasp a principle |

## Ruling a new term (the reusable process)

This is the mechanism intended to generalize beyond pmtools:

1. **Propose** the term in a comment on the glossary ticket (currently #90, or its
   successor): suggest a verdict and, for APPROVED-WITH-GLOSS, a one-clause gloss; for
   DENIED, the plain alternative.
2. **Diagnose load-bearing vs gratuitous.** Is there a plain phrase that is *equally*
   precise? If yes → DENIED. If the term carries meaning no plain phrase does → APPROVED
   or APPROVED-WITH-GLOSS (gloss unless it is genuinely common lingo).
3. **The reporter rules.** The human signs off; the decision is recorded by adding a row
   to the matching table here.
4. **Default on silence:** an unruled term is treated as APPROVED-WITH-GLOSS until ruled —
   define it, don't assume the reader knows it.

_Built from the #90 pair-session ruling. `marker` and `.pddignore` were carried at their
proposed APPROVED-WITH-GLOSS default (not explicitly ruled in-session) — flag to change._
