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
PY_ERROR="$PMTOOLS_ROOT/py/error.py"
PY_VELOCITY="$PMTOOLS_ROOT/py/velocity.py"

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
# 6) Smoke: status --json valid JSON; preflight runs without crashing.
# ---------------------------------------------------------------------------
echo "-- smoke: status / preflight --"
smoke_repo="$(new_env)"
o="$TMPROOT/out.smoke"

( cd "$smoke_repo" && python3 "$PY_STATUS" --json ) >"$o" 2>&1
assert_exit "$?" 0 "[py] status --json exit 0"
if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$o" 2>/dev/null; then
  pass "[py] status --json emits valid JSON"; else fail "[py] status --json emits valid JSON"; fi

( cd "$smoke_repo" && node "$JS_STATUS" --json ) >"$o" 2>&1
assert_exit "$?" 0 "[js] status --json exit 0"
if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$o" 2>/dev/null; then
  pass "[js] status --json emits valid JSON"; else fail "[js] status --json emits valid JSON"; fi

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
# storage battery (Python): error/velocity stores against a temp repo whose
# .claude/orchestrate.json enables errors with a csvMirror and leaves velocity
# disabled. SQLite is source of truth; CSV is a derived mirror. Uses the sqlite3
# CLI for DB assertions. Confine the DB to the temp tree via --db-path so we
# never touch ~/.pmtools.
# ---------------------------------------------------------------------------
echo "-- [py] storage battery (error / velocity) --"

# A repo with errors ENABLED + csvMirror, velocity DISABLED.
store_repo="$(new_env)"
mkdir -p "$store_repo/.claude"
cat > "$store_repo/.claude/orchestrate.json" <<'EOF'
{ "storage": {
    "dbPath": null,
    "errors":   { "enabled": true,  "csvMirror": "docs/errors.csv" },
    "velocity": { "enabled": false }
} }
EOF
STORE_DB="$store_repo/pmtools-test.db"
STORE_CSV="$store_repo/docs/errors.csv"
o="$TMPROOT/store.$RANDOM"

# 1) errors enabled: a valid row lands in the DB AND the CSV mirror is written.
( cd "$store_repo" && python3 "$PY_ERROR" log \
    '{"occurred_iso":"2026-06-23T10:00:00-1000","agent":"apple","model":"opus-4.8","ticket":3,"error_type":"CLAIM_FAIL","message":"could not claim","context":{"issue":3}}' \
    --db-path "$STORE_DB" ) >"$o" 2>&1
assert_exit "$?" 0 "[py] error log (enabled) exit 0"
assert_contains "$o" "Inserted error row" "[py] error log prints inserted-row line"
if [ "$(sqlite3 "$STORE_DB" 'SELECT count(*) FROM errors;' 2>/dev/null)" = "1" ]; then
  pass "[py] error row landed in sqlite (count == 1)"
else
  fail "[py] error row landed in sqlite (count == 1)"; sed 's/^/      /' "$o"
fi
if [ -f "$STORE_CSV" ]; then pass "[py] csv mirror file exists"; else fail "[py] csv mirror file exists"; fi
# header line present
assert_contains "$STORE_CSV" "id,occurred_iso,agent,model,ticket,repo,error_type,message,context,notes" "[py] csv mirror has the header row"
assert_contains "$STORE_CSV" "AUTO-GENERATED" "[py] csv mirror has the AUTO-GENERATED preamble"
# exactly 1 data row = total 3 lines (preamble + header + 1 row)
if [ "$(wc -l < "$STORE_CSV")" = "3" ]; then pass "[py] csv mirror has exactly 1 data row"; else
  fail "[py] csv mirror has exactly 1 data row"; sed 's/^/      /' "$STORE_CSV"; fi

# 2) errors disabled: a config with errors disabled refuses with the notice,
#    exits 0, and inserts nothing.
dis_repo="$(new_env)"
mkdir -p "$dis_repo/.claude"
cat > "$dis_repo/.claude/orchestrate.json" <<'EOF'
{ "storage": { "errors": { "enabled": false } } }
EOF
DIS_DB="$dis_repo/pmtools-test.db"
( cd "$dis_repo" && python3 "$PY_ERROR" log \
    '{"occurred_iso":"i","message":"m"}' --db-path "$DIS_DB" ) >"$o" 2>&1
assert_exit "$?" 0 "[py] error log (disabled) exit 0"
assert_contains "$o" "errors store disabled for this project" "[py] error log (disabled) prints the disabled notice"
if [ -f "$DIS_DB" ]; then
  fail "[py] error log (disabled) inserted nothing (no DB created)"
else
  pass "[py] error log (disabled) inserted nothing (no DB created)"
fi

# 3) velocity disabled by default: refuses with the disabled notice, exit 0.
( cd "$store_repo" && python3 "$PY_VELOCITY" log \
    '{"role":"DEV","agent":"apple"}' --db-path "$STORE_DB" ) >"$o" 2>&1
assert_exit "$?" 0 "[py] velocity log (disabled by default) exit 0"
assert_contains "$o" "velocity store disabled for this project" "[py] velocity log prints the disabled notice"
if [ "$(sqlite3 "$STORE_DB" 'SELECT count(*) FROM velocity;' 2>/dev/null)" = "0" ]; then
  pass "[py] velocity disabled: no row inserted (count == 0)"
else
  fail "[py] velocity disabled: no row inserted (count == 0)"
fi

# 4) error log re-export: `error export` rewrites the CSV from the DB on demand.
( cd "$store_repo" && python3 "$PY_ERROR" export --db-path "$STORE_DB" --csv "$STORE_CSV" ) >"$o" 2>&1
assert_exit "$?" 0 "[py] error export exit 0"
assert_contains "$o" "Exported 1 rows" "[py] error export re-exports the single row"

echo
echo "== integration: $PASSES passed, $FAILS failed =="
[ "$FAILS" -eq 0 ]
