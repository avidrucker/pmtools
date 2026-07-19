# TIL 2026-06-25 — GRAPE

**Context:** A long session on the pmtools side of the lccjs→pmtools PM-tooling
migration. Shipped #44 (unify the error-string convention across both ports) and
the bulk of umbrella #36 — porting three of the four omitted close-safety guards
as faithful `py`/`js` twins: #60 (union-file `merge=union`), #64 (learnings /
markdown-index conflict resolve), #66 (parent-tracker checkbox auto-check). Guard 1
(#57, velocity-CSV) was already done by a sibling agent. Five lessons earned their
keep.

---

## 1. Reversing a *just-landed* convention means flipping every encoder of it in one commit

**What happened:** #44 thread 3 wanted exit code `2` for all usage/argument errors
(reserving `1` for operational failures). But #39 had landed *four commits earlier*,
deliberately pinning `status`'s bad-arg exit to `1`. Flipping to `2` wasn't a
one-line change: the old convention was encoded in the `status` code, in the
`error`/`velocity` dies, in the #39 *parity assertion* that pinned `--strrict` to
exit 1, and in the #38 dispatcher tests. Change any subset and the suite is
half-migrated — green on the parts you touched, lying about the parts you didn't. I
flipped all of them together: parameterized every `die(msg, code=1)`, passed `2` at
the ~30 structural-usage call sites, and updated the #39 + safe-thread assertions
to expect `2` in the same commit.

**What I learned:** A "convention" isn't one place — it's every spot that encodes
the rule, *including the tests that assert the old value*. The danger isn't
forgetting the code; it's forgetting the assertion that keeps passing and masks the
inconsistency. I also added an explicit *operational-stays-1* guard test
(`error log '{bad'` → exit 1) so the change proves it didn't over-flip — the line
between "structural invocation error → 2" and "the world said no → 1" needs a test
on *both* sides or it silently drifts.

**The rule:** **When a change reverses a recent decision, grep for every encoder of
the old convention — code AND assertions — and flip them in one commit; add a test
on the side you're NOT changing to prove you didn't over-reach.**

---

## 2. "Use the same serializer" isn't byte-parity until you check its defaults

**What happened:** #44 thread 2: the unknown-subcommand message rendered the bad
token via Python `repr` (`got 'foo'`) vs JS `JSON.stringify` (`got "foo"`) — a
faithful-twin drift. The obvious fix was to make Python use `json.dumps` so both
emit JSON. It passed... for ASCII. But `json.dumps` defaults to `ensure_ascii=True`,
so a non-ASCII token renders `"café"` in Python vs `"café"` in JS — the drift
just moves to the first accented character. I only caught it because I RED-tested a
`café` token *before* trusting the fix, then set `ensure_ascii=False`.

**What I learned:** "Both ports call the same *kind* of serializer" is a weaker
claim than "both ports emit the same *bytes*." Serializers carry locale/encoding
defaults (`ensure_ascii`, float formatting, key ordering, trailing newlines) that
silently diverge. For a tool whose entire contract is byte-identical twin output,
the parity test must include inputs that exercise those defaults — ASCII alone is a
false green.

**The rule:** **For faithful-twin output, RED a non-ASCII / edge input before
trusting a "same serializer" fix — matching serializers can still differ in their
defaults.**

---

## 3. On a shared physical clone, `main` moves under you — commit, *then* rebase, *then* full-suite

**What happened:** All of #36 ran in `~/code/pmtools`, a clone shared by several
concurrent agents. Between starting a guard and landing it, local `main` advanced
**three separate times** (a sibling's velocity-CSV guard, a velocity repo-default
fix, a test-hardening commit). A naive `git merge --ff-only` would have failed each
time. My loop became: commit my work first (so it's safe and named), `git fetch
-p`, `git rebase main`, then **re-run the entire `run-tests.sh`** — not just my new
tests — and only then land.

**What I learned:** The rebase is the dangerous step, not the push. Rebasing
silently *combines* my change with whatever landed concurrently; the only thing
that proves they coexist is a full-suite run *after* the rebase. Running just my
guard's tests would miss a regression where a sibling's change and mine interact.
Committing before rebasing matters too — uncommitted work during a rebase is how
you lose it.

**The rule:** **In a clone shared by concurrent agents: commit → `fetch -p` →
rebase → run the FULL suite → land. Re-running only your own tests after a rebase
is a false green.**

---

## 4. Before "fixing" config that looks wrong, check the repo's own history

**What happened:** My first commit landed authored as `tester
<tester@example.com>`. That looked like a misconfiguration — the workspace
`CLAUDE.md` says to commit as the user's GitHub noreply identity. I started down the
"fix the git identity" path... then checked `git log`: *every* commit in this
clone's history is `tester`, by every agent. It's the deliberate throwaway identity
for this sandbox puzzle clone, which lives *outside* the `~/Documents/Study` tree
that the `CLAUDE.md` rule governs.

**What I learned:** A global rule ("use my real identity") and a local convention
("this sandbox commits as tester") can both be correct in different trees. The repo
*history* is the authority on which applies here — one `git log` would have saved
the detour. I saved it to memory so the next session doesn't repeat the
investigation.

**The rule:** **When a repo's config contradicts a global/workspace rule, the repo's
own history decides — match the local convention; don't impose the global one
without checking.**

---

## 5. A "no integration tests" constraint reshapes TDD; it doesn't suspend it

**What happened:** The #36 lane assignment said the guard-fire *integration*
assertions were another ticket's job (#31, held) — leave `tests/integration.sh`
untouched. That removed my usual RED tool for the impure close arms. But each guard
has a *pure* decision seam (`is_markdown_index_only_conflict`,
`resolve_append_only_markdown_conflict`, `find_parent_trackers`,
`tick_checkbox_for_issue`) graded by the `*_core` fixture twins — which are NOT
`integration.sh`. So I TDD'd the pure logic via fixtures (RED → GREEN, both ports),
and verified the impure arms (rebase resolution, the provider *write*) with
standalone, out-of-tree both-port *smoke* scripts using a fake `gh`.

**What I learned:** "Don't write integration tests here" isn't "don't test" — it's
a redirection, and the pure/impure split is what makes it work. The decision logic
(the part that's easy to get subtly wrong) stays fixture-tested; the thin wiring
gets a throwaway smoke that never enters the repo. The constraint overrode the TDD
*ritual* (always add an integration scenario) without touching the *discipline*
(RED before GREEN on the logic; verify the wiring before landing).

**The rule:** **A "don't touch the integration suite" constraint means TDD the pure
seams via fixtures and smoke-test the impure wiring out-of-tree — narrow the test
surface, don't drop it.**

---

## What landed

| Ticket | Change |
|---|---|
| #44 | Unify error-string convention: `[cmd] ✗` failure / `[cmd] note:` warn prefix, JSON-rendered unknown-subcommand (`ensure_ascii=False`), exit `2` for usage / `1` for operational — all commands, both ports |
| #60 | Close guard 2 — union-file `merge=union` auto-resolve, config-gated (`close.autoResolve.unionFiles`) |
| #64 | Close guard 4 — append-only markdown-index conflict resolve, config-gated (`close.autoResolve.markdownIndexes`) |
| #66 | Close guard 3 — parent-tracker checkbox auto-check, config-gated (`close.updateParentTrackers`) + provider `edit_issue_body` write |
| #62 | Filed: migrate residual `warn:`/`warning:` to the `[cmd] note:` channel (follow-up) |

#36 umbrella closed (all four close guards ported); unblocks the close-switch chain #31 → lccjs#1466 → #1467.

## Related artifacts

- [Prior TIL](./today-i-learned-2026-06-24-grape.md) — twin-port: the default port on PATH decides where a bug is load-bearing
- Issues #44, #36, #60, #64, #66, #62
