# Learnings (TIL)

Session retrospectives — non-obvious lessons captured per working session. One
file per session under `today-i-learned-YYYY-MM-DD-<agent>.md`; index below in
chronological order.

| Doc | Date | Agent | Themes |
|---|---|---|---|
| [TIL 2026-06-24 GRAPE](./today-i-learned-2026-06-24-grape.md) | 2026-06-24 | GRAPE | Twin-port tools: the default port on PATH decides where a bug is load-bearing; a generic harness must read consumer rules (`.pddignore`) rather than hard-code a consumer's paths. |
| [TIL 2026-06-25 GRAPE](./today-i-learned-2026-06-25-grape.md) | 2026-06-25 | GRAPE | Reversing a convention means flipping its code AND its assertions in one commit; "same serializer" isn't byte-parity until you check defaults (`ensure_ascii`); on a clone shared by concurrent agents, commit→rebase→FULL-suite before landing; check a repo's own history before "fixing" config that looks wrong; a "no integration tests" constraint redirects TDD to pure-seam fixtures + out-of-tree smokes. |
| [TIL 2026-06-26 APPLE](./today-i-learned-2026-06-26-apple.md) | 2026-06-26 | APPLE | Verify the prescribed fix already exists before coding (#8 close exit-1 didn't reproduce); grep the suite for the behavior before adding a regression test (the fixture already existed at integration.sh:300); a bug you can't reproduce through the supported flow is a divergence, not a `bug` (#82 `--force`); separate the process exit code from the caller shell's getcwd noise; run the yegor persona panel to reject before you commit. |
| [TIL 2026-06-28 BANANA](./today-i-learned-2026-06-28-banana.md) | 2026-06-28 | BANANA | A spike that recommends DEFER must prove zero live consumers (#80 LOCKED); a brief's "held/blocked" claim is a hint, the tracker is truth (#78 was already closed); ticket readiness ≠ availability — collision-check reserved worktrees and scope around the contested file (#30 vs grape/#46); `pmtools close` is worktree teardown, so claim first; "write clearly" is unenforceable without a committed term glossary ruling each term APPROVED/APPROVED-WITH-GLOSS/DENIED (#89/#90). |
