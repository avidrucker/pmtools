# TIL 2026-06-29 — GRAPE

**Context:** A long testing-lane session across the twin Python/JS ports. Landed
#46 (promote each wrapper's `parseArgs` into a shared pure core + fixtures, add
canned-I/O seam tests, restore the JS `preflight_core` split), then split the fat
#84 BLOCKED-overlay ticket via a persona council into a thin tracker + spike #86 +
children #87 (blocked-by relation) and #88 (marker-less synthetic rows), and
implemented all three. Most of what I learned was in the *seams* — how to make
impure wrappers testable across two ports from one set of golden fixtures — and in
the *close* step's failure modes.

---

## 1. Port-specific defaults must NOT live in a shared cross-port fixture

**What happened:** Promoting `status`'s `parseArgs` into `status_core` so both ports
grade it against `fixtures/status/parse_args.cases.json`, I hit a wall on the
`--branch-pattern` default. The default regex is **not identical across ports**:
JS writes named groups `(?<agent>…)`, Python writes `(?P<agent>…)`. A fixture case
asserting `branchPattern == "<the default>"` can only match one port.

**What I learned:** The fix wasn't to encode both — it was to make the *pure* parser
return `branchPattern: null` when the flag is absent, and let each impure wrapper
substitute its own port-local `DEFAULT_BRANCH_PATTERN`. The shared fixture then
asserts `null`, which is identical on both sides. The default is a *consumer-local*
fact; the pure core stays consumer-agnostic. (Same shape as last session's "a
generic harness reads `.pddignore`, it doesn't hard-code consumer paths.")

**The rule:** **If a default differs between ports, the pure core returns a neutral
sentinel (null) and the wrapper fills it — never hardcode a port-specific default into
a shared fixture.**

---

## 2. `expected_error` is how you grade "this should throw" across two ports

**What happened:** The ticket wanted "unknown flag → die" tested. But `die()` calls
`process.exit`, so a pure parser can't call it — and a fixture can't assert an exit.
The existing `store_core` fixtures already had the answer: cases tagged
`"expected_error": true`. The pure parser **throws** (`Error` / `ValueError`); the
harness asserts it throws; the impure wrapper catches and turns it into `die(msg, 2)`.

**What I learned (the gotcha):** the convention is **opt-in per harness**. `store_core`'s
loop honored `expected_error`, but `status_core.test.js` / `test_status_core.py` and
`close_core`'s loops did **not** — they only did `deepEqual`. Adding an `expected_error`
case to a harness that ignores the flag gives a *false green* (it tries `deepEqual(undefined, undefined)`-ish nonsense or silently skips). I had to extend each loop to branch on
`c.expected_error` before the cases would actually guard anything.

**The rule:** **Pure parsers throw on bad input and the wrapper maps the throw to a
`die`; encode bad-input cases as `expected_error` fixtures — but first confirm the
target harness's loop actually honors the flag, or the case is a no-op.**

---

## 3. Test impure seams by injecting canned data — never by mocking

**What happened:** Three seams needed coverage without shelling out: `grepMarkers`
(runs `git grep`), `listWorktrees` (runs `git worktree list --porcelain`), and
`fetchTitle` (calls `gh`). I gave the first two an **injectable raw-output arg**
(`grepMarkers(ignorePatterns, rawOut = null)` → use `rawOut` if provided, else run
git) and tested them with canned strings. `fetchTitle` got an **injectable provider**
(`fetchTitle(ticket, provider = null)`), tested with a tiny stand-in object
`{ issueTitle: () => 'x' }` and a throwing one. For the gh-JSON parsing inside the
provider I extracted **pure** `parseIssueStateRow(out, n)` / `parseIssueListRows(out)`
and tested those with canned `gh --json` payloads.

**What I learned:** injecting *data* (a string, a 3-line fake object) keeps the test
on real behavior — the real parser, the real filter — without a mock framework. The
fake provider is a stand-in, not a mock: no call-count assertions, no behavior
verification on the double. The discipline maps cleanly to the existing pure/impure
split — extract the decision, feed it canned input.

**The rule:** **To test an impure function, add an optional injected-input/dependency
param (defaulting to the real call) or extract a pure parser, and feed canned data —
a stand-in object beats a mock, and a string beats a stubbed subprocess.**

---

## 4. A spike's cheapest first move is to probe the tool itself

**What happened:** #86 was a design spike whose first open question was "does `gh`
even expose the blocked-by relation?" Instead of theorizing, one command answered it:
`gh issue view <N> --json blockedBy` returns `{"blockedBy":{"nodes":[],"totalCount":0}}`.
And `gh issue view --json` with no value **lists every available field** (`blockedBy`,
`blocking`, `parent`, `subIssues`, …). That single probe collapsed half the spike and
let me rule that `blockedBy` rides the *existing* `state,labels` lookup as one extra
field — zero new gh calls.

**What I learned:** the remaining unknown (open-vs-closed blocker semantics — `totalCount`
doesn't distinguish) was worth *naming and deferring* rather than chasing, since
shipping `totalCount > 0` is correct for the common case. A spike's job is to convert
unknowns into either a pinned decision or a named, bounded deferral.

**The rule:** **Before designing around a tool's capability, probe it (`--json` with no
value lists fields); convert each unknown into a pinned decision or an explicitly named
deferral.**

---

## 5. `pmtools close` failure modes — the ones that cost me time

This step bit me three distinct ways in one session; all are recoverable once you know
the shape.

**(a) It lands an existing close commit — it does not author one.** First `close 88`
died with *"No unpushed commit references Closes #N."* The fix is to put `Closes #N` in
the commit message yourself (I `--amend`ed it in). close verifies + rebases + pushes;
it never writes the close ref for you.

**(b) Marker-check false positive on coincidental issue numbers.** `close 88` then
refused: *"puzzle marker for #88 still present"* — but the hits were
`fixtures/claim/apply_marker_flip.cases.json` and a `py/claim_core.py` comment that
literally use `@todo #88` as **illustrative test data** (a case proving a note-style
marker is *not* flipped). There was never a real puzzle marker for my ticket — `claim`
had said "no @todo #88 marker found." That's exactly the case the guard names: pass
`--skip-marker-check`. The tell that it's a false positive: the hits are in fixtures /
comments / other tickets' data, and `claim` reported no marker at claim time.

**(c) Parallel landing mid-close → rebase + RE-RUN THE FULL SUITE before retrying.**
Between claiming #88 and closing it, another agent landed `refactor(store)` and
`refactor(close)` on `origin/main`; my `close` aborted partway (issue still OPEN,
worktree + claim ref still present). Recovery: `git fetch`, `git rebase origin/main`
(clean, since #88 didn't touch those files), then **`run-tests.sh` again** to catch any
*semantic* interaction the textual rebase can't — only then retry close. (One of the
parallel commits was `error/velocity` store dedup, conceptually adjacent to my own #46
store dedup; tests being green is the only real proof they didn't undo each other.)

**(d) The post-close `getcwd` error is not a failure.** A successful close removes the
worktree, which *was* the shell's cwd, so the next command prints
`getcwd: cannot access parent directories` and a non-zero exit. The close already said
`CLOSE OK`; just `cd` back to the main checkout.

**The rule:** **`close` lands a commit you authored with `Closes #N`; a marker-check hit
in fixtures/comments is a false positive (verify `claim` found no marker, then
`--skip-marker-check`); after a parallel landing, rebase AND re-run the full suite
before retrying; and treat the post-close `getcwd` noise as cosmetic.**

---

## 6. The "for testing" export that no test imports is a smell — promote and dedup

**What happened:** #46's premise was that wrappers exported pure seams "for testing"
that **no test imported** — false testability. Chasing it down, `error.js`/`velocity.js`
(and their py twins) each carried a byte-identical `parseArgs` and `resolveCsv`: **four
copies** of the same logic. Promoting them into one `store_core.parseStoreArgs` /
`resolveCsv` both fixed the testability gap and deleted the duplication the gap had
been hiding. The JS `preflight` had the mirror problem: the pure functions lived inline
in the impure file and `preflight_core.test.js` imported the *wrapper*, so the "core"
test tested no core — Python already had the `preflight_core.py` split.

**What I learned:** an unused "exported for testing" surface is a reliable signal of two
defects at once — missing tests *and* duplication/asymmetry that the missing tests let
drift. Fixing the test usually means extracting/relocating the seam, which is also the
move that pulls the tangled-together concerns apart.

**The rule:** **An "exported for testing" symbol that no test imports means both the test
and the right seam are missing — promote the logic to the shared pure core, point the
test at the core, and the duplication usually collapses out with it.**

---

## What landed

| Artifact | Change |
|---|---|
| `js/store_core.js`, `py/store_core.py` | Promoted shared `parseStoreArgs` + `resolveCsv` out of 4 duplicated copies (#46) |
| `js/close_core.js`, `py/close_core.py` | Promoted `parseReleaseArgs` (#46) |
| `js/status_core.js`, `py/status_core.py` | Promoted `parseArgs` (branchPattern→null); extended `isBlocked(labels, blockedByCount)` (#46/#87) |
| `js/preflight_core.js` | Extracted (twin of py), re-exported by `preflight.js`; test now targets the core (#46) |
| `fixtures/{error,velocity,release,status}/parse_args*.cases.json` | New shared parseArgs/resolveCsv fixtures, both ports (#46) |
| `js/provider.{js,py}` | `parseIssueStateRow` + `blockedBy` field; `listIssuesByLabel` + `parseIssueListRows` (#87/#88) |
| `js/reconcile.{js,py}` | Thread `blockedByCount`; append synthetic `BLOCKED` rows for marker-less blocked issues (#87/#88) |
| `js/status.{js,py}` | `renderTable` `(no marker)` + `BLOCKED` glyph (no doubled ⛔ blocked-marker); `main` fetches the blocked set (#88) |
| `#84` | Split into thin tracker + spike #86 + children #87/#88 (persona council); all closed |

## Open threads

- **Open-vs-closed blocker semantics** (deferred from #86): the overlay uses
  `blockedBy.totalCount`, which counts links regardless of blocker state. Open-only
  would need `blockedBy.nodes[].state`. No ticket yet — file one if a stale closed
  blocker ever shows a false ⛔ (blocked) marker.
- **Authority path:** these rules currently live only here. The cross-port-fixture and
  `expected_error` conventions would be worth a short note in `CONTRACT.md`'s testing
  section so they outlive the session (this repo has no `RULES.md`).
- **Bash glob gotcha (minor):** editing a GitHub checklist with
  `${body/- [ ] #87/- [x] #87}` silently no-ops — `[ ]` is a glob character class, not a
  literal. Use a real string replace (I fell back to `python3`).

## Related artifacts

- Issues #46, #84, #86, #87, #88
- [TIL 2026-06-24 GRAPE](./today-i-learned-2026-06-24-grape.md) — twin-port: default-on-PATH bug location; generic harness reads consumer rules
- [TIL 2026-06-25 GRAPE](./today-i-learned-2026-06-25-grape.md) — commit→rebase→full-suite before landing on a shared clone
