# RULES

These rules bind **every agent on every task** in the pmtools repo, whatever the work is
(code, docs, research, or project-management). They are re-read constantly, so this file
is kept lean on purpose.

**Inclusion criterion:** a rule earns a spot here only if violating it on a *random* task
is both plausible and harmful — universal **safety** (don't destroy the repo or the
database, don't leak PII) and universal **workflow integrity** (worktree, scope, ticket,
close protocol). Task-type-specific technical guidance does not belong here.

**pmtools is self-hosting.** This repo builds the very lifecycle tool it uses to claim,
close, and track its own work. So the `pmtools …` commands below govern work *on pmtools
itself*. One consequence: if a change breaks `claim` / `close` / `velocity` / `error`, the
tool you close with may be the thing under repair — **stop and ask the human how to
proceed, and get an explicit OK before improvising any `gh`/`git` workaround.** Do not
route around a broken tool on your own initiative.

**Rule IDs** are the stable `A1`, `B2`, … stems in the left of each rule. Cite a rule by
its ID; the IDs are hand-maintained and are not renumbered when the list is trimmed.

---

## A. Safety

- **A1 — No `rm`/`rmSync` on the main branch without explicit permission.**
- **A2 — Never delete the main branch or the project folder, ever, no matter what.**
- **A3 — No deleting data from the database without explicit human permission.**
- **A4 — Never post PII in an issue, comment, or commit** — email addresses, credentials,
  API keys/tokens, passwords, phone numbers, or anything that uniquely identifies a real
  person. These channels are public and permanently indexed. Use bracketed placeholders
  (`[your email]`). Offline repo artifacts may carry real attribution; inline
  issue/comment/commit text never does.
- **A5 — Adding a dependency needs explicit human approval — propose, don't install.**
  Any way of pulling in undeclared code is gated (`pip install`, manifest/lockfile edits,
  `npm`, `apt`). *Using* a declared dep and *suggesting* a library are fine; the gate is
  on installing.

## B. Worktree & close discipline

- **B1 — Always work in a worktree, no matter what** — including TIL docs, velocity/error
  logging, and PM-only tickets. Any git commit to this repo must come from a worktree.
  There are no small-enough exceptions.
- **B2 — Always close via `pmtools close <N>`; never `git push` directly to main** and
  never hand-merge a feature branch into main. `close` owns the race-safe push and the
  gated worktree teardown; a hand-typed push-then-teardown can destroy still-local work.
  *Carve-out — see B10.*
- **B3 — Every worktree is tied to an open GitHub issue.** If none exists, file one (with
  consent) before claiming.
- **B4 — Always log a velocity row before the closing commit.** Velocity is enabled here,
  so `pmtools close` blocks without one:
  `pmtools velocity log '{"role":"DEV","agent":"<name>","ticket":N,"h_min":<est>,"actual_min":<A>}'`.
- **B5 — Run a pre-close error self-audit.** Re-read the session from claim to now,
  enumerate every loggable error, log any missing ones (`pmtools error log '<json>'`), and
  state the outcome in the closing comment (`error self-audit: N row(s) logged` or
  `error self-audit: no loggable errors this session`).
- **B6 — One deliverable per close.** Before the close commit, audit `git diff origin/main`:
  every change must fall within the ticket's stated *should-have*. Out-of-scope changes
  get their own ticket, worktree, and velocity row.
- **B7 — Deferred or found work becomes a ticket before the closing commit.** Any scope
  deferred, bug found, or design question opened during the work is filed as a ticket; the
  closing comment cites the ticket number(s) instead of describing the work in prose.
- **B8 — Run the full test suite right after claim, before changing anything.** A fresh
  worktree branches off whatever main is right now; confirm green first. If it's red, the
  failure is not yours — fix main (or merge in the fix) before building, so you never
  attribute a pre-existing failure to your change or ship on a broken baseline.
- **B9 — No-code / research tickets close differently.** A ticket with no `Closes #N`
  commit (research, comment-only) is closed with `gh issue close <N>` after posting the
  finding, then `pmtools release <N>` to drop the claim ref + worktree. Never fabricate a
  no-op commit just to satisfy `pmtools close`.
- **B10 — Explicit-authorization carve-out for a direct merge + push.** When a human, in
  the current session, explicitly authorizes a direct merge + push for a specific change, a
  direct `git merge` + `git push origin main` is permitted — the authorizing human owns the
  race. Attended, in-session work only; the change still ships with the suite green and the
  B5 error self-audit done, and a hand-close still cleans up its `refs/claims/issue-N` (via
  `pmtools release` or deleting the ref). Absent an explicit in-session go-ahead, route
  through `pmtools close`.

## C. Scope & authorization

- **C1 — Do only work you were scoped/authorized to do.** For a question or concern, file
  a ticket rather than acting on it.
- **C2 — "Did the user ask for THIS?"** A question is not an instruction — answer it, and
  act only on an explicit imperative. A path named in a request is a *referent*, not an
  order to read it: open it only if the literal task needs its contents.
- **C3 — No unprompted research.** When asked for a specific action, do exactly that.
  Resolving the minimal input the action strictly needs (e.g. reading the one file you're
  about to edit) is fine; open-ended investigation ("let me check how X works") is not —
  ask first and wait for a yes.
- **C4 — Suggest, don't act.** When asked for a narrow action, do only that action and
  stop. Name adjacent work as a suggestion; do not perform it without a go-ahead. Approval
  for one action is not approval for the next. (Mirrors the machine-global rule.)

