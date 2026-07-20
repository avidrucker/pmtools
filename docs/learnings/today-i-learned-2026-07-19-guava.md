# TIL 2026-07-19 — GUAVA

**Context:** Asked to take #132 (document "standard" as pmtools' sole branch/worktree
name format). Reading the docs' premise surfaced that #131 had shipped a **half-migration**:
name *generation* switched to the standard shape (`br-<agent>/<project>-<N>`, no
`issue-` token) but the code that *finds and validates* worktrees still required that
token — so no worktree claimed after #131 could be closed or released. Fixed that first
as #135 (five `issue-`-token gates routed through the single-source-of-truth parser,
both py/js twins), then landed #132 on solid ground.

---

## 1. "Verified end-to-end" is a lie if it only exercised the pure half

**What happened:** #131's close notes said the format switch was "verified live
end-to-end." What it actually verified was the pure `claim_core` round-trip
(`build_branch` → `parse_branch_name` → `branch_to_worktree_name`) via a
`claim --dry-run`. The impure orchestration — `close`/`release` locating a worktree
by `git worktree list` — was never run against a standard name. It still required
`issue-<N>`, so `pmtools close 132 --dry-run` died with `no worktree for issue #132
found`. The generation half was proven; the consumer half was assumed.

**What I learned:** In a self-hosting tool with a pure core + impure wrapper, the pure
seam passing its fixtures tells you nothing about whether the wrapper that *calls* the
seam was updated to match. A format change fans out to every consumer of that format;
"the parser round-trips" is not "the command works."

**The rule:** **When you change a wire/name format, the acceptance test is the real
command on a real artifact of the new shape — `claim → commit → close` — not a
pure-function round-trip. Prove the impure consumer, not just the seam.**

---

## 2. When the command that closes work is itself broken, bootstrap with `PMTOOLS_HOME`

**What happened:** #135's own worktree was standard-named (`wt-guava-pmtools-135`), and
`pmtools` on PATH runs the code on `main` — which was still the buggy pre-fix version.
So the tool I was fixing couldn't close the worktree containing the fix. `bin/pmtools`
resolves its clone root from `$PMTOOLS_HOME` before falling back to the script's own
dir, so `PMTOOLS_HOME=<the-135-worktree> pmtools close 135` ran the worktree's *fixed*
`close` against its *own* worktree. It landed cleanly — and that was also the proof the
fix worked.

**What I learned:** A self-hosting lifecycle tool has a bootstrap problem the moment a
lifecycle command is the thing under repair: the fix can't use itself until it's merged,
but merging needs the (broken) command. The `PMTOOLS_HOME` override is the escape hatch —
run the not-yet-merged code directly.

**The rule:** **To land a fix to `close`/`claim`/`release` itself, close the fix's own
worktree with `PMTOOLS_HOME=<worktree> pmtools close <N>` so the fixed code — not PATH's
stale `main` — does the teardown.**

---

## 3. Twin-port trap: green fixtures can hide a live int-vs-string mismatch

**What happened:** The tolerant parser returns `issue` as an **int**. But the live
wrappers pass `issue` as a **digit string** — `opts["issue"] = positionals[0]` in py,
`opts.issue = positionals[0]` in js. My first cut of `find_worktree_for_issue` and the
close guard compared `parsed.issue == issue` (int vs `"135"`) / `parsed.issue === issue`
(number vs `'135'`) — silently always-false, i.e. fail-closed. The shared fixtures pass
`issue` as a JSON **number**, so the tests were green while the live path was broken. The
old code had dodged this by string-interpolating `issue` into a regex.

**What I learned:** Shared cross-port fixtures fix the *type* of every argument, but the
production callers may feed a different type. A fixture suite that's 100% green is
necessary, not sufficient — it only proves the function against the *fixture's* types.
The seam between the impure wrapper (strings from argv) and the pure core (typed values)
is where this hides.

**The rule:** **At the wrapper↔core boundary, coerce argv values to the core's type at
the top of the function (`int(issue)` / `Number(issue)`), and make at least one test
feed the value the way the live caller does — not only the fixture's convenient type.**

---

## 4. A completeness sweep beats trusting the ticket's enumeration

**What happened:** #135 enumerated four `issue-`-token gates. Before committing I ran a
grep for the token across every resolver (`grep -rn "issue-…" py/ js/` filtered to
pattern/match uses) and found a **fifth**: `infer_fruit_from_branch`, which also required
`issue-` and is load-bearing for `close`'s agent attribution (a standard branch would
have returned `None`, breaking the velocity-guard/identity path). It wasn't in the
ticket's list.

**What I learned:** A well-written bug ticket's root-cause list is a strong hint, not a
closed set — especially for a "find every consumer of X" fix, where the whole failure
mode is *someone got missed last time*. The same sweep that would have prevented the
original half-migration is the one that closes it.

**The rule:** **For an "update every consumer of X" fix, don't stop at the ticket's list —
grep the whole tree for X yourself and reconcile every hit. The bug being fixed is
literally "a consumer was missed."**

---

## 5. Kill the drift at the root: one parser, not N regexes

**What happened:** The half-migration was possible only because the name pattern was
copy-pasted into ~half a dozen places (four/five bespoke `issue-<N>` regexes across
`close_core`, `close`, `status`, `claim_core`). #131 updated the generator and one
parser; the copies drifted. The #135 fix didn't just broaden each copy — it pointed
every resolver at the existing `CANONICAL_BRANCH_PATTERN` / `parse_branch_name`
(`claim_core` is the single source of truth), deleting the bespoke regexes. Now the next
format change touches one definition.

**What I learned:** Broadening each duplicated regex would have fixed today's bug and
left tomorrow's landmine. The durable fix for "a format change stranded a consumer" is to
remove the duplication so there's only one place a format lives.

**The rule:** **When a shared format has drifted across copies, the fix is to route every
consumer through the one canonical definition and delete the copies — not to patch each
copy in parallel.**

---

## What landed

| Artifact | Change |
|---|---|
| `py/close_core.py`, `js/close_core.js` | `find_worktree_for_issue` parses branch + path via the SSOT parser, int-coerced issue (#135) |
| `py/close.py`, `js/close.js` | injection guard: parse-based shape + `parsed.issue == issue`, keeps `is_safe_ref` (#135) |
| `py/claim_core.py`, `js/claim_core.js` | `worktrees_with_issue` + `infer_fruit_from_branch` route through `parse_branch_name` (#135) |
| `py/status.py`, `js/status.js` | `DEFAULT_BRANCH_PATTERN` delegates to `CANONICAL_BRANCH_PATTERN` (#135) |
| `fixtures/claim/*`, `fixtures/close/*`, `py/test_status.py`, `js/status.test.js` | standard-form cases + a status default-pattern test (#135) |
| `CONTRACT.md`, `docs/DESIGN.md` | document "standard" as the sole generated format; drop the dead `worktreeBranchPattern` note (#132) |

## Open threads

- **Authority path:** these five rules live only here for now. Worth a `RULES.md` line
  for #1 (impure-consumer acceptance test) and #4 (grep-the-tree completeness sweep) —
  not done this session to avoid bundling a rules change into a TIL; flag for a follow-up.
- **Downstream, not filed here:** pycats#759 (its `worktreeBranchPattern` config + RULES
  examples still show the legacy shape); lccjs adoption of the standard format per #131.

## Related artifacts

- Issues #131 (the format switch), #135 (the resolver fix), #132 (the docs)
- [Sibling TIL: twin-port default seams](./today-i-learned-2026-06-29-grape.md)
