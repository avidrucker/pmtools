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

## Use from a project

Clone this repo and point your project's `.claude/orchestrate.json` at it:

```json
{ "pmtools": { "home": "~/code/pmtools", "port": "py" } }
```

The skill derives the enrichment commands as `<home>/<port>/<tool>`. lccjs keeps
thin `npm run` shims for back-compat (see its `enrichment.*Command`).

## Run the tests

```bash
./run-tests.sh                       # all stages: py unittest + node:test + integration
```

`run-tests.sh` runs three stages and exits non-zero if any fails:

```bash
python3 -m unittest discover -s py   # 1. Python port vs fixtures (stdlib only, no pip install)
node --test 'js/*.test.js'           # 2. Node port vs the SAME fixtures
bash tests/integration.sh            # 3. impure claim/status/preflight CLIs (py + js) vs temp git repos
```

The pure ports consume `fixtures/*.input.json` and must produce
`fixtures/*.expected.json`. The integration stage exercises the impure CLIs
(real `git worktree add`, real `refs/claims/*` push to a local bare `origin`,
lane-gate on/off, CLOSED guard, `--worktree-dir` parameterization) against
throwaway repos.

## Parity rule

A behavior change = edit `CONTRACT.md` + a fixture, then make **every** port
green. Never change one port's behavior without the contract and the others.
