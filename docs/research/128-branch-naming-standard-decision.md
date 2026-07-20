# #128 decision — one branch/worktree name format: `standard`

**Status:** DECIDED (architect ruling, 2026-07-19). Implemented by #131 (code) + #132 (docs).
**Supersedes:** #127 (per-project override) — closed won't-do.

## The question

#127 proposed letting each project override its branch/worktree name shape in
`orchestrate.json`, and offered two designs for the override:

1. an invertible template pmtools compiles to both a formatter and a parser, or
2. a template plus a user-supplied parse pattern that pmtools trusts and coherence-checks.

#128 was filed to pick between them before #127 implemented anything.

## The decision

**Neither.** The override mechanism is rejected as YAGNI: the only divergence that has ever
existed is two shapes (legacy vs canonical), and no project needs an arbitrary shape today.
A per-project lever — template compiler or user-authored regex — buys open-endedness nobody
asked for, and doubles the cross-language surface (every function is twinned in
`py/claim_core.py` and `js/claim_core.js`).

Instead: **one format for every project that uses pmtools, called `standard`.**

### `standard`

| | Shape | Example |
|---|---|---|
| Branch   | `br-<agent>/<project>-<N>[-<slug>]` | `br-guava/pmtools-128-choose-branch` |
| Worktree | `wt-<agent>-<project>-<N>`           | `wt-guava-pmtools-128` |

Dropped from the old canonical shape: the `<lang>` tag (`py`/`unk`) and the literal `issue-`
token — both judged noise, not signal. Kept: the `br-`/`wt-` prefix, agent, project, issue
number, and the optional branch-only slug.

### Migration: tolerant parse, `standard`-only generate

- **Generate:** `claim` only ever mints `standard`.
- **Parse:** the CANONICAL regexes keep reading **all** prior shapes — old canonical
  (`-<lang>-issue-<N>`) and legacy (`<fruit>/issue-N`) — so every branch/worktree open at
  switch time (including this decision's own `br-guava/pmtools-unk-issue-128-…` worktree)
  stays closeable. Old-format names die out naturally as their work closes; there is no
  flag-day and nothing is stranded.

### Round-trip invariant

`standard` parses back unambiguously **as long as project names stay single dash-free
`[a-z0-9]+` tokens** — already assumed by today's regex (`pmtools`, `pycats`, `lccjs` all
qualify). A project name containing a dash was never supported and still isn't.

## Rejected alternatives

- **Per-project override, either design (#127).** YAGNI; open-endedness nobody needs; double
  cross-language cost.
- **Hard-cut migration** (only `standard`, no tolerant read). Cleaner long-term but strands
  every in-flight branch at switch time. Rejected in favor of tolerant parsing.
- **Keeping the `<lang>` tag / `issue-` token.** Judged noise by the human owner.

## Follow-up work

- **#131** — DEV: adopt `standard` in `py/` + `js/` generators; broaden the tolerant parsers;
  fixtures.
- **#132** — DOCS: document `standard` as the sole format; remove the dead
  `worktreeBranchPattern` note (`CONTRACT.md:112`).
- **Consumer adoption** (lccjs, pycats): downstream, tracked in their own repos — not filed here.
