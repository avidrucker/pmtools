#!/usr/bin/env bash
# integration.sh — exercise the impure claim/status/preflight CLIs (py + js)
# against throwaway git repos. No network: `origin` is a local BARE repo so the
# cross-clone claim-ref push to refs/claims/* actually works; `gh` is either
# absent (guards degrade to best-effort) or a controllable fake on PATH.
#
# Run directly:  bash tests/integration.sh
set -u

PMTOOLS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY_CLAIM="$PMTOOLS_ROOT/py/claim.py"
JS_CLAIM="$PMTOOLS_ROOT/js/claim.js"
PY_STATUS="$PMTOOLS_ROOT/py/status.py"
JS_STATUS="$PMTOOLS_ROOT/js/status.js"
PY_PREFLIGHT="$PMTOOLS_ROOT/py/preflight.py"
JS_PREFLIGHT="$PMTOOLS_ROOT/js/preflight.js"
PY_CLOSE="$PMTOOLS_ROOT/py/close.py"
JS_CLOSE="$PMTOOLS_ROOT/js/close.js"
PY_RELEASE="$PMTOOLS_ROOT/py/release.py"
JS_RELEASE="$PMTOOLS_ROOT/js/release.js"
PY_ERROR="$PMTOOLS_ROOT/py/error.py"
PY_VELOCITY="$PMTOOLS_ROOT/py/velocity.py"
JS_ERROR="$PMTOOLS_ROOT/js/error.js"
JS_VELOCITY="$PMTOOLS_ROOT/js/velocity.js"

FAILS=0
PASSES=0
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/pmtools-it.XXXXXX")"
trap 'rm -rf "$TMPROOT"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  ok   - $1"; }
fail() { FAILS=$((FAILS + 1)); echo "  FAIL - $1"; }

# assert_contains <haystack-file> <needle> <label>
assert_contains() {
  if grep -qF -- "$2" "$1"; then pass "$3"; else
    fail "$3 (expected to find: $2)"; echo "      --- output ---"; sed 's/^/      /' "$1"; fi
}
assert_exit() { # <actual> <expected> <label>
  if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (exit $1, expected $2)"; fi
}
assert_no_branch() { # <repo> <branch> <label>
  if git -C "$1" show-ref --verify --quiet "refs/heads/$2"; then
    fail "$3 (branch $2 still exists)"; else pass "$3"; fi
}
assert_dir() { # <path> <label>
  if [ -d "$1" ]; then pass "$2"; else fail "$2 (missing dir $1)"; fi
}

# Build a fresh environment: bare origin + a clone with an initial main commit.
# Echoes the clone path on stdout.
new_env() {
  local d="$TMPROOT/env.$RANDOM.$RANDOM"
  mkdir -p "$d"
  git init -q --bare "$d/origin.git"
  git clone -q "$d/origin.git" "$d/work" 2>/dev/null
  (
    cd "$d/work"
    git config user.email tester@example.com
    git config user.name tester
    git config commit.gpgsign false
    printf 'init\n' > README.md
    git add README.md
    git commit -qm "initial commit"
    git push -q origin HEAD:main
    git checkout -q -B main
  )
  echo "$d/work"
}

# Make a fake `gh` available on PATH that returns a chosen issue JSON. The fake
# repo's first positional after `issue view` is the issue number; we ignore it
# and serve a fixed fixture. Echoes a PATH prefix dir.
make_fake_gh() { # <state> <labels-json-array>
  local d="$TMPROOT/fakegh.$RANDOM"
  mkdir -p "$d"
  cat > "$d/gh" <<EOF
#!/usr/bin/env bash
# Minimal fake gh for integration tests.
state="$1"
labels='$2'
case "\$*" in
  *"issue view"*"-q .state"*) echo "\$state" ;;
  *"issue view"*"-q .title"*) echo "Test issue widget keyword" ;;
  *"issue view"*"--json"*) printf '{"number":1,"title":"Test issue","state":"%s","body":"b","comments":[],"labels":%s}\n' "\$state" "\$labels" ;;
  *"issue close"*) echo "closed" ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$d/gh"
  echo "$d"
}

