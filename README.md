# pmtools

Centralized, project-agnostic project-management helpers for the
`fruit-agent-orchestrate` skill — one behavioral contract, per-language ports.

- **`CONTRACT.md`** — the language-neutral source of truth (commands, I/O, exit codes).
- **`fixtures/`** — golden cases every port is graded against (keeps ports in lockstep).
- **`py/`** — Python port.
- **`js/`** — Node port.
- `bb/` — Babashka/Clojure port (later, on demand).

## Commands

| Command | Tier | Ports |
|---|---|---|
| `status` | solo-relevant | py + js |
| `preflight` | fleet-only | py + js |
| `claim` | fleet-only | py + js (lccjs-isms parameterized: `--worktree-dir`, `--roster`, `--lane-check` (off by default), `--copy-env`) |
| `close` | fleet-only | py + js (racy push loop + gated teardown; `--worktree-dir` parameterized; **config-gated velocity-row guard** (#5); learnings/tracker guards omitted) |
| `release` | fleet-only | py + js (abandon a claim + tear down its worktree, issue stays OPEN; data-loss guard refuses unpushed/dirty without `--force`) |
| `error` | storage | py + js (js drives the `sqlite3` CLI; cross-port parity green) |
| `velocity` | storage | py + js (js drives the `sqlite3` CLI; cross-port parity green) |

`error` / `velocity` are a configurable SQLite-primary storage layer (SQLite is
the source of truth; CSV is a derived mirror). Per-store, per-project config via
the `.claude/orchestrate.json` `storage` block — see CONTRACT.md §storage.

`status` only flags **canonical** PDD markers (`@(todo|inprogress) #N:<estimate>`)
and honors a repo-root `.pddignore` (gitignore-style globs; copy
`.pddignore.example`). Scanning is toggled by the `pdd` block (`pdd.enabled`,
default true) — see CONTRACT.md §status.

### Dogfooding

pmtools eats its own dog food: this repo ships a tracked `.claude/orchestrate.json`
that **enables both stores** (errors + velocity; the SQLite DB lives out-of-tree
at `~/.pmtools/<repo>/`, CSV mirrors regenerated under `docs/` but **gitignored** —
derived from the DB, never tracked, #68) and a `.pddignore`
that keeps `pmtools status` on this tree clean (fixtures/tests carry marker-like
test data, not real puzzles). **Because velocity is enabled, `pmtools close` here
requires a velocity row for the ticket** (the config-gated guard from #5) — log
your session first, or pass `--skip-velocity-check` for PM/triage closes.

```bash
pmtools error log '{"occurred_iso":"2026-06-23T10:00:00-1000","error_type":"CLAIM_FAIL","message":"could not claim","ticket":3}'
pmtools velocity log '{"role":"DEV","agent":"apple","ticket":3,"h_min":30,"actual_min":25}'
```

## Install (one-time) — `pmtools` on PATH

Clone this repo **anywhere**, then put the self-locating dispatcher on your PATH:

```bash
./install.sh                 # symlinks bin/pmtools -> ~/.local/bin/pmtools
# or pick another PATH dir:  ./install.sh /usr/local/bin
```

`bin/pmtools` resolves its **own** clone root (following the symlink), so the clone
can live anywhere and you never hardcode its path. Now from any cwd:

```bash
pmtools status --json
pmtools claim 42 --as apple
pmtools preflight 42
pmtools close 42                  # from the MAIN checkout, after committing `Closes #42`
                                  #   (worktree resolves from the issue #; also works from
                                  #   inside the worktree, but from-main never strands the shell)
pmtools status --port js          # force the Node port (default: py)
```

> `close` lands **trunk-based** — it pushes the close commit straight to
> `origin/main` (like lccjs's `npm run close`). If your `main` is push-protected
> (branch protection / a push-gating harness), that push is rejected and `close`
> exits with your work safe and local; land via a PR by hand instead. See
> CONTRACT.md §close "Landing model" for the recipe.

- Clone root: `$PMTOOLS_HOME` if set, else self-resolved from the dispatcher's location.
- Port: `--port py|js` > `$PMTOOLS_PORT` > `py`.

## Use from a project

Once `pmtools` is on PATH, a project's `.claude/orchestrate.json` needs **no path** —
point enrichment at the dispatcher:

```json
{ "enrichment": {
    "statusCommand": "pmtools status",
    "claimCommand": "pmtools claim",
    "preflightCommand": "pmtools preflight"
} }
```

(If you don't install on PATH, the skill still derives `<pmtools.home>/<port>/<tool>`
from config, and lccjs keeps thin `npm run` shims — but PATH install is the
zero-hardcoded-path option.)

## Run the tests

```bash
./run-tests.sh                       # all stages: py unittest + node:test + integration
```

`run-tests.sh` runs four stages and exits non-zero if any fails:

```bash
python3 -m unittest discover -s py   # 1. Python port vs fixtures (stdlib only, no pip install)
node --test 'js/*.test.js'           # 2. Node port vs the SAME fixtures
bash tests/integration.sh            # 3. impure claim/status/preflight/close/release CLIs (py + js) vs temp git repos
bash tests/dispatcher.sh             # 4. the public bin/pmtools router (port resolution, exit codes)
```

The pure ports are graded against shared golden cases —
`fixtures/<command>/*.cases.json`, each a `{name, args, expected}` case; a few
status-reconcile edge fixtures use the older `fixtures/*.input.json` →
`fixtures/*.expected.json` form. The integration stage exercises the impure CLIs
(real `git worktree add`, real `refs/claims/*` push to a local bare `origin`,
lane-gate on/off, CLOSED guard, `--worktree-dir` parameterization) against
throwaway repos.

## Parity rule

A behavior change = edit `CONTRACT.md` + a fixture, then make **every** port
green. Never change one port's behavior without the contract and the others.
