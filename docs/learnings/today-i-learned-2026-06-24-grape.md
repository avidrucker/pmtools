# TIL 2026-06-24 — GRAPE

**Context:** A session driving the pmtools side of the lccjs→pmtools PM-tooling
migration. Shipped five tickets — #10 (store dedup-gate), #5 (close velocity-row
guard), #15 (status marker-flood fix), #16 (configurable PDD toggle), #14
(dogfood config) — each as faithful `py`/`js` twins, landed by PR and pulled to
PATH before signalling the lccjs side. Two lessons earned their keep.

---

## 1. In a twin-port tool, the *default port on PATH* decides where a bug is load-bearing

**What happened:** Issue #10 was filed from the lccjs side and described the bug
in `js/store.js` — `connect()` ran a `CREATE UNIQUE INDEX … uq_velocity_session`
on every write, which throws against a legacy DB holding duplicate velocity rows
and takes down *all* logging. The obvious read was "fix the JS twin." But pmtools
ships two ports behind one dispatcher, and `bin/pmtools` resolves the port as:

```bash
port="${PMTOOLS_PORT:-py}"     # default is py, NOT js
```

So the engine that actually runs when a consumer types `pmtools …` on PATH is the
**Python** twin. Fixing only `js/store.js` would have left every real invocation
broken while every test I might have eyeballed looked fine. I caught it by reading
the dispatcher before writing code, then fixed *both* twins for parity and ran the
end-to-end repro through `bin/pmtools` (default port) rather than `node js/...`.

**What I learned:** "The issue says `js/store.js`" is a statement about where the
reporter was *looking*, not where the fix is *load-bearing*. The reporter saw the
bug from the lccjs side and named the file they'd been reading; the default-port
resolution is invisible from there. The dispatcher's two-line default is the whole
ballgame, and it lives nowhere near the code the ticket points at.

**The rule:** **In a multi-port / multi-impl tool, find which implementation is the
default on PATH *before* deciding where a bug lives — and fix every twin for
parity regardless of which one the ticket names.**

---

## 2. A generic harness must read the consumer's own rules, not bake them in

**What happened:** Issue #15 — `pmtools status` flagged ~103 markers against lccjs
where the curated scanner finds 1, because it grepped bare `@(todo|inprogress)` in
every tracked file. The fastest "fix" was sitting right there in lccjs's own
scanner: a hard-coded `if (file.startsWith('tests/') && file.endsWith('.spec.js'))
continue;`. Copy that line into `status.js` and the lccjs flood drops. Tempting,
and wrong: pmtools is a *generic, multi-repo* harness, and `tests/**/*.spec.js` is
**lccjs's** convention, not a universal truth. Baking it in would couple the shared
tool to one client and silently mis-serve the next.

The decomplected fix was two generic mechanisms instead of one specific path:
require the canonical PDD grammar `@(todo|inprogress) #N:<estimate>` (the estimate
makes prose mentions non-actionable), and honor the repo's own `.pddignore`
(gitignore-style globs). lccjs already ships a `.pddignore` listing
`tests/**/*.spec.js`, `docs/**`, `*.md`, … — so its flood vanished with **zero**
lccjs-specific code in pmtools. Verified read-only against the real tree: 103 → 1.

**What I learned:** When a candidate fix names a *specific consumer's* path,
directory, or filename, that's the tell it belongs in the wrong layer. The generic
tool's job is to provide a mechanism (grammar + an ignore-file protocol); the
consumer supplies the policy (its `.pddignore`). The same instinct shaped #16
(a `pdd.enabled` toggle and configurable `ignoreFile`, defaulting to preserve
existing behavior) rather than assuming every repo wants PDD scanning.

**The rule:** **If a fix in a shared/generic component hard-codes a specific
consumer's name or path, stop — push the policy out to consumer-supplied config
(a dotfile, a config key) and keep the component's logic about mechanism only.**

---

## What landed

| Ticket | Change |
|---|---|
| #10 | `store.connect()` dedup-gates `uq_velocity_session` (skip + warn) so a legacy DB stays loggable — both twins; default port is `py` |
| #5 | `close` re-integrates a config-gated, DB-based velocity-row guard (Check A + Guard 1) |
| #15 | `status` filters to canonical `#N:<estimate>` grammar + honors `.pddignore` (new `status_core` seams) |
| #16 | `pdd` config block toggles the marker scan; ships `.pddignore.example` |
| #14 | tracked `.claude/orchestrate.json` + `.pddignore` so pmtools dogfoods its own stores + guard |

## Open threads

- Cross-repo signalling worked because I only ever posted "landed + pulled to PATH
  (commit X)" *after* `git pull` on the live checkout — a PR merged on GitHub but
  not pulled means the consumer tests stale code. Worth making that an explicit
  hand-off rule somewhere durable.
- The dogfood DB path derives from the git-toplevel basename, so a *worktree*
  resolves `~/.pmtools/<worktree-dir>/…` rather than `~/.pmtools/pmtools/…`. Harmless
  for the committed CSV mirror, but a latent surprise if anyone expects one DB.

## Related artifacts

- Issues #10, #5, #15, #16, #14 · PRs #11, #12, #18, #19, #21
- lccjs-side complaints: lccjs#1453, #1456, #1457, #1458
