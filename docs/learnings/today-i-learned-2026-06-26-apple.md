# TIL 2026-06-26 — APPLE

**Context:** Picked up #8 ("close exits 1 after a successful `CLOSE OK`") off the
orchestrator. The whole session became a study in *not* fixing things: the bug
didn't reproduce, the prescribed test already existed, and the adjacent "bug" I
almost filed turned out to be a benign spec divergence. Closed #8 as
already-correct; filed #82 (the `--force` divergence) as a parity issue, not a bug.

---

## 1. Verify the prescribed fix is already present before writing code

**What happened:** #8 reported `pmtools close` exiting 1 after printing `CLOSE OK`,
with a "likely cause: non-zero status escaping the tool" and a prescribed fix
("chdir to root before any final step, return 0"). Both ports *already* did exactly
that (`py/close.py:651`, `js/close.js:633`). I built a hermetic harness — local bare
origin + main checkout + a worktree with a real `Closes #N` commit — and ran the
**actual** close through the full land→gate→teardown path. All four configs (py/js ×
from-root/from-worktree) exited **0**.

**What I learned:** A bug report bundles two claims — *the symptom* and *the cause/fix*
— and they can both be wrong while the symptom is real. The symptom (operator saw
`$? = 1`) was real; the attribution (the tool returns 1) was not. lccjs had already
recorded this exact misattribution in `errors.csv` row 129 ("NOT a close.js bug").

**The rule:** **Reproduce the symptom AND check whether the prescribed fix already
exists before touching code.** If the fix is already in the tree, the ticket is an
investigation, not an implementation.

---

## 2. Grep the test suite for the behavior before proposing a regression test

**What happened:** I initially recommended adding an "exit-0 on success" regression
test, citing #8's acceptance bullet ("a fixture grading success ⇒ 0, both ports").
Then I actually read `tests/integration.sh`: `run_close_suite()` (invoked for py at
:322 and js at :323) already does claim → commit `Closes #N` → close →
`assert_exit "$?" 0` (:300). The acceptance fixture predated the ticket.

**What I learned:** I justified a test from the ticket's acceptance criteria without
checking whether that criteria was already met — circular. A regression test only
earns its place if it guards a behavior that broke, got fixed, and isn't already
covered. This one failed all three.

**The rule:** **Before adding a guard, grep the existing suite for the behavior.** A
redundant test is first-class code you now have to maintain, not a free win.

---

## 3. A bug you can't reproduce through the supported flow is a divergence, not a bug

**What happened:** While in close.py I noticed teardown calls `git worktree remove`
without `--force`, though CONTRACT §close step 13 / release line 481 specify `--force`.
I was asked to file it as a `bug`. I tried to write a failing repro three ways:
untracked files → the **clean-tree guard (step 7) dies first**, teardown never runs;
git-ignored files → `git worktree remove` removes them fine *without* `--force`; only
a contrived `git worktree lock` actually trips it. No failing test through the
supported flow.

**What I learned:** The honest complaint wasn't "teardown fails" (it doesn't) — it was
"code contradicts its own CONTRACT." I filed #82 as a CONTRACT-vs-code **parity
divergence** (`refactor` + `area:lifecycle`), explicitly *without* a `bug` label,
presenting both resolutions (add `--force`, or amend the contract) and prescribing
neither — the design call belongs to the reporter.

**The rule:** **If you can't write a failing test through the supported flow, it isn't
a bug — name it a divergence and don't mislabel it.** Filing a non-reproducing issue
as `bug` is the same trap as #8, just from the other side.

---

## 4. Separate the process exit code from the shell's

**What happened:** The field symptom was `pwd: error retrieving current directory:
getcwd …` then `echo $? → 1`. In my harness, capturing `$?` immediately after the
close process gave **0** every time. The getcwd error comes from the *caller's*
interactive shell (its `$PWD` was removed by the successful teardown) — the next
`getcwd()`-calling thing (starship prompt / `PROMPT_COMMAND` / `pwd -P`) fails and
sets `$?`. In a plain bash subshell, `pwd` even returns 0 (it echoes cached `$PWD`),
which is why the symptom is environment-dependent.

**What I learned:** A child process cannot change its parent shell's working
directory, so this class of "the tool exits 1" is unfixable from inside the tool. The
remedy is operational: run close from the main root with `--branch` (which the test
suite already does).

**The rule:** **When an exit code is blamed on a tool, capture `$?` immediately after
the process and isolate it from downstream shell noise** before believing the tool
returned it.

---

## 5. A strict persona panel converges fast on honesty

**What happened:** Twice I ran the decision through the yegor personas instead of my
own paraphrase. They agreed independently: **bdd** (the "faux complaint" pitfall — a
real complaint names a concrete *current* wrong behavior, not a hypothetical one),
**review** (no-bullshit; a runtime claim with no failing test is rejectable),
**velocity** (filing a non-bug as `bug` then "fixing" it games the
bugs-reported/fixed scorecard), **architect** (the `--force` question is a *design*
call a courier must not pre-decide).

**What I learned:** The personas cross-check each other — they're not redundant. bdd
told me *how to shape* the complaint, review told me *what to reject*, velocity told
me *what not to inflate*, architect told me *whose decision it is*.

**The rule:** **When unsure how to file or close, run the persona panel — let them
reject before you commit.**

---

## What landed

| Artifact | Change |
|---|---|
| Issue #8 | Closed (not planned) with a hermetic-harness evidence comment; no code change |
| Issue #82 | Filed: `--force` teardown CONTRACT-vs-code divergence (`refactor`, not `bug`) |
| velocity DB | RESEARCH row for #8 (id=7) |

## Open threads

- **#82 resolution is a reporter/architect call** — add `--force` (prod change → needs
  a contrived-lock proving test) vs amend CONTRACT (docs-only). Not prescribed.
- **Stale `refs/claims/issue-44`** surfaced during my own `pmtools claim` — the live
  instance of the #81 bug (claims signal includes CLOSED-issue refs). Sweep:
  `git push origin :refs/claims/issue-44`.

## Related artifacts

- Issue #8, #82, #81
- lccjs `docs/errors.csv` row 129 (the same exit-1-after-`CLOSE OK` misattribution,
  investigated and corrected there first)
