# pmtools — project instructions

Supplements the workspace file `~/Documents/Study/CLAUDE.md` (git identity, workspace
layout); it does not replace it. Project-specific guidance lives here.

## Communication style

These rules govern **answers to the human** — chat replies, PR descriptions, and issue
comments. The goal: an answer is legible on the *first* read, so the `eli5` skill is a rare
convenience rather than a routine necessity. The per-term authority is
[`docs/glossary.md`](docs/glossary.md), which rules each term **APPROVED** (use freely),
**APPROVED-WITH-GLOSS** (define on first use), or **DENIED** (use the plain alternative).

Follow these rules:

1. **Lead with the answer.** The first sentence states the conclusion or recommendation in
   plain English — before any table, scorecard, or scoring guide. A reader who wants only
   the answer should get it in sentence one.

2. **Define load-bearing terms on first use.** The first time an APPROVED-WITH-GLOSS term
   (per `docs/glossary.md`) appears in an answer, define it in one clause using the
   canonical gloss — e.g. "a worktree (a separate working copy on its own branch)". APPROVED
   terms need no gloss; reuse the gloss only once per answer.

3. **Never use a DENIED term — use its plain alternative.** "temporarily hands-off" not
   "soft-lock"; "hardcoded" not "baked in"; "STALE takes precedence" not "STALE wins"; "the
   standard marker format" not "canonical".

4. **Gloss a ticket number on first mention.** The first time an issue or PR number appears
   in an answer, add a 3–5 word gloss: "#15 (the marker-flood fix)". Don't drop a bare `#NN`
   as if the reader has the tracker open.

5. **Describe a rule; don't cite it by number.** Not "the #23 rule" — state the principle in
   words ("a shared tool must read consumer config, not hardcode a consumer's paths").

6. **Unpack noun stacks.** Break a three-or-more-noun compound into a short clause the first
   time it appears ("the LOCKED cluster soft-lock contract" → "the contract for LOCKED — when
   a clustermate in progress makes a code-area temporarily hands-off").

7. **Glyphs and codenames carry a word.** Pair any status glyph (🔒 / ⛔ / ✗) with a word;
   name a role plainly rather than by agent codename (BANANA, grape) in user-facing text.

**Term not in the glossary?** Treat it as define-on-first-use, and add it via the ruling
process in `docs/glossary.md` so the decision is recorded once, not re-guessed.

**Self-check before sending:** could a reader who does *not* have the issue tracker open
understand your first sentence? If not, rewrite it.