# A fake gh whose issue title shares the keyword "widget" with the close commit
# subject (so Guard 2 keyword-overlap passes), reporting a chosen state.
make_fake_gh_titled() { # <state> <title>
  local d="$TMPROOT/fakeghT.$RANDOM"
  mkdir -p "$d"
  cat > "$d/gh" <<EOF
#!/usr/bin/env bash
state="$1"
title="$2"
case "\$*" in
  *"issue view"*"-q .state"*) echo "\$state" ;;
  *"issue view"*"-q .title"*) echo "\$title" ;;
  *"issue view"*"--json"*) printf '{"number":1,"title":"%s","state":"%s","body":"b","comments":[],"labels":[]}\n' "\$title" "\$state" ;;
  *"issue close"*) echo "closed" ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$d/gh"
  echo "$d"
}

echo "== pmtools integration: claim/status/preflight (py + js) =="

# ---------------------------------------------------------------------------
# Run the full claim assertion battery for one runner (py or js).
# ---------------------------------------------------------------------------
run_claim_suite() {
  local lang="$1"; shift
  local -a RUN=("$@")   # e.g. python3 /path/claim.py
  echo "-- [$lang] claim battery --"

  # 2) dry-run: WOULD CLAIM + agent: apple, no worktree, exit 0
  local repo; repo="$(new_env)"
  local o="$TMPROOT/out.$RANDOM"
  ( cd "$repo" && "${RUN[@]}" 5 --as apple --dry-run --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] dry-run exit 0"
  assert_contains "$o" "WOULD CLAIM" "[$lang] dry-run says WOULD CLAIM"
  assert_contains "$o" "agent: apple" "[$lang] dry-run names agent apple"
  if [ -d "$repo/.claude/worktrees/apple-issue-5" ]; then
    fail "[$lang] dry-run created no worktree"; else pass "[$lang] dry-run created no worktree"; fi

  # 3) real claim: branch apple/issue-5, worktree under default dir, refs/claims/issue-5
  ( cd "$repo" && "${RUN[@]}" 5 --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] real claim exit 0"
  assert_contains "$o" "CLAIMED" "[$lang] real claim says CLAIMED"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/apple/issue-5"; then
    pass "[$lang] branch apple/issue-5 created"; else fail "[$lang] branch apple/issue-5 created"; fi
  assert_dir "$repo/.claude/worktrees/apple-issue-5" "[$lang] worktree under default .claude/worktrees"
  if git -C "$repo" ls-remote origin 'refs/claims/*' | grep -q "refs/claims/issue-5"; then
    pass "[$lang] refs/claims/issue-5 staked on origin"; else fail "[$lang] refs/claims/issue-5 staked on origin"; fi

  # 4) second claim same issue, different agent -> exit 1, rolled back (no banana branch)
  ( cd "$repo" && "${RUN[@]}" 5 --as banana --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] same-issue second claim exits 1"
  assert_no_branch "$repo" "banana/issue-5" "[$lang] banana/issue-5 rolled back / never left"

  # 5) --worktree-dir parameterization: lands under wt/apple-issue-8
  local repo2; repo2="$(new_env)"
  ( cd "$repo2" && "${RUN[@]}" 8 --as apple --worktree-dir wt --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] --worktree-dir claim exit 0"
  assert_dir "$repo2/wt/apple-issue-8" "[$lang] worktree landed under wt/apple-issue-8"
  if [ -d "$repo2/.claude/worktrees/apple-issue-8" ]; then
    fail "[$lang] default worktree dir NOT used"; else pass "[$lang] default worktree dir NOT used"; fi

  # Lane gate OFF by default: with a fake gh reporting an issue that has NO
  # area:* label, a plain claim still succeeds (the inversion).
  local repo3; repo3="$(new_env)"
  local ghdir; ghdir="$(make_fake_gh OPEN '[]')"
  ( cd "$repo3" && PATH="$ghdir:$PATH" "${RUN[@]}" 11 --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] lane gate OFF by default: unlabeled issue claims"
  assert_contains "$o" "CLAIMED" "[$lang] lane gate OFF: CLAIMED with no area label"

  # Lane gate ON via --lane-check: same unlabeled issue is now BLOCKED (exit 1).
  local repo4; repo4="$(new_env)"
  ( cd "$repo4" && PATH="$ghdir:$PATH" "${RUN[@]}" 12 --as apple --lane-check --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] --lane-check ON: unlabeled issue blocked"
  assert_contains "$o" "area:" "[$lang] --lane-check ON: blocks with area-label hint"
  assert_no_branch "$repo4" "apple/issue-12" "[$lang] --lane-check ON: no branch staked"

  # Lane gate ON but issue HAS a real area label -> proceeds.
  local repo5; repo5="$(new_env)"
  local ghdir2; ghdir2="$(make_fake_gh OPEN '[{"name":"area:core"}]')"
  ( cd "$repo5" && PATH="$ghdir2:$PATH" "${RUN[@]}" 13 --as apple --lane-check --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] --lane-check ON + real area label: claims"

  # CLOSED guard: fake gh says CLOSED -> blocked unless --force.
  local repo6; repo6="$(new_env)"
  local ghclosed; ghclosed="$(make_fake_gh CLOSED '[]')"
  ( cd "$repo6" && PATH="$ghclosed:$PATH" "${RUN[@]}" 14 --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] CLOSED issue blocked"
  ( cd "$repo6" && PATH="$ghclosed:$PATH" "${RUN[@]}" 14 --as apple --force --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] CLOSED issue claimable with --force"
}