## D. Filing & tickets

- **D1 — Search existing issues with `--state all` before filing.** Closed-completed work
  is invisible to an open-only search and produces duplicate tickets.
- **D2 — Shape every ticket as a complaint: have X / should have Y / repro.**
- **D3 — Repro/spec-first for unclear bugs.** If a symptom isn't specific enough to write
  have/should/repro, file a `research` ticket to reproduce/spec it first, then create the
  DEV ticket once the repro is known. Never file a half-specified DEV ticket.
- **D4 — Verify a delegated/audit finding — or a user-reported symptom — in the code
  before filing or acting on it.** A subagent's finding, an audit's claim, or a user's
  "X is broken" is a *lead, not a fact*. Open the named `file:function` and confirm it
  before turning it into a ticket or an outward-facing change.
- **D5 — Reconcile a worktree-found failure against current `origin/main` before filing.**
  Claim guarantees a fresh base *at claim time*, but a long-lived worktree drifts behind as
  others merge. `git fetch origin main` and confirm the failure still reproduces on current
  `origin/main`, not just your (possibly stale) base.
- **D6 — Verify a ticket's identity before stating it; mint IDs/refs one at a time.**
  Never state a ticket's number/title until confirmed from a real lookup (the `gh issue
  create` return URL, or `gh issue view <N>`) — never inferred from filing order. Never run
  ID/ref-minting mutations (`gh issue create`, `pmtools claim`) concurrently: file/claim
  one, confirm the returned identifier, then do the next. Read-only calls may still run in
  parallel.
- **D7 — Lazy decomposition for research epics.** A multi-thread investigation gets ONE
  umbrella `research` tracker listing the threads; file each child thread one at a time,
  finishing it before filing the next sibling.
- **D8 — Every `research` ticket produces ≥1 findings doc; follow-ups are optional.** A
  `research` ticket closes only when it has written one or more durable findings docs (e.g.
  `docs/research/<topic>-findings.md`); a bare issue comment is not sufficient, and the
  closing comment links the doc(s). Follow-up tickets are optional and filed downstream,
  one at a time.
- **D9 — Don't claim a >60-minute ticket without decomposing it into ≤60-minute
  children.** The parent then becomes an umbrella tracker, worked only through its children
  and earning no velocity row of its own. A human may explicitly approve taking it whole,
  noted in the ticket.
- **D10 — Gate a large/fuzzy ticket behind a `spike` ≤60 minutes before filing impl
  tickets or claiming it.** The spike produces scope, code sites, and ROI. A human may
  explicitly approve proceeding without a spike, noted in the ticket.
- **D11 — Never claim or work an epic/tracker as a unit of work** — only its bounded child
  tickets are claimed and worked; the epic stays open until its children resolve and earns
  no velocity row of its own.
- **D12 — Claim + read the available evidence before forming or publishing findings.**
  Read `docs/` logs and prior `docs/research/` first; don't act before gathering the
  evidence the task depends on.
- **D13 — Verify a prescribed fix is correct before applying it.** A ticket's prescribed
  fix can be wrong even when the bug it describes is real. If the fix would break another
  path, surface the design fork to the human rather than silently choosing.

## E. Labels

- **E1 — `severity:*` is for defects only.** Features/enhancements carry `enhancement` and
  no `severity:*`; they rank below triaged bugs by design (fix what's broken first).
- **E2 — `blocked` encodes real dependencies.** Prefer it over faking severity to express
  ordering.
- **E3 — Every ticket gets exactly one real `area:*` label; never claim a ticket lacking
  one.** A missing area (or the `area:uncategorized` placeholder) is assigned a proper lane
  first — a reversible triage act you may do yourself (`gh issue edit <N> --add-label
  "area:<name>" --remove-label area:uncategorized`) — then claimed. If a ticket genuinely
  spans two lanes, pick the dominant one and suggest a split.

## F. Live state & grounding

- **F1 — When live state contradicts the request, stop and reconcile before proceeding**
  — rather than trusting the request over the observed state.
- **F2 — Verify live state before asserting it.** Before stating any issue's OPEN/CLOSED
  state, who is in-flight, a file's contents, or test/coverage status, re-query it in the
  same turn (`gh`/`git`/Read) rather than relying on memory or a prior turn — repo state
  decays between turns in a multi-agent repo.
- **F4 — Point at named landmarks, not raw line numbers.** In any authored reference
  (ticket, comment, review, commit, doc), point at a stable landmark — a function/class
  name + file path for code, a section heading for markdown — never `file.py:73`. Line
  numbers drift and silently misdirect. Carve-outs that don't rot: commit-pinned
  permalinks and quoted tool output keep their own line numbers.

## G. Testing & bugfixes

- **G1 — Every bugfix lands a regression test in the same commit.** A fix without a test
  is not done — the test is what stops the bug from coming back and from being re-filed.
- **G2 — The test must be able to fail.** Before claiming the fix works, confirm the new
  test is red without the fix and green with it — a test that has never been red proves
  nothing.
- **G3 — An already-fixed / non-reproducing bug still owes the missing regression test.**
  If a reported bug doesn't reproduce on current main, the deliverable is the *missing*
  test (find the commit that fixed it, add the can-fail guard), not a no-op close. Surface
  the contradiction to the reporter before an outward-facing close.
