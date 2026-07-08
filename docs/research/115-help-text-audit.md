# Audit #115 — pmtools `--help` / usage text: currency, correctness, thoroughness

**Role:** RESEARCH · **Author:** honeydew · **Status:** findings, no fix (follow-ups recommended below).

## Verdict

**The help text is mostly current but has one factual bug, two consumer-specific leaks, and two structural gaps.** The per-command usage strings (the `die("usage: …")` messages) are up to date — `close` carries `--no-code`, `ice` carries `set-tier`. The problems live in (1) the static dispatcher help in `bin/pmtools`, (2) the CONTRACT top command table, and (3) the *absence* of per-command `--help`. Recommended split: a **WRITER** ticket for the text (currency + correctness) and a **DEV** ticket for the two structural gaps (per-command `--help`, and status/sweep usage-on-error), because those are code, not prose.

## Surfaces audited

- **Dispatcher help** — the `HELPTEXT` heredoc in `bin/pmtools`, shown by `pmtools --help`/`-h`.
- **Per-command usage strings** — each tool's `die("usage: …", 2)`, shown on mis-invocation.
- **`--help` routing** — how `pmtools <cmd> --help` behaves.
- **CONTRACT top command table** — the summary table at the head of `CONTRACT.md`.

## Findings by axis

### 1. Currency — PARTIAL

- **Per-command usage strings: current.** `close`'s usage lists `--no-code [--comment|--comment-file|--no-comment]` and every `--skip-*`; `ice`'s main dispatch is `<score|list|export|set-tier>`. `claim`'s `--custom` is a real parsed flag (not stale). Both ports carry byte-identical usage strings (guarded by the integration parity block).
- **Dispatcher EXAMPLES: stale.** No example for `ice set-tier` (#112), `close --no-code` (#113), `release`, or `sweep`. (`file` was added when it shipped.)
- **CONTRACT top command table: stale.** The `close` row lists 9 flags; the parser has **16** — missing `--skip-velocity-check`, `--skip-verify`, `--update-trackers`, and the whole `--no-code` mode. The `ice` row shows `<score|list|export>` — missing `set-tier`. (The full `§close`/`§ice` prose sections *are* current; only the summary table drifted.)

### 2. Correctness — FAIL (one factual bug + consumer leaks)

- **Phantom config path (bug).** `bin/pmtools` CONFIG lists `~/.config/pycats/settings.json  Per-project persisted preferences`. **No pmtools code reads this file** (`grep` of `js/ py/ bin/` finds it only in the help). The tool's real config is `.claude/orchestrate.json` (`config.{js,py}`). The line is both wrong and consumer-specific (a pycats path in a shared tool) — it violates the rule that a shared harness names no consumer's paths.
- **Consumer-flavored tagline.** The banner reads "project-management helpers for the **fruit-agent** workflow". "fruit-agent" is a consumer/roster flavor, not intrinsic to the generic tool.

### 3. Thoroughness — GAP (needs code)

- **No per-command `--help`.** The dispatcher intercepts `--help`/`-h` *before* dispatch, so `pmtools ice --help` and `pmtools close --help` both print the **global** text — never the command's own subcommands/flags. The only way to see a command's flags is to mis-invoke it and read the usage error. A user cannot discover, e.g., `ice set-tier`'s `--why`/`--until` from `--help`.

### 4. Consistency — PARTIAL (needs code)

- **status and sweep don't teach their usage on a bad flag.** `pmtools status --strrict` → `[status] ✗ unknown flag: --strrict` and `pmtools sweep --bogus` → `[sweep] ✗ unknown flag: --bogus` — **no `usage:` line**. Every other command (claim, close, file, ice, preflight, release, error, velocity) prints a full `usage:` string on a bad invocation. status/sweep are the odd ones out.

## Recommended follow-ups

**(A) WRITER — help-text currency + correctness** (docs-only; the expected outcome):
- `bin/pmtools`: delete or correct the phantom `~/.config/pycats/settings.json` line (replace with `.claude/orchestrate.json`, already listed just below it — so likely just delete the phantom); degeneralize the "fruit-agent" tagline; add EXAMPLES for `ice set-tier`, `close --no-code`, `release`, `sweep`.
- `CONTRACT.md` top command table: refresh the `close` row (add the 4 missing flags + the `--no-code` mode) and the `ice` row (add `set-tier`).

**(B) DEV — help thoroughness + consistency** (code; file separately, per this ticket's scope note):
- Route per-command `--help`: `pmtools <cmd> --help` prints that command's usage (e.g. reuse its `usage:` string) instead of the global text. Decide whether the global `--help` stays the no-arg default.
- Make `status` and `sweep` emit their `usage:` string on an unknown flag, matching the other commands.

## Termination

All four surfaces audited on all four axes; verdict rendered; follow-up shape (one WRITER + one DEV) recommended. No fix applied here.