run_claim_suite "py" python3 "$PY_CLAIM"
run_claim_suite "js" node "$JS_CLAIM"

# ---------------------------------------------------------------------------
# close battery for one runner: claim → commit a real `Closes #N` in the
# worktree → close → assert it landed on origin/main, the worktree+branch are
# gone, and refs/claims/issue-N was deleted on origin. Hermetic: local bare
# origin + fake gh on PATH (title shares the "widget" keyword with the subject).
# ---------------------------------------------------------------------------
run_close_suite() {
  # args: <lang> <claim-interp> <claim-script> <close-interp> <close-script>
  local lang="$1" ci="$2" cs="$3" oi="$4" os="$5"
  local -a CLAIM=("$ci" "$cs")
  local -a CLOSE=("$oi" "$os")
  echo "-- [$lang] close battery --"

  local repo; repo="$(new_env)"
  local o="$TMPROOT/closeout.$RANDOM"
  local gh; gh="$(make_fake_gh_titled OPEN 'Fix the widget renderer')"
  local N=21

  # 1) claim the issue as apple (fake gh OPEN; share keyword via the title).
  ( cd "$repo" && PATH="$gh:$PATH" "${CLAIM[@]}" "$N" --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] close: claim $N as apple exit 0"
  local wt="$repo/.claude/worktrees/apple-issue-$N"
  assert_dir "$wt" "[$lang] close: worktree staked"

  # 2) in the worktree, make a trivial source change + commit with a subject that
  #    shares the keyword "widget" with the fake issue title, body `Closes #N`.
  (
    cd "$wt"
    git config user.email tester@example.com
    git config user.name tester
    git config commit.gpgsign false
    printf 'widget impl\n' > widget.txt
    git add widget.txt
    git commit -qm "feat: add widget renderer" -m "Closes #$N"
  )

  # 3) close it. From the main checkout, pass --branch so close chdirs into the wt.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "apple/issue-$N" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] close: exit 0"
  assert_contains "$o" "CLOSED" "[$lang] close: prints CLOSED banner"

  # 4) the commit is on origin/main (check the bare origin's main ref directly).
  if git --git-dir="$(dirname "$repo")/origin.git" log main --format=%s 2>/dev/null | grep -q "add widget renderer"; then
    pass "[$lang] close: commit landed on origin/main"
  else
    fail "[$lang] close: commit landed on origin/main"; sed 's/^/      /' "$o"
  fi

  # 5) the worktree dir is gone and the branch is deleted.
  if [ -d "$wt" ]; then fail "[$lang] close: worktree removed"; else pass "[$lang] close: worktree removed"; fi
  assert_no_branch "$repo" "apple/issue-$N" "[$lang] close: branch apple/issue-$N deleted"

  # 6) refs/claims/issue-N was deleted on origin.
  if git -C "$repo" ls-remote origin 'refs/claims/*' 2>/dev/null | grep -q "refs/claims/issue-$N"; then
    fail "[$lang] close: refs/claims/issue-$N deleted on origin (still present)"
  else
    pass "[$lang] close: refs/claims/issue-$N deleted on origin"
  fi
}

run_close_suite "py" python3 "$PY_CLAIM" python3 "$PY_CLOSE"
run_close_suite "js" node "$JS_CLAIM" node "$JS_CLOSE"

