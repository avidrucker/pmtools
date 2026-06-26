# Learnings (TIL)

Session retrospectives — non-obvious lessons captured per working session. One
file per session under `today-i-learned-YYYY-MM-DD-<agent>.md`; index below in
chronological order.

| Doc | Date | Agent | Themes |
|---|---|---|---|
| [TIL 2026-06-24 GRAPE](./today-i-learned-2026-06-24-grape.md) | 2026-06-24 | GRAPE | Twin-port tools: the default port on PATH decides where a bug is load-bearing; a generic harness must read consumer rules (`.pddignore`) rather than hard-code a consumer's paths. |
| [TIL 2026-06-25 GRAPE](./today-i-learned-2026-06-25-grape.md) | 2026-06-25 | GRAPE | Reversing a convention means flipping its code AND its assertions in one commit; "same serializer" isn't byte-parity until you check defaults (`ensure_ascii`); on a clone shared by concurrent agents, commit→rebase→FULL-suite before landing; check a repo's own history before "fixing" config that looks wrong; a "no integration tests" constraint redirects TDD to pure-seam fixtures + out-of-tree smokes. |
