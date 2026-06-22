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
| `claim` | fleet-only | js (Python deferred) |
| `preflight` | fleet-only | js (Python deferred) |

## Use from a project

Clone this repo and point your project's `.claude/orchestrate.json` at it:

```json
{ "pmtools": { "home": "~/code/pmtools", "port": "py" } }
```

The skill derives the enrichment commands as `<home>/<port>/<tool>`. lccjs keeps
thin `npm run` shims for back-compat (see its `enrichment.*Command`).

## Run the tests

```bash
python3 -m unittest discover -s py   # Python port vs fixtures (stdlib only, no pip install)
node --test js                       # Node port vs the SAME fixtures
```

Both ports consume `fixtures/*.input.json` and must produce `fixtures/*.expected.json`.

## Parity rule

A behavior change = edit `CONTRACT.md` + a fixture, then make **every** port
green. Never change one port's behavior without the contract and the others.