# ---------------------------------------------------------------------------
# close velocity-row guard (#5): config-gated. With storage.velocity ENABLED,
# `close` refuses (exit 1) when the DB holds no velocity row for the ticket, and
# proceeds once one is logged. With velocity DISABLED, the guard no-ops (no false
# block). SQLite is the source of truth — the guard reads the DB, not the CSV.
# ---------------------------------------------------------------------------
run_close_velocity_suite() {
  # args: <lang> <claim-i> <claim-s> <close-i> <close-s> <vel-i> <vel-s>
  local lang="$1" ci="$2" cs="$3" oi="$4" os="$5" vi="$6" vs="$7"
  local -a CLAIM=("$ci" "$cs") CLOSE=("$oi" "$os") VEL=("$vi" "$vs")
  echo "-- [$lang] close velocity-row guard battery --"

  local o="$TMPROOT/closevel.$RANDOM"
  local gh; gh="$(make_fake_gh_titled OPEN 'Fix the widget renderer')"

  # === Env 1: velocity ENABLED ===
  local repo; repo="$(new_env)"
  local N=31
  local DB="$TMPROOT/vel.$lang.$N.db"
  ( cd "$repo" && PATH="$gh:$PATH" "${CLAIM[@]}" "$N" --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] vel-guard: claim $N exit 0"
  local wt="$repo/.claude/worktrees/apple-issue-$N"

  # Commit a tracked orchestrate.json that ENABLES velocity (DB outside the tree
  # so the .db never dirties the worktree) + the keyword-sharing close commit.
  (
    cd "$wt"
    git config user.email tester@example.com; git config user.name tester
    git config commit.gpgsign false
    mkdir -p .claude
    printf '{ "storage": { "dbPath": "%s", "velocity": { "enabled": true }, "errors": { "enabled": true } } }\n' "$DB" > .claude/orchestrate.json
    printf 'widget impl\n' > widget.txt
    git add .claude/orchestrate.json widget.txt
    git commit -qm "feat: add widget renderer" -m "Closes #$N"
  )

  # Materialise the DB with an EMPTY velocity table (so the guard sees "no row",
  # not "DB absent → skip"). `velocity export` seeds the schema via connect().
  ( cd "$wt" && "${VEL[@]}" export --db-path "$DB" --csv "$DB.csv" ) >/dev/null 2>&1

  # 1) ENABLED + no velocity row for N → close must die exit 1, NOT land.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "apple/issue-$N" ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] vel-guard: enabled + no row → close exits 1"
  assert_contains "$o" "velocity" "[$lang] vel-guard: blocks with a velocity-row message"
  assert_dir "$wt" "[$lang] vel-guard: worktree left intact after block"
  if git --git-dir="$(dirname "$repo")/origin.git" log main --format=%s 2>/dev/null | grep -q "add widget renderer"; then
    fail "[$lang] vel-guard: blocked close did NOT land on origin/main"
  else
    pass "[$lang] vel-guard: blocked close did NOT land on origin/main"
  fi

  # 2) log a matching velocity row for N → close now proceeds, lands, tears down.
  ( cd "$wt" && "${VEL[@]}" log \
      "{\"ticket\":$N,\"role\":\"DEV\",\"agent\":\"apple\",\"started_iso\":\"2026-01-01T00:00:00-1000\"}" \
      --db-path "$DB" --no-csv ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] vel-guard: velocity log (matching row) exit 0"
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "apple/issue-$N" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] vel-guard: matching row → close exits 0"
  assert_contains "$o" "CLOSED" "[$lang] vel-guard: prints CLOSED banner"
  if [ -d "$wt" ]; then fail "[$lang] vel-guard: worktree removed after success"; else pass "[$lang] vel-guard: worktree removed after success"; fi

  # === Env 2: velocity DISABLED → guard skipped (no false block) ===
  local repo2; repo2="$(new_env)"
  local M=32
  ( cd "$repo2" && PATH="$gh:$PATH" "${CLAIM[@]}" "$M" --as apple --allow-stale-main ) >"$o" 2>&1
  local wt2="$repo2/.claude/worktrees/apple-issue-$M"
  (
    cd "$wt2"
    git config user.email tester@example.com; git config user.name tester
    git config commit.gpgsign false
    mkdir -p .claude
    printf '{ "storage": { "velocity": { "enabled": false } } }\n' > .claude/orchestrate.json
    printf 'widget impl\n' > widget.txt
    git add .claude/orchestrate.json widget.txt
    git commit -qm "feat: add widget renderer" -m "Closes #$M"
  )
  # No velocity row logged anywhere; disabled config must NOT block the close.
  ( cd "$repo2" && PATH="$gh:$PATH" "${CLOSE[@]}" "$M" --branch "apple/issue-$M" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] vel-guard: disabled + no row → close exits 0 (skipped)"
  assert_contains "$o" "CLOSED" "[$lang] vel-guard: disabled close prints CLOSED"
}

run_close_velocity_suite "py" python3 "$PY_CLAIM" python3 "$PY_CLOSE" python3 "$PY_VELOCITY"
run_close_velocity_suite "js" node "$JS_CLAIM" node "$JS_CLOSE" node "$JS_VELOCITY"

# ---------------------------------------------------------------------------
# release battery (#22): claim → release frees the claim ref + worktree while the
# issue stays OPEN. Data-loss guard refuses unpushed commits without --force; an
# orphan claim (no worktree) is a clean no-op teardown.
# ---------------------------------------------------------------------------
run_release_suite() {
  local lang="$1" ci="$2" cs="$3" ri="$4" rs="$5"
  local -a CLAIM=("$ci" "$cs") RELEASE=("$ri" "$rs")
  echo "-- [$lang] release battery --"
  local repo; repo="$(new_env)"
  local gh; gh="$(make_fake_gh OPEN '[]')"
  local o="$TMPROOT/relout.$RANDOM"

  # 1) claim 41 as apple → worktree staked + claim ref on origin.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLAIM[@]}" 41 --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] release: claim 41 exit 0"
  local wt="$repo/.claude/worktrees/apple-issue-41"
  assert_dir "$wt" "[$lang] release: worktree staked"

  # 2) clean release → tears down; issue stays OPEN (never calls provider close).
  ( cd "$repo" && PATH="$gh:$PATH" "${RELEASE[@]}" 41 ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] release: clean release exit 0"
  assert_contains "$o" "stays OPEN" "[$lang] release: says issue stays OPEN"
  if [ -d "$wt" ]; then fail "[$lang] release: worktree removed"; else pass "[$lang] release: worktree removed"; fi
  assert_no_branch "$repo" "apple/issue-41" "[$lang] release: branch deleted"
  if git -C "$repo" ls-remote origin 'refs/claims/*' 2>/dev/null | grep -q "refs/claims/issue-41"; then
    fail "[$lang] release: claim ref deleted on origin (still present)"
  else
    pass "[$lang] release: claim ref deleted on origin"
  fi

  # 3) data-loss guard: an UNPUSHED commit blocks release without --force.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLAIM[@]}" 42 --as apple --allow-stale-main ) >"$o" 2>&1
  local wt2="$repo/.claude/worktrees/apple-issue-42"
  ( cd "$wt2"
    git config user.email tester@example.com; git config user.name tester; git config commit.gpgsign false
    printf 'work\n' > work.txt && git add work.txt && git commit -qm "wip: unpushed work" )
  ( cd "$repo" && PATH="$gh:$PATH" "${RELEASE[@]}" 42 ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] release: unpushed commit blocks (exit 1)"
  assert_contains "$o" "NOT on origin/main" "[$lang] release: explains the blocked commit"
  assert_dir "$wt2" "[$lang] release: blocked release leaves worktree intact"
  # 3b) --force discards + tears down.
  ( cd "$repo" && PATH="$gh:$PATH" "${RELEASE[@]}" 42 --force ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] release: --force exit 0"
  if [ -d "$wt2" ]; then fail "[$lang] release: --force tore down worktree"; else pass "[$lang] release: --force tore down worktree"; fi

  # 4) orphan: release a number with no worktree → clean no-op.
  ( cd "$repo" && PATH="$gh:$PATH" "${RELEASE[@]}" 777 ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] release: orphan (no worktree) exit 0"
  assert_contains "$o" "nothing to tear down" "[$lang] release: orphan says nothing to tear down"
}
run_release_suite "py" python3 "$PY_CLAIM" python3 "$PY_RELEASE"
run_release_suite "js" node "$JS_CLAIM" node "$JS_RELEASE"

# ---------------------------------------------------------------------------
# 6) Smoke: status --json valid JSON; preflight runs without crashing.
# ---------------------------------------------------------------------------
echo "-- smoke: status / preflight --"
smoke_repo="$(new_env)"
o="$TMPROOT/out.smoke"

# stdout-only capture: status may emit a one-line pdd warning to stderr (no
# .pddignore here), and --json output on stdout must stay pure JSON.
( cd "$smoke_repo" && python3 "$PY_STATUS" --json ) >"$o" 2>/dev/null
assert_exit "$?" 0 "[py] status --json exit 0"
if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$o" 2>/dev/null; then
  pass "[py] status --json emits valid JSON"; else fail "[py] status --json emits valid JSON"; fi

( cd "$smoke_repo" && node "$JS_STATUS" --json ) >"$o" 2>/dev/null
assert_exit "$?" 0 "[js] status --json exit 0"
if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$o" 2>/dev/null; then
  pass "[js] status --json emits valid JSON"; else fail "[js] status --json emits valid JSON"; fi

# ---------------------------------------------------------------------------
# 6b) status canonical-grammar + .pddignore (#15): only a canonical, non-ignored
# `@(todo|inprogress) #N:<estimate>` marker is actionable. Proves BOTH layers:
# estimate-less prose is dropped by grammar; a canonical marker in a .pddignore'd
# spec file is dropped by the ignore layer; the one real code-site marker stays.
# ---------------------------------------------------------------------------
run_status_pdd_suite() {
  local lang="$1"; shift; local -a RUN=("$@")
  echo "-- [$lang] status canonical + .pddignore battery --"
  local repo; repo="$(new_env)"
  (
    cd "$repo"
    mkdir -p src tests docs
    printf '// @todo #252:30m implement the real thing\n' > src/real.js
    printf 'prose: @todo #208 see comments for context\n' > CLAUDE.md
    printf "it('scans', () => expect(run('@todo #9102:15m')).toBe(1));\n" > tests/x.spec.js
    printf '@inprogress #143 doc note about markers\n' > docs/note.md
    printf 'tests/**/*.spec.js\ndocs/**\n*.md\n' > .pddignore
    git add -A && git commit -qm "seed markers + .pddignore"
  )
  local oo="$TMPROOT/statuspdd.$lang.$RANDOM"
  # stdout-only (status may warn to stderr); --json must stay pure JSON.
  local extract='import json,sys; d=json.load(open(sys.argv[1])); print(" ".join(str(m["issue"]) for m in d["markers"]))'

  # (1) pdd defaults ON (no orchestrate.json): only the canonical, non-ignored #252.
  ( cd "$repo" && "${RUN[@]}" --json ) >"$oo" 2>/dev/null
  assert_exit "$?" 0 "[$lang] status (pdd default-on) --json exit 0"
  local issues; issues="$(python3 -c "$extract" "$oo" 2>/dev/null)"
  if [ "$issues" = "252" ]; then
    pass "[$lang] status: default-on → only canonical non-ignored #252 (got: $issues)"
  else
    fail "[$lang] status: default-on expected #252, got: [$issues]"; sed 's/^/      /' "$oo"
  fi

  # (2) pdd.enabled=false → marker scan suppressed entirely (0 markers).
  ( cd "$repo" && mkdir -p .claude
    printf '{ "pdd": { "enabled": false } }\n' > .claude/orchestrate.json
    git add -A && git commit -qm "disable pdd" ) >/dev/null 2>&1
  ( cd "$repo" && "${RUN[@]}" --json ) >"$oo" 2>/dev/null
  assert_exit "$?" 0 "[$lang] status (pdd off) --json exit 0"
  issues="$(python3 -c "$extract" "$oo" 2>/dev/null)"
  if [ -z "$issues" ]; then
    pass "[$lang] status: pdd.enabled=false → no markers scanned (skipped)"
  else
    fail "[$lang] status: pdd off expected 0 markers, got: [$issues]"; sed 's/^/      /' "$oo"
  fi

  # (3) flip pdd.enabled=true → marker scan returns (#252 again).
  ( cd "$repo"
    printf '{ "pdd": { "enabled": true } }\n' > .claude/orchestrate.json
    git add -A && git commit -qm "enable pdd" ) >/dev/null 2>&1
  ( cd "$repo" && "${RUN[@]}" --json ) >"$oo" 2>/dev/null
  issues="$(python3 -c "$extract" "$oo" 2>/dev/null)"
  if [ "$issues" = "252" ]; then
    pass "[$lang] status: pdd.enabled=true → marker scan restored (got: $issues)"
  else
    fail "[$lang] status: pdd on expected #252, got: [$issues]"; sed 's/^/      /' "$oo"
  fi
}
run_status_pdd_suite "py" python3 "$PY_STATUS"
run_status_pdd_suite "js" node "$JS_STATUS"

# preflight: offline gh (no fake) -> warn-and-proceed (exit 0). Confine scratch
# to the temp tree so we don't touch ~/.pmtools.
( cd "$smoke_repo" && python3 "$PY_PREFLIGHT" 5 --scratch-dir "$TMPROOT/scratch-py" ) >"$o" 2>&1
rc=$?
if [ "$rc" = "0" ] || [ "$rc" = "1" ]; then pass "[py] preflight runs without crashing (exit $rc)"; else
  fail "[py] preflight crashed (exit $rc)"; sed 's/^/      /' "$o"; fi
assert_contains "$o" "PREFLIGHT" "[py] preflight prints banner"

( cd "$smoke_repo" && node "$JS_PREFLIGHT" 5 --scratch-dir "$TMPROOT/scratch-js" ) >"$o" 2>&1
rc=$?
if [ "$rc" = "0" ] || [ "$rc" = "1" ]; then pass "[js] preflight runs without crashing (exit $rc)"; else
  fail "[js] preflight crashed (exit $rc)"; sed 's/^/      /' "$o"; fi
assert_contains "$o" "PREFLIGHT" "[js] preflight prints banner"

# preflight with a fake gh reporting OPEN -> OPEN gate passes (exit 0).
ghopen="$(make_fake_gh OPEN '[]')"
( cd "$smoke_repo" && PATH="$ghopen:$PATH" python3 "$PY_PREFLIGHT" 5 --scratch-dir "$TMPROOT/scratch-py2" ) >"$o" 2>&1
assert_exit "$?" 0 "[py] preflight OPEN gate passes with gh=OPEN"

# ---------------------------------------------------------------------------
# storage battery for one runner (py | js): error/velocity stores against a temp
# repo whose .claude/orchestrate.json enables errors with a csvMirror and leaves
# velocity disabled. SQLite is the source of truth; CSV is a derived mirror. Uses
# the sqlite3 CLI for DB assertions. Confine the DB to the temp tree via
# --db-path so we never touch ~/.pmtools.
#
# args: <lang> <error-interp> <error-script> <velocity-interp> <velocity-script>
# ---------------------------------------------------------------------------
run_storage_suite() {
  local lang="$1" ei="$2" es="$3" vi="$4" vs="$5"
  local -a ERR=("$ei" "$es")
  local -a VEL=("$vi" "$vs")
  echo "-- [$lang] storage battery (error / velocity) --"

  # A repo with errors ENABLED + csvMirror, velocity DISABLED.
  local store_repo; store_repo="$(new_env)"
  mkdir -p "$store_repo/.claude"
  cat > "$store_repo/.claude/orchestrate.json" <<'EOF'
{ "storage": {
    "dbPath": null,
    "errors":   { "enabled": true,  "csvMirror": "docs/errors.csv" },
    "velocity": { "enabled": false }
} }
EOF
  local STORE_DB="$store_repo/pmtools-test.db"
  local STORE_CSV="$store_repo/docs/errors.csv"
  local o="$TMPROOT/store.$RANDOM"

  # 1) errors enabled: a valid row lands in the DB AND the CSV mirror is written.
  ( cd "$store_repo" && "${ERR[@]}" log \
      '{"occurred_iso":"2026-06-23T10:00:00-1000","agent":"apple","model":"opus-4.8","ticket":3,"error_type":"CLAIM_FAIL","message":"could not claim","context":{"issue":3}}' \
      --db-path "$STORE_DB" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] error log (enabled) exit 0"
  assert_contains "$o" "Inserted error row" "[$lang] error log prints inserted-row line"
  if [ "$(sqlite3 "$STORE_DB" 'SELECT count(*) FROM errors;' 2>/dev/null)" = "1" ]; then
    pass "[$lang] error row landed in sqlite (count == 1)"
  else
    fail "[$lang] error row landed in sqlite (count == 1)"; sed 's/^/      /' "$o"
  fi
  if [ -f "$STORE_CSV" ]; then pass "[$lang] csv mirror file exists"; else fail "[$lang] csv mirror file exists"; fi
  # header line present
  assert_contains "$STORE_CSV" "id,occurred_iso,agent,model,ticket,repo,error_type,message,context,notes" "[$lang] csv mirror has the header row"
  assert_contains "$STORE_CSV" "AUTO-GENERATED" "[$lang] csv mirror has the AUTO-GENERATED preamble"
  # exactly 1 data row = total 3 lines (preamble + header + 1 row)
  if [ "$(wc -l < "$STORE_CSV")" = "3" ]; then pass "[$lang] csv mirror has exactly 1 data row"; else
    fail "[$lang] csv mirror has exactly 1 data row"; sed 's/^/      /' "$STORE_CSV"; fi

  # 2) errors disabled: a config with errors disabled refuses with the notice,
  #    exits 0, and inserts nothing.
  local dis_repo; dis_repo="$(new_env)"
  mkdir -p "$dis_repo/.claude"
  cat > "$dis_repo/.claude/orchestrate.json" <<'EOF'
{ "storage": { "errors": { "enabled": false } } }
EOF
  local DIS_DB="$dis_repo/pmtools-test.db"
  ( cd "$dis_repo" && "${ERR[@]}" log \
      '{"occurred_iso":"i","message":"m"}' --db-path "$DIS_DB" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] error log (disabled) exit 0"
  assert_contains "$o" "errors store disabled for this project" "[$lang] error log (disabled) prints the disabled notice"
  if [ -f "$DIS_DB" ]; then
    fail "[$lang] error log (disabled) inserted nothing (no DB created)"
  else
    pass "[$lang] error log (disabled) inserted nothing (no DB created)"
  fi

  # 3) velocity disabled by default: refuses with the disabled notice, exit 0.
  ( cd "$store_repo" && "${VEL[@]}" log \
      '{"role":"DEV","agent":"apple"}' --db-path "$STORE_DB" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] velocity log (disabled by default) exit 0"
  assert_contains "$o" "velocity store disabled for this project" "[$lang] velocity log prints the disabled notice"
  if [ "$(sqlite3 "$STORE_DB" 'SELECT count(*) FROM velocity;' 2>/dev/null)" = "0" ]; then
    pass "[$lang] velocity disabled: no row inserted (count == 0)"
  else
    fail "[$lang] velocity disabled: no row inserted (count == 0)"
  fi

  # 4) error log re-export: `error export` rewrites the CSV from the DB on demand.
  ( cd "$store_repo" && "${ERR[@]}" export --db-path "$STORE_DB" --csv "$STORE_CSV" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] error export exit 0"
  assert_contains "$o" "Exported 1 rows" "[$lang] error export re-exports the single row"
}

run_storage_suite "py" python3 "$PY_ERROR" python3 "$PY_VELOCITY"
run_storage_suite "js" node "$JS_ERROR" node "$JS_VELOCITY"

# ---------------------------------------------------------------------------
# cross-port parity: the SAME error row logged via py and via js must produce an
# identical sqlite row AND identical CSV bytes (modulo the db filename embedded
# in the preamble's Source: line). This is the whole point of the JS port.
# ---------------------------------------------------------------------------
echo "-- cross-port parity (py vs js: identical DB row + CSV bytes) --"
xp_repo="$(new_env)"
mkdir -p "$xp_repo/.claude"
cat > "$xp_repo/.claude/orchestrate.json" <<'EOF'
{ "storage": { "errors": { "enabled": true } } }
EOF
XP_ROW='{"occurred_iso":"2026-06-23T10:00:00-1000","agent":"apple","model":"opus-4.8","ticket":7,"repo":"pmtools","error_type":"DB_FAIL","message":"weird, message \"q\"","context":{"a":1,"b":[2,3]},"notes":"n"}'
XP_PY_DB="$xp_repo/xp-py.db";  XP_JS_DB="$xp_repo/xp-js.db"
XP_PY_CSV="$xp_repo/xp-py.csv"; XP_JS_CSV="$xp_repo/xp-js.csv"
xo="$TMPROOT/xp.$RANDOM"

( cd "$xp_repo" && python3 "$PY_ERROR" log "$XP_ROW" --db-path "$XP_PY_DB" --csv "$XP_PY_CSV" ) >"$xo" 2>&1
( cd "$xp_repo" && node    "$JS_ERROR" log "$XP_ROW" --db-path "$XP_JS_DB" --csv "$XP_JS_CSV" ) >>"$xo" 2>&1

if diff <(sqlite3 -json "$XP_PY_DB" 'SELECT * FROM errors ORDER BY id') \
        <(sqlite3 -json "$XP_JS_DB" 'SELECT * FROM errors ORDER BY id') >/dev/null 2>&1; then
  pass "cross-port: py and js produce an identical sqlite row"
else
  fail "cross-port: py and js produce an identical sqlite row"; sed 's/^/      /' "$xo"
fi
# Compare CSV bytes after neutralising the per-port db filename in the preamble.
if diff <(sed "s#${XP_PY_DB##*/}#DB#" "$XP_PY_CSV") \
        <(sed "s#${XP_JS_DB##*/}#DB#" "$XP_JS_CSV") >/dev/null 2>&1; then
  pass "cross-port: py and js produce identical CSV bytes (modulo db filename)"
else
  fail "cross-port: py and js produce identical CSV bytes (modulo db filename)"
  diff <(sed "s#${XP_PY_DB##*/}#DB#" "$XP_PY_CSV") <(sed "s#${XP_JS_DB##*/}#DB#" "$XP_JS_CSV") | sed 's/^/      /'
fi

echo
echo "== integration: $PASSES passed, $FAILS failed =="
[ "$FAILS" -eq 0 ]
