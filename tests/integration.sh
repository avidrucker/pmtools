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
PY_ICE="$PMTOOLS_ROOT/py/ice.py"
JS_ERROR="$PMTOOLS_ROOT/js/error.js"
JS_VELOCITY="$PMTOOLS_ROOT/js/velocity.js"
JS_ICE="$PMTOOLS_ROOT/js/ice.js"

FAILS=0
PASSES=0
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/pmtools-it.XXXXXX")"
# Fail loudly rather than mkdir-ing a garbage path if mktemp produced nothing — an
# empty temp-root once let the suite write throwaway repos INTO the work tree (#20).
[ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] || {
  echo "FATAL: mktemp temp-root is empty/missing — refusing to run (#20)." >&2; exit 1; }

# --- Hermeticity guard (#20) -------------------------------------------------
# The suite must NEVER mutate the caller's repo, even when run from inside a
# pmtools worktree while dogfooding. Two defenses:
#   1) run entirely from inside $TMPROOT, so any git op that loses its `-C`/cd
#      target falls back to a NON-repo cwd (a harmless "not a git repository"),
#      never the caller's branch/index;
#   2) snapshot the caller repo's HEAD + porcelain status now and assert it is
#      byte-identical on exit — catching a leaked commit OR file, and failing the
#      run loudly if the harness touched the caller's repo.
CALLER_DIR="$PWD"
CALLER_HEAD="$(git -C "$CALLER_DIR" rev-parse HEAD 2>/dev/null || true)"
CALLER_STATUS="$(git -C "$CALLER_DIR" status --porcelain 2>/dev/null || true)"

assert_caller_pristine() {
  [ -n "$CALLER_HEAD" ] || return 0   # caller not in a git repo → nothing to protect
  local head status
  head="$(git -C "$CALLER_DIR" rev-parse HEAD 2>/dev/null || true)"
  status="$(git -C "$CALLER_DIR" status --porcelain 2>/dev/null || true)"
  if [ "$head" != "$CALLER_HEAD" ] || [ "$status" != "$CALLER_STATUS" ]; then
    echo "" >&2
    echo "FATAL (#20): the harness mutated the caller's repo at $CALLER_DIR" >&2
    echo "  HEAD before: ${CALLER_HEAD:-<none>}" >&2
    echo "  HEAD after : ${head:-<none>}" >&2
    echo "  status delta (- before / + after):" >&2
    diff <(printf '%s\n' "$CALLER_STATUS") <(printf '%s\n' "$status") | sed 's/^/    /' >&2
    return 1
  fi
  return 0
}

_cleanup() {
  local rc=$?
  assert_caller_pristine || rc=1
  rm -rf "$TMPROOT"
  trap - EXIT
  exit "$rc"
}
trap _cleanup EXIT

cd "$TMPROOT" || { echo "FATAL: cannot cd into temp-root $TMPROOT (#20)." >&2; exit 1; }

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
    # Seed a deterministic naming config so claim emits br-apple/demo-js-issue-N
    # and wt-apple-demo-js-issue-N (exercises resolveNameParts: project from the
    # "project" key, lang from languages[0]). Uncommitted on purpose — claim reads
    # it from mainRoot on disk, and leaving it untracked avoids any rebase contention
    # with the per-test orchestrate.json overwrites below.
    mkdir -p .claude
    printf '{ "project": "demo", "languages": ["javascript"] }\n' > .claude/orchestrate.json
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

# A fake gh for the parent-tracker guard (#36 guard 3 / #907). Besides the
# standard view/close calls (title shares the "widget" keyword so the close
# keyword guard passes), it answers `issue list --json number,title,body` from a
# caller-supplied JSON file (one open tracker holding an UNCHECKED box for the
# child) and records any `issue edit --body-file -` write — the tick — into
# <capfile>, so the test can assert the box was (or was NOT) flipped.
make_fake_gh_tracker() { # <state> <title> <tracker-json-file> <capfile>
  local d="$TMPROOT/fakeghP.$RANDOM"
  mkdir -p "$d"
  cat > "$d/gh" <<EOF
#!/usr/bin/env bash
state="$1"; title="$2"; trackerjson="$3"; cap="$4"
case "\$*" in
  *"issue list"*"number,title,body"*) cat "\$trackerjson" ;;
  *"issue edit"*"--body-file"*) cat > "\$cap" ;;
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
  if [ -d "$repo/.claude/worktrees/wt-apple-demo-js-issue-5" ]; then
    fail "[$lang] dry-run created no worktree"; else pass "[$lang] dry-run created no worktree"; fi

  # 3) real claim: branch br-apple/demo-js-issue-5, worktree under default dir, refs/claims/issue-5
  ( cd "$repo" && "${RUN[@]}" 5 --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] real claim exit 0"
  assert_contains "$o" "CLAIMED" "[$lang] real claim says CLAIMED"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/br-apple/demo-js-issue-5"; then
    pass "[$lang] branch br-apple/demo-js-issue-5 created"; else fail "[$lang] branch br-apple/demo-js-issue-5 created"; fi
  assert_dir "$repo/.claude/worktrees/wt-apple-demo-js-issue-5" "[$lang] worktree under default .claude/worktrees"
  if git -C "$repo" ls-remote origin 'refs/claims/*' | grep -q "refs/claims/issue-5"; then
    pass "[$lang] refs/claims/issue-5 staked on origin"; else fail "[$lang] refs/claims/issue-5 staked on origin"; fi

  # 4) second claim same issue, different agent -> exit 1, rolled back (no banana branch)
  ( cd "$repo" && "${RUN[@]}" 5 --as banana --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] same-issue second claim exits 1"
  assert_no_branch "$repo" "br-banana/demo-js-issue-5" "[$lang] br-banana/demo-js-issue-5 rolled back / never left"

  # 5) --worktree-dir parameterization: lands under wt/wt-apple-demo-js-issue-8
  local repo2; repo2="$(new_env)"
  ( cd "$repo2" && "${RUN[@]}" 8 --as apple --worktree-dir wt --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] --worktree-dir claim exit 0"
  assert_dir "$repo2/wt/wt-apple-demo-js-issue-8" "[$lang] worktree landed under wt/wt-apple-demo-js-issue-8"
  if [ -d "$repo2/.claude/worktrees/wt-apple-demo-js-issue-8" ]; then
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
  assert_no_branch "$repo4" "br-apple/demo-js-issue-12" "[$lang] --lane-check ON: no branch staked"

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
# claim malformed-config diagnostic (#52): a PRESENT but unparseable
# .claude/orchestrate.json is operator error, NOT a silent repo-unk default
# (which would mis-name the worktree and desync status/close-by-convention).
# claim must exit non-zero, name the file on stderr, and create nothing. (An
# ABSENT config stays a legitimate silent default — covered by run_claim_suite.)
# ---------------------------------------------------------------------------
run_claim_malformed_config_suite() {
  local lang="$1"; shift
  local -a RUN=("$@")
  echo "-- [$lang] claim malformed-config battery (#52) --"

  local repo; repo="$(new_env)"
  local o="$TMPROOT/claimbad.$RANDOM"
  # Trailing comma → invalid JSON (the exact repro from #52). Overwrites the
  # valid config new_env seeds.
  printf '{ "project": "demo", }\n' > "$repo/.claude/orchestrate.json"

  ( cd "$repo" && "${RUN[@]}" 17 --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] malformed-cfg: claim exits 1 (no silent default)"
  assert_contains "$o" "orchestrate.json" "[$lang] malformed-cfg: diagnostic names the file"
  if git -C "$repo" show-ref 2>/dev/null | grep -q "refs/heads/br-apple/"; then
    fail "[$lang] malformed-cfg: no claim branch created"
  else
    pass "[$lang] malformed-cfg: no claim branch created"
  fi
  if ls -d "$repo/.claude/worktrees/"*issue-17 >/dev/null 2>&1; then
    fail "[$lang] malformed-cfg: no worktree created"
  else
    pass "[$lang] malformed-cfg: no worktree created"
  fi
}

run_claim_malformed_config_suite "py" python3 "$PY_CLAIM"
run_claim_malformed_config_suite "js" node "$JS_CLAIM"

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
  local wt="$repo/.claude/worktrees/wt-apple-demo-js-issue-$N"
  assert_dir "$wt" "[$lang] close: worktree staked"

  # 2) in the worktree, make a trivial source change + commit with a subject that
  #    shares the keyword "widget" with the fake issue title, body `Closes #N`.
  # git -C + a dir guard so the seed commit can ONLY ever touch the claimed
  # worktree — a bare `cd "$wt"` to a missing path would fall back to the cwd
  # (the branch running the suite) and land a stray commit. (#55)
  if [ -d "$wt" ]; then
    git -C "$wt" config user.email tester@example.com
    git -C "$wt" config user.name tester
    git -C "$wt" config commit.gpgsign false
    printf 'widget impl\n' > "$wt/widget.txt"
    git -C "$wt" add widget.txt
    git -C "$wt" commit -qm "feat: add widget renderer" -m "Closes #$N"
  fi

  # 3) close it. From the main checkout, pass --branch so close chdirs into the wt.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N" ) >"$o" 2>&1
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
  assert_no_branch "$repo" "br-apple/demo-js-issue-$N" "[$lang] close: branch br-apple/demo-js-issue-$N deleted"

  # 6) refs/claims/issue-N was deleted on origin.
  if git -C "$repo" ls-remote origin 'refs/claims/*' 2>/dev/null | grep -q "refs/claims/issue-$N"; then
    fail "[$lang] close: refs/claims/issue-$N deleted on origin (still present)"
  else
    pass "[$lang] close: refs/claims/issue-$N deleted on origin"
  fi
}

run_close_suite "py" python3 "$PY_CLAIM" python3 "$PY_CLOSE"
run_close_suite "js" node "$JS_CLAIM" node "$JS_CLOSE"

# Recovery path (#76 gate): the agent pushed the `Closes #N` commit to origin/main
# BY HAND before running close. close finds nothing unpushed, scans origin/main,
# sees the issue is non-OPEN, and treats it as a clean close (delete ref + ff-pull +
# teardown) — the finalizeClose tail that previously had ZERO integration coverage.
run_close_recovery_suite() {
  local lang="$1" ci="$2" cs="$3" oi="$4" os="$5"
  local -a CLAIM=("$ci" "$cs")
  local -a CLOSE=("$oi" "$os")
  echo "-- [$lang] close recovery (already-pushed) battery --"

  local repo; repo="$(new_env)"
  local o="$TMPROOT/recovout.$RANDOM"
  local ghopen; ghopen="$(make_fake_gh_titled OPEN 'Fix the widget renderer')"
  local ghclosed; ghclosed="$(make_fake_gh CLOSED '[]')"
  local N=37

  # 1) claim while the issue is OPEN.
  ( cd "$repo" && PATH="$ghopen:$PATH" "${CLAIM[@]}" "$N" --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] recovery: claim $N exit 0"
  local wt="$repo/.claude/worktrees/wt-apple-demo-js-issue-$N"
  assert_dir "$wt" "[$lang] recovery: worktree staked"

  # 2) commit `Closes #N`, then PUSH IT TO origin/main BY HAND — the pre-push the
  #    recovery path exists to handle. git -C + dir guard (#55).
  if [ -d "$wt" ]; then
    git -C "$wt" config user.email tester@example.com
    git -C "$wt" config user.name tester
    git -C "$wt" config commit.gpgsign false
    printf 'widget impl\n' > "$wt/widget.txt"
    git -C "$wt" add widget.txt
    git -C "$wt" commit -qm "feat: add widget renderer" -m "Closes #$N"
    git -C "$wt" push -q origin HEAD:main
  fi

  # 3) close, with the issue now CLOSED on the host -> recovery clean-close.
  ( cd "$repo" && PATH="$ghclosed:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] recovery: close exit 0"
  assert_contains "$o" "clean close" "[$lang] recovery: prints 'treating as clean close'"

  # 4) worktree + branch torn down (the finalizeClose teardown tail ran).
  if [ -d "$wt" ]; then fail "[$lang] recovery: worktree removed"; else pass "[$lang] recovery: worktree removed"; fi
  assert_no_branch "$repo" "br-apple/demo-js-issue-$N" "[$lang] recovery: branch deleted"

  # 5) the claim ref was deleted on origin.
  if git -C "$repo" ls-remote origin 'refs/claims/*' 2>/dev/null | grep -q "refs/claims/issue-$N"; then
    fail "[$lang] recovery: refs/claims/issue-$N deleted (still present)"
  else
    pass "[$lang] recovery: refs/claims/issue-$N deleted on origin"
  fi
}

run_close_recovery_suite "py" python3 "$PY_CLAIM" python3 "$PY_CLOSE"
run_close_recovery_suite "js" node "$JS_CLAIM" node "$JS_CLOSE"

# ---------------------------------------------------------------------------
# close worktree DISCOVERY (#51): close must locate the worktree via
# `git worktree list` (the way release does), NOT by rebuilding the dir name.
# Repro: stake the worktree under a NON-default --worktree-dir, then close
# WITHOUT re-passing it. Name reconstruction looks in the default
# .claude/worktrees and fails (orphaning the worktree); discovery finds it under
# wt/ regardless and tears it down. Hermetic, mirrors run_close_suite.
# ---------------------------------------------------------------------------
run_close_discovery_suite() {
  local lang="$1" ci="$2" cs="$3" oi="$4" os="$5"
  local -a CLAIM=("$ci" "$cs") CLOSE=("$oi" "$os")
  echo "-- [$lang] close worktree-discovery battery (#51) --"

  local repo; repo="$(new_env)"
  local o="$TMPROOT/closedisc.$RANDOM"
  local gh; gh="$(make_fake_gh_titled OPEN 'Fix the widget renderer')"
  local N=42

  # Claim under a NON-default worktree dir (wt/): the real worktree lives at
  # <root>/wt/wt-apple-demo-js-issue-N, not the default .claude/worktrees.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLAIM[@]}" "$N" --as apple --worktree-dir wt --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] disc: claim $N under wt/ exit 0"
  local wt="$repo/wt/wt-apple-demo-js-issue-$N"
  assert_dir "$wt" "[$lang] disc: worktree staked under wt/"
  # git -C + dir guard: the seed commit can only touch the claimed worktree (#55).
  if [ -d "$wt" ]; then
    git -C "$wt" config user.email tester@example.com; git -C "$wt" config user.name tester; git -C "$wt" config commit.gpgsign false
    printf 'widget impl\n' > "$wt/widget.txt"
    git -C "$wt" add widget.txt
    git -C "$wt" commit -qm "feat: add widget renderer" -m "Closes #$N"
  fi

  # Close WITHOUT --worktree-dir. Reconstruction would resolve .claude/worktrees
  # (wrong) and die; discovery locates the worktree under wt/ and tears it down.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] disc: close (no --worktree-dir) exits 0 via discovery"
  assert_contains "$o" "CLOSED" "[$lang] disc: prints CLOSED banner"
  if [ -d "$wt" ]; then fail "[$lang] disc: worktree under wt/ removed"; else pass "[$lang] disc: worktree under wt/ removed"; fi
  assert_no_branch "$repo" "br-apple/demo-js-issue-$N" "[$lang] disc: branch br-apple/demo-js-issue-$N deleted"
  if git -C "$repo" ls-remote origin 'refs/claims/*' 2>/dev/null | grep -q "refs/claims/issue-$N"; then
    fail "[$lang] disc: refs/claims/issue-$N deleted on origin (still present)"
  else
    pass "[$lang] disc: refs/claims/issue-$N deleted on origin"
  fi
}

run_close_discovery_suite "py" python3 "$PY_CLAIM" python3 "$PY_CLOSE"
run_close_discovery_suite "js" node "$JS_CLAIM" node "$JS_CLOSE"

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
  local wt="$repo/.claude/worktrees/wt-apple-demo-js-issue-$N"

  # Commit a tracked orchestrate.json that ENABLES velocity (DB outside the tree
  # so the .db never dirties the worktree) + the keyword-sharing close commit.
  # git -C + dir guard: the seed commit can only touch the claimed worktree (#55).
  if [ -d "$wt" ]; then
    git -C "$wt" config user.email tester@example.com; git -C "$wt" config user.name tester
    git -C "$wt" config commit.gpgsign false
    mkdir -p "$wt/.claude"
    printf '{ "storage": { "dbPath": "%s", "velocity": { "enabled": true }, "errors": { "enabled": true } } }\n' "$DB" > "$wt/.claude/orchestrate.json"
    printf 'widget impl\n' > "$wt/widget.txt"
    git -C "$wt" add .claude/orchestrate.json widget.txt
    git -C "$wt" commit -qm "feat: add widget renderer" -m "Closes #$N"
  fi

  # Materialise the DB with an EMPTY velocity table (so the guard sees "no row",
  # not "DB absent → skip"). `velocity export` seeds the schema via connect().
  ( cd "$wt" && "${VEL[@]}" export --db-path "$DB" --csv "$DB.csv" ) >/dev/null 2>&1

  # 1) ENABLED + no velocity row for N → close must die exit 1, NOT land.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N" ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] vel-guard: enabled + no row → close exits 1"
  assert_contains "$o" "velocity" "[$lang] vel-guard: blocks with a velocity-row message"
  assert_dir "$wt" "[$lang] vel-guard: worktree left intact after block"
  if git --git-dir="$(dirname "$repo")/origin.git" log main --format=%s 2>/dev/null | grep -q "add widget renderer"; then
    fail "[$lang] vel-guard: blocked close did NOT land on origin/main"
  else
    pass "[$lang] vel-guard: blocked close did NOT land on origin/main"
  fi

  # #56: seed a NULL-ticket (issueless PM) row first — the guard's Check A int()
  # coercion must skip it, not crash, when it scans the table below.
  ( cd "$wt" && "${VEL[@]}" log \
      "{\"role\":\"PM\",\"agent\":\"apple\",\"started_iso\":\"2026-01-01T00:00:00-1000\"}" \
      --db-path "$DB" --no-csv ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] vel-guard: null-ticket (issueless) velocity log exit 0 (#56)"

  # 2) log a matching velocity row for N → close now proceeds, lands, tears down.
  #    (with the null-ticket row above also present, this proves #56: no int(None) crash.)
  ( cd "$wt" && "${VEL[@]}" log \
      "{\"ticket\":$N,\"role\":\"DEV\",\"agent\":\"apple\",\"started_iso\":\"2026-01-01T00:00:00-1000\"}" \
      --db-path "$DB" --no-csv ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] vel-guard: velocity log (matching row) exit 0"
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] vel-guard: matching row → close exits 0"
  assert_contains "$o" "CLOSED" "[$lang] vel-guard: prints CLOSED banner"
  if [ -d "$wt" ]; then fail "[$lang] vel-guard: worktree removed after success"; else pass "[$lang] vel-guard: worktree removed after success"; fi

  # === Env 2: velocity DISABLED → guard skipped (no false block) ===
  local repo2; repo2="$(new_env)"
  local M=32
  ( cd "$repo2" && PATH="$gh:$PATH" "${CLAIM[@]}" "$M" --as apple --allow-stale-main ) >"$o" 2>&1
  local wt2="$repo2/.claude/worktrees/wt-apple-demo-js-issue-$M"
  # git -C + dir guard: the seed commit can only touch the claimed worktree (#55).
  if [ -d "$wt2" ]; then
    git -C "$wt2" config user.email tester@example.com; git -C "$wt2" config user.name tester
    git -C "$wt2" config commit.gpgsign false
    mkdir -p "$wt2/.claude"
    printf '{ "storage": { "velocity": { "enabled": false } } }\n' > "$wt2/.claude/orchestrate.json"
    printf 'widget impl\n' > "$wt2/widget.txt"
    git -C "$wt2" add .claude/orchestrate.json widget.txt
    git -C "$wt2" commit -qm "feat: add widget renderer" -m "Closes #$M"
  fi
  # No velocity row logged anywhere; disabled config must NOT block the close.
  ( cd "$repo2" && PATH="$gh:$PATH" "${CLOSE[@]}" "$M" --branch "br-apple/demo-js-issue-$M" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] vel-guard: disabled + no row → close exits 0 (skipped)"
  assert_contains "$o" "CLOSED" "[$lang] vel-guard: disabled close prints CLOSED"

  # === Env 3 (#57): a velocity-CSV-only rebase conflict auto-resolves via re-export ===
  local repo3; repo3="$(new_env)"
  local K=37
  local DB3="$TMPROOT/vel.$lang.$K.db"
  # Land a velocity-enabled config + a baseline CSV mirror on main FIRST, so the
  # branch and the rebased-onto-main state share config and only the CSV diverges.
  (
    cd "$repo3"
    git config user.email tester@example.com; git config user.name tester; git config commit.gpgsign false
    mkdir -p .claude docs
    printf '{ "project": "demo", "languages": ["javascript"], "storage": { "dbPath": "%s", "velocity": { "enabled": true, "csvMirror": "docs/vel.csv" }, "errors": { "enabled": true } } }\n' "$DB3" > .claude/orchestrate.json
    printf 'id,ticket,agent\nBASE\n' > docs/vel.csv
    git add .claude/orchestrate.json docs/vel.csv
    git commit -qm "chore: enable velocity + baseline csv mirror"
    git push -q origin HEAD:main
  )
  # Seed the DB (a row for K) so the velocity guard passes — this is the source of truth.
  ( cd "$repo3" && "${VEL[@]}" log \
      "{\"ticket\":$K,\"role\":\"DEV\",\"agent\":\"apple\",\"started_iso\":\"2026-02-02T00:00:00-1000\"}" \
      --db-path "$DB3" --no-csv ) >/dev/null 2>&1
  ( cd "$repo3" && PATH="$gh:$PATH" "${CLAIM[@]}" "$K" --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] csv-conflict: claim $K exit 0 (#57)"
  local wt3="$repo3/.claude/worktrees/wt-apple-demo-js-issue-$K"
  # Branch side: a divergent CSV snapshot + the keyword-sharing close commit.
  # git -C + dir guard: the seed commit can only touch the claimed worktree (#55).
  if [ -d "$wt3" ]; then
    git -C "$wt3" config user.email tester@example.com; git -C "$wt3" config user.name tester; git -C "$wt3" config commit.gpgsign false
    printf 'id,ticket,agent\nBRANCH-SIDE\n' > "$wt3/docs/vel.csv"
    printf 'widget impl\n' > "$wt3/widget.txt"
    git -C "$wt3" add docs/vel.csv widget.txt
    git -C "$wt3" commit -qm "feat: add widget renderer" -m "Closes #$K"
  fi
  # Concurrent agent on main: a DIFFERENT divergent CSV snapshot, pushed to origin.
  (
    cd "$repo3"
    printf 'id,ticket,agent\nMAIN-SIDE\n' > docs/vel.csv
    git add docs/vel.csv
    git commit -qm "data: another agent's velocity row"
    git push -q origin HEAD:main
  )
  # close: rebasing the branch onto origin/main conflicts ONLY on docs/vel.csv →
  # auto-resolve by re-exporting from the DB, then land.
  ( cd "$repo3" && PATH="$gh:$PATH" "${CLOSE[@]}" "$K" --branch "br-apple/demo-js-issue-$K" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] csv-conflict: close auto-resolves + exits 0 (#57)"
  assert_contains "$o" "auto-resolved" "[$lang] csv-conflict: prints auto-resolved message (#57)"
  assert_contains "$o" "CLOSED" "[$lang] csv-conflict: prints CLOSED banner (#57)"
  if [ -d "$wt3" ]; then fail "[$lang] csv-conflict: worktree removed after success (#57)"; else pass "[$lang] csv-conflict: worktree removed (#57)"; fi
  if git --git-dir="$(dirname "$repo3")/origin.git" log main --format=%s 2>/dev/null | grep -q "add widget renderer"; then
    pass "[$lang] csv-conflict: close landed on origin/main (#57)"
  else
    fail "[$lang] csv-conflict: close landed on origin/main (#57)"
  fi

  # === Env 4 (#60): a union-file-only rebase conflict auto-resolves via merge=union ===
  # An append-only log listed in close.autoResolve.unionFiles must, on a rebase
  # conflict confined to it, be union-merged (both sides' lines kept) and land —
  # the same 3-step arm as the velocity CSV, but driven purely by config (no
  # committed .gitattributes required from the consumer; the #23 generic rule).
  local repo4; repo4="$(new_env)"
  local U=38
  # Land a config enabling union-file auto-resolve + a baseline log on main FIRST.
  (
    cd "$repo4"
    git config user.email tester@example.com; git config user.name tester; git config commit.gpgsign false
    mkdir -p .claude docs
    printf '{ "project": "demo", "languages": ["javascript"], "storage": { "velocity": { "enabled": false }, "errors": { "enabled": true } }, "close": { "autoResolve": { "unionFiles": ["docs/log.md"] } } }\n' > .claude/orchestrate.json
    printf '# log\nALPHA\n' > docs/log.md
    git add .claude/orchestrate.json docs/log.md
    git commit -qm "chore: enable union-file auto-resolve + baseline log"
    git push -q origin HEAD:main
  )
  ( cd "$repo4" && PATH="$gh:$PATH" "${CLAIM[@]}" "$U" --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] union-conflict: claim $U exit 0 (#60)"
  local wt4="$repo4/.claude/worktrees/wt-apple-demo-js-issue-$U"
  # Branch side: a divergent append + the keyword-sharing close commit.
  # git -C + dir guard: the seed commit can only touch the claimed worktree (#55).
  if [ -d "$wt4" ]; then
    git -C "$wt4" config user.email tester@example.com; git -C "$wt4" config user.name tester; git -C "$wt4" config commit.gpgsign false
    printf '# log\nALPHA\nBRANCH\n' > "$wt4/docs/log.md"
    printf 'widget impl\n' > "$wt4/widget.txt"
    git -C "$wt4" add docs/log.md widget.txt
    git -C "$wt4" commit -qm "feat: add widget renderer" -m "Closes #$U"
  fi
  # Concurrent agent on main: a DIFFERENT divergent append, pushed to origin.
  (
    cd "$repo4"
    printf '# log\nALPHA\nMAIN\n' > docs/log.md
    git add docs/log.md
    git commit -qm "data: another agent's log line"
    git push -q origin HEAD:main
  )
  # close: rebasing the branch onto origin/main conflicts ONLY on docs/log.md →
  # union-merge (keep BRANCH + MAIN), continue the rebase, then land.
  ( cd "$repo4" && PATH="$gh:$PATH" "${CLOSE[@]}" "$U" --branch "br-apple/demo-js-issue-$U" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] union-conflict: close auto-resolves + exits 0 (#60)"
  assert_contains "$o" "auto-resolved" "[$lang] union-conflict: prints auto-resolved message (#60)"
  assert_contains "$o" "CLOSED" "[$lang] union-conflict: prints CLOSED banner (#60)"
  if [ -d "$wt4" ]; then fail "[$lang] union-conflict: worktree removed after success (#60)"; else pass "[$lang] union-conflict: worktree removed (#60)"; fi
  # the union merge must have preserved BOTH divergent appends on origin/main.
  ologm="$(git --git-dir="$(dirname "$repo4")/origin.git" show main:docs/log.md 2>/dev/null)"
  if printf '%s' "$ologm" | grep -q BRANCH && printf '%s' "$ologm" | grep -q MAIN; then
    pass "[$lang] union-conflict: both appended lines survive on origin/main (#60)"
  else
    fail "[$lang] union-conflict: both appended lines survive on origin/main (#60)"
  fi

  # === Env 5 (#64 / #31): a learnings-README (append-only markdown index)
  # conflict auto-resolves — strip the markers, keep BOTH appended rows — when the
  # index is listed in close.autoResolve.markdownIndexes. The 4th and last kept
  # close guard; pins that it fires when enabled (#36 guard 4 / lccjs#971). ===
  local repo5; repo5="$(new_env)"
  local D=40
  # Land a config enabling markdown-index auto-resolve + a baseline index on main FIRST.
  (
    cd "$repo5"
    git config user.email tester@example.com; git config user.name tester; git config commit.gpgsign false
    mkdir -p .claude docs
    printf '{ "project": "demo", "languages": ["javascript"], "storage": { "velocity": { "enabled": false }, "errors": { "enabled": true } }, "close": { "autoResolve": { "markdownIndexes": ["docs/learnings.md"] } } }\n' > .claude/orchestrate.json
    printf '# Learnings\n- base entry\n' > docs/learnings.md
    git add .claude/orchestrate.json docs/learnings.md
    git commit -qm "chore: enable markdown-index auto-resolve + baseline learnings"
    git push -q origin HEAD:main
  )
  ( cd "$repo5" && PATH="$gh:$PATH" "${CLAIM[@]}" "$D" --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] md-conflict: claim $D exit 0 (#64/#31)"
  local wt5="$repo5/.claude/worktrees/wt-apple-demo-js-issue-$D"
  # Branch side: append a row + the keyword-sharing close commit.
  # git -C + dir guard: the seed commit can only touch the claimed worktree (#55).
  if [ -d "$wt5" ]; then
    git -C "$wt5" config user.email tester@example.com; git -C "$wt5" config user.name tester; git -C "$wt5" config commit.gpgsign false
    printf '# Learnings\n- base entry\n- BRANCH entry\n' > "$wt5/docs/learnings.md"
    printf 'widget impl\n' > "$wt5/widget.txt"
    git -C "$wt5" add docs/learnings.md widget.txt
    git -C "$wt5" commit -qm "feat: add widget renderer" -m "Closes #$D"
  fi
  # Concurrent agent on main: a DIFFERENT appended row, pushed to origin.
  (
    cd "$repo5"
    printf '# Learnings\n- base entry\n- MAIN entry\n' > docs/learnings.md
    git add docs/learnings.md
    git commit -qm "data: another agent's learnings line"
    git push -q origin HEAD:main
  )
  # close: rebasing the branch onto origin/main conflicts ONLY on docs/learnings.md →
  # markdown-index auto-resolve (keep both rows, strip markers), continue, land.
  ( cd "$repo5" && PATH="$gh:$PATH" "${CLOSE[@]}" "$D" --branch "br-apple/demo-js-issue-$D" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] md-conflict: close auto-resolves + exits 0 (#64/#31)"
  assert_contains "$o" "auto-resolved" "[$lang] md-conflict: prints auto-resolved message (#64/#31)"
  assert_contains "$o" "CLOSED" "[$lang] md-conflict: prints CLOSED banner (#64/#31)"
  if [ -d "$wt5" ]; then fail "[$lang] md-conflict: worktree removed after success (#64/#31)"; else pass "[$lang] md-conflict: worktree removed (#64/#31)"; fi
  # both appended rows must survive on origin/main; no conflict markers committed.
  olm="$(git --git-dir="$(dirname "$repo5")/origin.git" show main:docs/learnings.md 2>/dev/null)"
  if printf '%s' "$olm" | grep -q 'BRANCH entry' && printf '%s' "$olm" | grep -q 'MAIN entry' && ! printf '%s' "$olm" | grep -q '<<<<<<<'; then
    pass "[$lang] md-conflict: both learnings rows survive, no markers, on origin/main (#64/#31)"
  else
    fail "[$lang] md-conflict: both learnings rows survive on origin/main (#64/#31)"
  fi
}

run_close_velocity_suite "py" python3 "$PY_CLAIM" python3 "$PY_CLOSE" python3 "$PY_VELOCITY"
run_close_velocity_suite "js" node "$JS_CLAIM" node "$JS_CLOSE" node "$JS_VELOCITY"

# ---------------------------------------------------------------------------
# close pre-close verify gate (#106): config-driven `close.verify.commands` run
# in the worktree just before land. A non-zero exit ABORTS (worktree intact,
# nothing pushed). --dry-run reports but does not execute; --skip-verify bypasses;
# no `close.verify` config → no gate. Hermetic; mirrors run_close_velocity_suite.
# ---------------------------------------------------------------------------
run_close_verify_suite() {
  local lang="$1" ci="$2" cs="$3" oi="$4" os="$5"
  local -a CLAIM=("$ci" "$cs") CLOSE=("$oi" "$os")
  echo "-- [$lang] close pre-close verify gate battery (#106) --"
  local o="$TMPROOT/closeverify.$RANDOM"
  local gh; gh="$(make_fake_gh_titled OPEN 'Fix the widget renderer')"

  # === Env A: a FAILING verify command — dry-run reports, real aborts, skip bypasses ===
  local repo; repo="$(new_env)"
  local N=41
  ( cd "$repo" && PATH="$gh:$PATH" "${CLAIM[@]}" "$N" --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] verify: claim $N exit 0"
  local wt="$repo/.claude/worktrees/wt-apple-demo-js-issue-$N"
  if [ -d "$wt" ]; then
    git -C "$wt" config user.email tester@example.com; git -C "$wt" config user.name tester
    git -C "$wt" config commit.gpgsign false
    mkdir -p "$wt/.claude"
    printf 'echo VERIFY_BLOCKED_TOKEN; exit 1\n' > "$wt/verify_fail.sh"
    cat > "$wt/.claude/orchestrate.json" <<'JSON'
{ "close": { "verify": { "commands": ["sh verify_fail.sh"] } } }
JSON
    printf 'widget impl\n' > "$wt/widget.txt"
    git -C "$wt" add .claude/orchestrate.json verify_fail.sh widget.txt
    git -C "$wt" commit -qm "feat: add widget renderer" -m "Closes #$N"
  fi

  # 1) --dry-run: the gate REPORTS the command but does NOT execute it → exit 0,
  #    nothing landed, worktree intact.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N" --dry-run ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] verify: --dry-run + failing command → exit 0 (not executed)"
  assert_contains "$o" "would run" "[$lang] verify: --dry-run reports the command"
  if grep -q "VERIFY_BLOCKED_TOKEN" "$o"; then
    fail "[$lang] verify: --dry-run did NOT execute the command"; else
    pass "[$lang] verify: --dry-run did NOT execute the command"; fi

  # 2) real close: failing command ABORTS → exit 1, surfaces output, nothing landed,
  #    worktree intact.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N" ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] verify: failing command → close exits 1"
  assert_contains "$o" "VERIFY_BLOCKED_TOKEN" "[$lang] verify: surfaces the command's output"
  assert_contains "$o" "pre-close verify failed" "[$lang] verify: prints the gate-failed message"
  assert_dir "$wt" "[$lang] verify: worktree left intact after gate failure"
  if git --git-dir="$(dirname "$repo")/origin.git" log main --format=%s 2>/dev/null | grep -q "add widget renderer"; then
    fail "[$lang] verify: blocked close did NOT land on origin/main"; else
    pass "[$lang] verify: blocked close did NOT land on origin/main"; fi

  # 3) --skip-verify bypasses the failing gate → close proceeds, lands, tears down.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N" --skip-verify ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] verify: --skip-verify bypasses the gate → exits 0"
  assert_contains "$o" "CLOSED" "[$lang] verify: --skip-verify close prints CLOSED"
  if [ -d "$wt" ]; then fail "[$lang] verify: worktree removed after --skip-verify close"; else pass "[$lang] verify: worktree removed after --skip-verify close"; fi

  # === Env B: a PASSING verify command → close runs it and lands ===
  local repo2; repo2="$(new_env)"
  local M=42
  ( cd "$repo2" && PATH="$gh:$PATH" "${CLAIM[@]}" "$M" --as apple --allow-stale-main ) >"$o" 2>&1
  local wt2="$repo2/.claude/worktrees/wt-apple-demo-js-issue-$M"
  if [ -d "$wt2" ]; then
    git -C "$wt2" config user.email tester@example.com; git -C "$wt2" config user.name tester
    git -C "$wt2" config commit.gpgsign false
    mkdir -p "$wt2/.claude"
    printf 'echo VERIFY_RAN_OK; exit 0\n' > "$wt2/verify_ok.sh"
    cat > "$wt2/.claude/orchestrate.json" <<'JSON'
{ "close": { "verify": { "commands": ["sh verify_ok.sh"] } } }
JSON
    printf 'widget impl\n' > "$wt2/widget.txt"
    git -C "$wt2" add .claude/orchestrate.json verify_ok.sh widget.txt
    git -C "$wt2" commit -qm "feat: add widget renderer" -m "Closes #$M"
  fi
  ( cd "$repo2" && PATH="$gh:$PATH" "${CLOSE[@]}" "$M" --branch "br-apple/demo-js-issue-$M" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] verify: passing command → close exits 0"
  assert_contains "$o" "verify: sh verify_ok.sh" "[$lang] verify: ran the configured command"
  assert_contains "$o" "CLOSED" "[$lang] verify: passing-gate close prints CLOSED"
  if [ -d "$wt2" ]; then fail "[$lang] verify: worktree removed after passing-gate close"; else pass "[$lang] verify: worktree removed after passing-gate close"; fi

  # === Env C: a HANGING verify command + timeoutSec → killed, close aborts (#107) ===
  local repo3; repo3="$(new_env)"
  local K=43
  ( cd "$repo3" && PATH="$gh:$PATH" "${CLAIM[@]}" "$K" --as apple --allow-stale-main ) >"$o" 2>&1
  local wt3="$repo3/.claude/worktrees/wt-apple-demo-js-issue-$K"
  if [ -d "$wt3" ]; then
    git -C "$wt3" config user.email tester@example.com; git -C "$wt3" config user.name tester
    git -C "$wt3" config commit.gpgsign false
    mkdir -p "$wt3/.claude"
    cat > "$wt3/.claude/orchestrate.json" <<'JSON'
{ "close": { "verify": { "commands": ["sleep 30"], "timeoutSec": 1 } } }
JSON
    printf 'widget impl\n' > "$wt3/widget.txt"
    git -C "$wt3" add .claude/orchestrate.json widget.txt
    git -C "$wt3" commit -qm "feat: add widget renderer" -m "Closes #$K"
  fi
  local t0=$SECONDS
  ( cd "$repo3" && PATH="$gh:$PATH" "${CLOSE[@]}" "$K" --branch "br-apple/demo-js-issue-$K" ) >"$o" 2>&1
  local rc=$?
  local elapsed=$((SECONDS - t0))
  assert_exit "$rc" 1 "[$lang] verify: hanging command past timeout → close exits 1"
  assert_contains "$o" "timed out after 1s" "[$lang] verify: reports the timeout + abort"
  assert_dir "$wt3" "[$lang] verify: worktree intact after timeout abort"
  if [ "$elapsed" -lt 15 ]; then pass "[$lang] verify: timeout killed the hang promptly (${elapsed}s < 15s)"; else fail "[$lang] verify: close took ${elapsed}s — timeout did not kill the hang"; fi
}

run_close_verify_suite "py" python3 "$PY_CLAIM" python3 "$PY_CLOSE"
run_close_verify_suite "js" node "$JS_CLAIM" node "$JS_CLOSE"

# ---------------------------------------------------------------------------
# close parent-tracker guard (#36 guard 3 / #907): config-gated. With
# `close.updateParentTrackers` ENABLED, a successful close ticks the parent
# tracker issue's checkbox for the closed child — but only a box whose SOLE
# issue ref is that child (an umbrella multi-ref line is left alone). With it
# DISABLED (default), close performs no tracker write at all. Best-effort: the
# guard never blocks the close. Config is read from the worktree (close runs
# there until teardown), so it rides in on the closing commit like the vel one.
# ---------------------------------------------------------------------------
run_close_parent_tracker_suite() {
  # args: <lang> <claim-i> <claim-s> <close-i> <close-s>
  local lang="$1" ci="$2" cs="$3" oi="$4" os="$5"
  local -a CLAIM=("$ci" "$cs") CLOSE=("$oi" "$os")
  echo "-- [$lang] close parent-tracker guard battery --"

  local o="$TMPROOT/closept.$RANDOM"
  local TRK=200

  # === Env 1: updateParentTrackers ENABLED → close ticks the child's box ===
  local repo; repo="$(new_env)"
  local N=40
  # Tracker body: a sole-ref box for the child (must be ticked) + an umbrella
  # multi-ref box that cites the child AND #99999 (must NOT be ticked). The \n
  # are JSON escapes so the provider's json.loads yields real newlines.
  local tj="$TMPROOT/trk.$lang.$N.json"
  printf '[{"number":%s,"title":"Parent tracker","body":"## Children\\n- [ ] do the child work #%s\\n- [ ] umbrella covering #%s and #99999"}]\n' "$TRK" "$N" "$N" > "$tj"
  local cap="$TMPROOT/edit.$lang.$N.txt"
  local gh; gh="$(make_fake_gh_tracker OPEN 'Fix the widget renderer' "$tj" "$cap")"

  ( cd "$repo" && PATH="$gh:$PATH" "${CLAIM[@]}" "$N" --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] pt-guard: claim $N exit 0"
  local wt="$repo/.claude/worktrees/wt-apple-demo-js-issue-$N"
  # git -C + dir guard: the seed commit can only touch the claimed worktree (#55).
  if [ -d "$wt" ]; then
    git -C "$wt" config user.email tester@example.com; git -C "$wt" config user.name tester
    git -C "$wt" config commit.gpgsign false
    mkdir -p "$wt/.claude"
    printf '{ "close": { "updateParentTrackers": true } }\n' > "$wt/.claude/orchestrate.json"
    printf 'widget impl\n' > "$wt/widget.txt"
    git -C "$wt" add .claude/orchestrate.json widget.txt
    git -C "$wt" commit -qm "feat: add widget renderer" -m "Closes #$N"
  fi
  ( cd "$repo" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] pt-guard: enabled → close exits 0"
  assert_contains "$o" "CLOSED" "[$lang] pt-guard: prints CLOSED banner"
  assert_contains "$o" "Parent tracker #$TRK: checked the box for #$N" "[$lang] pt-guard: logs the tracker tick"
  if [ -f "$cap" ]; then pass "[$lang] pt-guard: enabled → tracker body was edited"; else
    fail "[$lang] pt-guard: enabled → tracker body was edited (no edit captured)"; fi
  assert_contains "$cap" "- [x] do the child work #$N" "[$lang] pt-guard: child's sole-ref box ticked"
  assert_contains "$cap" "- [ ] umbrella covering #$N and #99999" "[$lang] pt-guard: umbrella multi-ref box left unticked"

  # === Env 2: updateParentTrackers DISABLED (default) → no tracker write ===
  local repo2; repo2="$(new_env)"
  local M=41
  local tj2="$TMPROOT/trk.$lang.$M.json"
  printf '[{"number":%s,"title":"Parent tracker","body":"## Children\\n- [ ] do the child work #%s\\n- [ ] umbrella covering #%s and #99999"}]\n' "$TRK" "$M" "$M" > "$tj2"
  local cap2="$TMPROOT/edit.$lang.$M.txt"
  local gh2; gh2="$(make_fake_gh_tracker OPEN 'Fix the widget renderer' "$tj2" "$cap2")"

  ( cd "$repo2" && PATH="$gh2:$PATH" "${CLAIM[@]}" "$M" --as apple --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] pt-guard: claim $M exit 0"
  local wt2="$repo2/.claude/worktrees/wt-apple-demo-js-issue-$M"
  if [ -d "$wt2" ]; then
    git -C "$wt2" config user.email tester@example.com; git -C "$wt2" config user.name tester
    git -C "$wt2" config commit.gpgsign false
    mkdir -p "$wt2/.claude"
    printf '{ "close": { "updateParentTrackers": false } }\n' > "$wt2/.claude/orchestrate.json"
    printf 'widget impl\n' > "$wt2/widget.txt"
    git -C "$wt2" add .claude/orchestrate.json widget.txt
    git -C "$wt2" commit -qm "feat: add widget renderer" -m "Closes #$M"
  fi
  ( cd "$repo2" && PATH="$gh2:$PATH" "${CLOSE[@]}" "$M" --branch "br-apple/demo-js-issue-$M" ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] pt-guard: disabled → close exits 0"
  assert_contains "$o" "CLOSED" "[$lang] pt-guard: disabled → prints CLOSED banner"
  if [ -f "$cap2" ]; then
    fail "[$lang] pt-guard: disabled → NO tracker write (but an edit was captured)"; else
    pass "[$lang] pt-guard: disabled → no tracker write (off by default)"; fi
  if grep -qF "Parent tracker" "$o"; then
    fail "[$lang] pt-guard: disabled → no parent-tracker log line emitted"; else
    pass "[$lang] pt-guard: disabled → no parent-tracker log line"; fi
}

run_close_parent_tracker_suite "py" python3 "$PY_CLAIM" python3 "$PY_CLOSE"
run_close_parent_tracker_suite "js" node "$JS_CLAIM" node "$JS_CLOSE"

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
  local wt="$repo/.claude/worktrees/wt-apple-demo-js-issue-41"
  assert_dir "$wt" "[$lang] release: worktree staked"

  # 2) clean release → tears down; issue stays OPEN (never calls provider close).
  ( cd "$repo" && PATH="$gh:$PATH" "${RELEASE[@]}" 41 ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] release: clean release exit 0"
  assert_contains "$o" "stays OPEN" "[$lang] release: says issue stays OPEN"
  if [ -d "$wt" ]; then fail "[$lang] release: worktree removed"; else pass "[$lang] release: worktree removed"; fi
  assert_no_branch "$repo" "br-apple/demo-js-issue-41" "[$lang] release: branch deleted"
  if git -C "$repo" ls-remote origin 'refs/claims/*' 2>/dev/null | grep -q "refs/claims/issue-41"; then
    fail "[$lang] release: claim ref deleted on origin (still present)"
  else
    pass "[$lang] release: claim ref deleted on origin"
  fi

  # 3) data-loss guard: an UNPUSHED commit blocks release without --force.
  ( cd "$repo" && PATH="$gh:$PATH" "${CLAIM[@]}" 42 --as apple --allow-stale-main ) >"$o" 2>&1
  local wt2="$repo/.claude/worktrees/wt-apple-demo-js-issue-42"
  # git -C + dir guard: the seed commit can only touch the claimed worktree (#55).
  if [ -d "$wt2" ]; then
    git -C "$wt2" config user.email tester@example.com; git -C "$wt2" config user.name tester; git -C "$wt2" config commit.gpgsign false
    printf 'work\n' > "$wt2/work.txt"
    git -C "$wt2" add work.txt && git -C "$wt2" commit -qm "wip: unpushed work"
  fi
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
# injection battery (#37): attacker-controlled --as / --base / --branch must
# NEVER reach /bin/sh. claim/close build git commands; an interpolated `;touch`
# previously achieved arbitrary command execution. The empirical proof: a
# sentinel file the payload would `touch` must NOT exist afterwards.
# ---------------------------------------------------------------------------
run_injection_suite() {
  local lang="$1" ci="$2" cs="$3" oi="$4" os="$5"
  local -a CLAIM=("$ci" "$cs") CLOSE=("$oi" "$os")
  echo "-- [$lang] injection battery (#37) --"
  local gh; gh="$(make_fake_gh_titled OPEN 'Fix the widget renderer')"
  local o="$TMPROOT/inj.$RANDOM"
  # All-lowercase sentinel dir: the --as identity is lowercased before it reaches
  # the shell, so an uppercase mktemp path (TMPROOT) would be mangled and mask the
  # vuln. A lowercase path survives the .toLowerCase()/.lower() round-trip.
  local injdir="${TMPDIR:-/tmp}/pmtools-inj.$$.$lang"
  mkdir -p "$injdir"

  # 1) claim --as injection: the agent identity flows into the branch name and is
  #    interpolated into git show-ref / worktree add. A `;touch` must not fire.
  local repo; repo="$(new_env)"
  local s1="$injdir/pwned-as"
  ( cd "$repo" && PATH="$gh:$PATH" "${CLAIM[@]}" 51 --as "apple;touch $s1;true" --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] inj: claim --as injection rejected (exit 1)"
  if [ -e "$s1" ]; then fail "[$lang] inj: claim --as did NOT execute a shell payload"; rm -f "$s1"
  else pass "[$lang] inj: claim --as did NOT execute a shell payload"; fi

  # 2) claim --base injection: base is interpolated into git rev-parse / worktree add.
  local repo2; repo2="$(new_env)"
  local s2="$TMPROOT/pwned.base.$lang.$RANDOM"
  ( cd "$repo2" && PATH="$gh:$PATH" "${CLAIM[@]}" 52 --as apple --base "main;touch $s2;true" --allow-stale-main ) >"$o" 2>&1
  assert_exit "$?" 1 "[$lang] inj: claim --base injection rejected (exit 1)"
  if [ -e "$s2" ]; then fail "[$lang] inj: claim --base did NOT execute a shell payload"; rm -f "$s2"
  else pass "[$lang] inj: claim --base did NOT execute a shell payload"; fi

  # 3) close --branch injection: a malicious --branch passes the (unanchored) shape
  #    guards and reaches teardown's `git branch -D <branch>`. Set up a real,
  #    landable close on a benign worktree, then pass the payload as --branch.
  local repo3; repo3="$(new_env)"
  local N=53
  ( cd "$repo3" && PATH="$gh:$PATH" "${CLAIM[@]}" "$N" --as apple --allow-stale-main ) >"$o" 2>&1
  # new_env's naming config => wt-apple-demo-js-issue-N / br-apple/demo-js-issue-N.
  # git -C + a dir guard so the seed commit can ONLY ever touch the claimed
  # worktree — a bare `cd "$wt3"` to a missing path would fall back to the cwd
  # (the real repo) and land a stray commit on the current branch.
  local wt3="$repo3/.claude/worktrees/wt-apple-demo-js-issue-$N"
  if [ -d "$wt3" ]; then
    git -C "$wt3" config user.email tester@example.com
    git -C "$wt3" config user.name tester
    git -C "$wt3" config commit.gpgsign false
    printf 'widget impl\n' > "$wt3/widget.txt"
    git -C "$wt3" add widget.txt
    git -C "$wt3" commit -qm "feat: add widget renderer" -m "Closes #$N" >/dev/null 2>&1
  fi
  local s3="$TMPROOT/pwned.branch.$lang.$RANDOM"
  ( cd "$repo3" && PATH="$gh:$PATH" "${CLOSE[@]}" "$N" --branch "br-apple/demo-js-issue-$N;touch $s3;true" ) >"$o" 2>&1
  if [ -e "$s3" ]; then fail "[$lang] inj: close --branch did NOT execute a shell payload"; rm -f "$s3"
  else pass "[$lang] inj: close --branch did NOT execute a shell payload"; fi
}
run_injection_suite "py" python3 "$PY_CLAIM" python3 "$PY_CLOSE"
run_injection_suite "js" node "$JS_CLAIM" node "$JS_CLOSE"

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

  # (4) IN-PROGRESS end-to-end (#77): a canonical @inprogress marker whose issue
  # has a LIVE worktree reconciles to IN-PROGRESS (distinct from a @todo CLAIMED;
  # an @inprogress with no worktree would be STALE). Exercises the I/O glue
  # grep_markers → list_worktrees → reconcile → --json, not just the pure core.
  ( cd "$repo"
    printf '// @inprogress #210:30m the active thing\n' > src/active.js
    git add -A && git commit -qm "seed @inprogress marker for #210" ) >/dev/null 2>&1
  git -C "$repo" worktree add -q -b apple/issue-210 "$TMPROOT/wt210.$lang.$RANDOM" HEAD >/dev/null 2>&1
  local statusof='import json,sys; d=json.load(open(sys.argv[1])); print(next((m["status"] for m in d["markers"] if m["issue"]==210), "MISSING"))'
  ( cd "$repo" && "${RUN[@]}" --json ) >"$oo" 2>/dev/null
  local st210; st210="$(python3 -c "$statusof" "$oo" 2>/dev/null)"
  if [ "$st210" = "IN-PROGRESS" ]; then
    pass "[$lang] status: @inprogress + live worktree → IN-PROGRESS end-to-end (#77)"
  else
    fail "[$lang] status: expected IN-PROGRESS for #210, got: [$st210]"; sed 's/^/      /' "$oo"
  fi
}
run_status_pdd_suite "py" python3 "$PY_STATUS"
run_status_pdd_suite "js" node "$JS_STATUS"

# --- #70: status --json surfaces active claims (refs/claims/* on origin) — the
# cross-clone-safe in-flight signal, independent of `git worktree list` (which
# misses sibling-clone worktrees) and the br-/wt- branch-naming scheme. ---
echo "-- status claims signal (#70) --"
claims_repo="$(new_env)"
( cd "$claims_repo" && node "$JS_CLAIM" 88 --as apple --allow-stale-main ) >/dev/null 2>&1
# the worktree is local, but the SIGNAL we assert is the origin claim ref, which a
# sibling clone (and the orchestrator) can see without seeing the worktree.
for st in "py:python3 $PY_STATUS" "js:node $JS_STATUS"; do
  lang="${st%%:*}"; cmd="${st#*:}"
  cj="$(cd "$claims_repo" && $cmd --json 2>/dev/null)"
  if printf '%s' "$cj" | python3 -c 'import json,sys; sys.exit(0 if 88 in json.load(sys.stdin).get("claims",[]) else 1)' 2>/dev/null; then
    pass "[$lang] status --json claims includes the claimed issue #88 (#70)"
  else
    fail "[$lang] status --json claims includes the claimed issue #88 (#70)"; printf '%s\n' "$cj" | sed 's/^/      /' | head -3
  fi
done

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

  # 5) error-string convention (#44): store-cmd failures must use the fleet
  #    `[cmd] ✗` prefix (were `error:` / `velocity:`), and the unknown-subcommand
  #    render must be JSON-style (got "x") so it matches the JS port — not py repr
  #    (got 'x'). grep -F so the literal brackets + glyph are matched verbatim.
  ( cd "$store_repo" && "${ERR[@]}" bogus ) >"$o" 2>&1
  assert_exit "$?" 2 "[$lang] error: unknown subcommand exits 2 (usage error)"
  assert_contains "$o" "[error] ✗" "[$lang] error: failure uses the [error] ✗ prefix"
  assert_contains "$o" 'got "bogus"' "[$lang] error: unknown subcommand renders JSON-style (got \"bogus\")"
  ( cd "$store_repo" && "${VEL[@]}" bogus ) >"$o" 2>&1
  assert_exit "$?" 2 "[$lang] velocity: unknown subcommand exits 2 (usage error)"
  assert_contains "$o" "[velocity] ✗" "[$lang] velocity: failure uses the [velocity] ✗ prefix"
  assert_contains "$o" 'got "bogus"' "[$lang] velocity: unknown subcommand renders JSON-style (got \"bogus\")"

  # the velocity note/warn channel must use `[velocity] note:` (was `velocity: note:`).
  # A non-canonical model trips core.modelNotice → a note line, deterministically.
  local vn_repo; vn_repo="$(new_env)"; mkdir -p "$vn_repo/.claude"
  echo '{ "storage": { "velocity": { "enabled": true } } }' > "$vn_repo/.claude/orchestrate.json"
  ( cd "$vn_repo" && "${VEL[@]}" log \
      '{"ticket":7,"title":"t","role":"DEV","agent":"apple","started_iso":"2026-06-23T10:00:00-1000","finished_iso":"2026-06-23T10:42:00-1000","actual_min":42,"model":"weird-model-x"}' \
      --db-path "$vn_repo/vn.db" --no-csv ) >"$o" 2>&1
  assert_exit "$?" 0 "[$lang] velocity: note-channel log still exits 0"
  assert_contains "$o" "[velocity] note:" "[$lang] velocity: warn channel uses the [velocity] note: prefix"
  # #61: the payload above omits `repo`; it must default to the git repo basename
  # (the new_env clone dir is "work"), matching error log's behavior — not NULL.
  local vnrepo; vnrepo="$(sqlite3 "$vn_repo/vn.db" 'SELECT repo FROM velocity WHERE ticket=7;' 2>/dev/null)"
  if [ "$vnrepo" = "work" ]; then
    pass "[$lang] velocity: repo defaults to git basename when omitted (#61)"
  else
    fail "[$lang] velocity: repo defaults to git basename when omitted (#61) — got '$vnrepo'"
  fi
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

# ---------------------------------------------------------------------------
# cross-port parity (#38): the SAME velocity row logged via py and via js must
# produce an identical sqlite row AND identical CSV bytes (modulo the db filename
# in the preamble). Mirrors the error-log block above. `title` is supplied so the
# gh auto-fetch path is skipped — keeping the comparison deterministic + offline.
# ---------------------------------------------------------------------------
echo "-- cross-port parity (py vs js: identical velocity DB row + CSV bytes) --"
xv_repo="$(new_env)"
mkdir -p "$xv_repo/.claude"
cat > "$xv_repo/.claude/orchestrate.json" <<'EOF'
{ "storage": { "velocity": { "enabled": true } } }
EOF
XV_ROW='{"ticket":7,"title":"widget work","role":"DEV","agent":"apple","started_iso":"2026-06-23T10:00:00-1000","finished_iso":"2026-06-23T10:42:00-1000","actual_min":42,"model":"opus-4.8","repo":"pmtools"}'
XV_PY_DB="$xv_repo/xv-py.db";  XV_JS_DB="$xv_repo/xv-js.db"
XV_PY_CSV="$xv_repo/xv-py.csv"; XV_JS_CSV="$xv_repo/xv-js.csv"
xvo="$TMPROOT/xv.$RANDOM"
( cd "$xv_repo" && python3 "$PY_VELOCITY" log "$XV_ROW" --db-path "$XV_PY_DB" --csv "$XV_PY_CSV" ) >"$xvo" 2>&1
( cd "$xv_repo" && node    "$JS_VELOCITY" log "$XV_ROW" --db-path "$XV_JS_DB" --csv "$XV_JS_CSV" ) >>"$xvo" 2>&1
if diff <(sqlite3 -json "$XV_PY_DB" 'SELECT * FROM velocity ORDER BY id') \
        <(sqlite3 -json "$XV_JS_DB" 'SELECT * FROM velocity ORDER BY id') >/dev/null 2>&1; then
  pass "cross-port: py and js produce an identical velocity sqlite row"
else
  fail "cross-port: py and js produce an identical velocity sqlite row"; sed 's/^/      /' "$xvo"
fi
if diff <(sed "s#${XV_PY_DB##*/}#DB#" "$XV_PY_CSV") \
        <(sed "s#${XV_JS_DB##*/}#DB#" "$XV_JS_CSV") >/dev/null 2>&1; then
  pass "cross-port: py and js produce identical velocity CSV bytes (modulo db filename)"
else
  fail "cross-port: py and js produce identical velocity CSV bytes (modulo db filename)"
  diff <(sed "s#${XV_PY_DB##*/}#DB#" "$XV_PY_CSV") <(sed "s#${XV_JS_DB##*/}#DB#" "$XV_JS_CSV") | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# cross-port parity (#103): the SAME `ice score` payload via py and js must
# produce an identical sqlite row AND identical ranked-CSV bytes. Mirrors the
# error/velocity blocks above, with ONE extra neutralization: unlike those
# stores (whose timestamps are caller-supplied + identical), `ice` stamps
# `updated_iso` ITSELF at score time — py as `…+00:00` (micros,
# datetime.isoformat) vs js as `…Z` (millis, toISOString), and the value is
# wall-clock — so it differs between ports AND run-to-run. It lives in BOTH
# ICE_COLS (the row) and ICE_CSV_COLS (the export), so it's neutralized in both
# diffs. Runs in a throwaway repo with no github remote, so the provider's
# title/label lookups fail-fast → title/labels NULL in both ports (deterministic
# + offline), exactly like the velocity block's gh-skip.
# ---------------------------------------------------------------------------
echo "-- cross-port parity (py vs js: identical ice DB row + CSV bytes) --"
xi_repo="$(new_env)"
mkdir -p "$xi_repo/.claude"
cat > "$xi_repo/.claude/orchestrate.json" <<'EOF'
{ "storage": { "ice": { "enabled": true } } }
EOF
XI_PAYLOAD='{"7":{"I":1,"C":0.8,"E":5}}'
XI_PY_DB="$xi_repo/xi-py.db";  XI_JS_DB="$xi_repo/xi-js.db"
XI_PY_CSV="$xi_repo/xi-py.csv"; XI_JS_CSV="$xi_repo/xi-js.csv"
xio="$TMPROOT/xi.$RANDOM"
( cd "$xi_repo" && python3 "$PY_ICE" score "$XI_PAYLOAD" --db-path "$XI_PY_DB" --csv "$XI_PY_CSV" ) >"$xio" 2>&1
( cd "$xi_repo" && node    "$JS_ICE" score "$XI_PAYLOAD" --db-path "$XI_JS_DB" --csv "$XI_JS_CSV" ) >>"$xio" 2>&1
# Row diff: every column EXCEPT the wall-clock updated_iso (selected as a constant).
XI_COLS="id, issue, title, type, I, C, E, ice_score, tier, yegor_priority, actionable, provisional, labels, notes, 'TS' AS updated_iso"
if diff <(sqlite3 -json "$XI_PY_DB" "SELECT $XI_COLS FROM ice ORDER BY id") \
        <(sqlite3 -json "$XI_JS_DB" "SELECT $XI_COLS FROM ice ORDER BY id") >/dev/null 2>&1; then
  pass "cross-port: py and js produce an identical ice sqlite row (modulo updated_iso)"
else
  fail "cross-port: py and js produce an identical ice sqlite row (modulo updated_iso)"; sed 's/^/      /' "$xio"
fi
# CSV diff: neutralize the per-port db filename (preamble) AND the wall-clock
# updated_iso column (py `…+00:00` vs js `…Z`) before comparing.
XI_TS_RE='s/[0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T[0-9:.]*\(+00:00\|Z\)/TS/'
if diff <(sed -e "s#${XI_PY_DB##*/}#DB#" -e "$XI_TS_RE" "$XI_PY_CSV") \
        <(sed -e "s#${XI_JS_DB##*/}#DB#" -e "$XI_TS_RE" "$XI_JS_CSV") >/dev/null 2>&1; then
  pass "cross-port: py and js produce identical ice CSV bytes (modulo db filename + updated_iso)"
else
  fail "cross-port: py and js produce identical ice CSV bytes (modulo db filename + updated_iso)"
  diff <(sed -e "s#${XI_PY_DB##*/}#DB#" -e "$XI_TS_RE" "$XI_PY_CSV") <(sed -e "s#${XI_JS_DB##*/}#DB#" -e "$XI_TS_RE" "$XI_JS_CSV") | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# cross-port parity: stdout/stderr/exit. Run each command under BOTH ports
# against the same hermetic repo (read-only or --dry-run/no-op paths, so the two
# runs don't step on each other), then diff NORMALIZED output — neutralizing only
# the volatile bits (shas, ISO timestamps, pids) and the per-run repo/tmp paths.
# This makes a faithful-twin drift in any command's user-facing output a failure.
# ---------------------------------------------------------------------------
parity_norm() { # <file> <repo-root>
  sed -E \
    -e "s#$2#<REPO>#g" \
    -e "s#${HOME:-/no-home-set}#~#g" \
    -e "s#$TMPROOT#<TMP>#g" \
    -e 's/[0-9a-f]{40}/<SHA>/g' \
    -e 's/[0-9a-f]{7,12}/<SHA>/g' \
    -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+/<TS>/g' \
    -e 's/pid=[0-9]+/pid=<PID>/g' \
    "$1"
}
# parity_run <cmd> <label> <gh-dir-or-empty> -- <args...>
parity_run() {
  local cmd="$1" label="$2" ghdir="$3"; shift 3
  [ "${1:-}" = "--" ] && shift
  local prefix=""; [ -n "$ghdir" ] && prefix="$ghdir:"
  local po="$TMPROOT/par.$cmd.py.$RANDOM" jo="$TMPROOT/par.$cmd.js.$RANDOM" pe je
  ( cd "$PAR_REPO" && PATH="${prefix}$PATH" python3 "$PMTOOLS_ROOT/py/$cmd.py" "$@" ) >"$po" 2>&1; pe=$?
  ( cd "$PAR_REPO" && PATH="${prefix}$PATH" node    "$PMTOOLS_ROOT/js/$cmd.js" "$@" ) >"$jo" 2>&1; je=$?
  assert_exit "$pe" "$je" "parity[$cmd]: $label — same exit code ($pe)"
  if diff <(parity_norm "$po" "$PAR_REPO") <(parity_norm "$jo" "$PAR_REPO") >/dev/null 2>&1; then
    pass "parity[$cmd]: $label — identical normalized stdout+stderr"
  else
    fail "parity[$cmd]: $label — stdout/stderr drift"
    diff <(parity_norm "$po" "$PAR_REPO") <(parity_norm "$jo" "$PAR_REPO") | sed 's/^/      /'
  fi
}

echo "-- cross-port parity: stdout/stderr/exit (py vs js, same hermetic repo) --"
PAR_GH="$(make_fake_gh_titled OPEN 'Fix the widget renderer')"

# status (read-only): a seeded canonical marker must be reported identically.
# git -C + absolute paths so the seed commit can only ever touch the temp repo.
PAR_REPO="$(new_env)"
printf '// @todo #252:30m/DEV the real thing\n' > "$PAR_REPO/src.js"
git -C "$PAR_REPO" add -A
git -C "$PAR_REPO" commit -qm "seed marker" >/dev/null 2>&1
parity_run status "status --json on a seeded marker repo" "" -- --json

# preflight: both the happy path AND the usage-error path must match across ports.
# (#44 folded in the usage-string drift: js emitted `usage: pmtools preflight …`
# while py + every other cmd emit `usage: <cmd> …`; now aligned, so the usage-error
# render is byte-identical too.)
PAR_REPO="$(new_env)"
parity_run preflight "preflight <issue> happy path (OPEN)" "$PAR_GH" -- 5
parity_run preflight "preflight usage error (non-numeric issue) renders identically" "" -- notanumber

# error/velocity unknown-subcommand: the render must be byte-identical across ports
# (#44 thread 2 — js JSON.stringify `got "x"` vs py repr `got 'x'` drifted; the
# store-cmd failure prefix `[cmd] ✗` must also match the fleet convention).
PAR_REPO="$(new_env)"
parity_run error    "unknown subcommand renders identically across ports" "" -- bogus
parity_run velocity "unknown subcommand renders identically across ports" "" -- bogus
# a non-ASCII token must render byte-identically too (json.dumps defaults to
# ensure_ascii=True → `é`, which would drift from JS JSON.stringify's raw
# UTF-8; ensure_ascii=False keeps the twins byte-exact).
parity_run error    "unknown subcommand with a non-ASCII token renders identically" "" -- "café"

# claim (--dry-run: no mutation, full banner).
PAR_REPO="$(new_env)"
parity_run claim "claim --dry-run banner (branch/worktree/base)" "$PAR_GH" -- 60 --as apple --dry-run --allow-stale-main

# close (--dry-run: seed a claim + a real `Closes #N` commit first; dry-run plans
# the land/teardown without mutating, so both ports read identical state). Uses
# the deterministic naming new_env seeds (br-apple/demo-js-issue-N worktree).
PAR_REPO="$(new_env)"
( cd "$PAR_REPO" && PATH="$PAR_GH:$PATH" python3 "$PY_CLAIM" 61 --as apple --allow-stale-main ) >/dev/null 2>&1
PAR_WT="$PAR_REPO/.claude/worktrees/wt-apple-demo-js-issue-61"
# git -C + a dir guard: the seed commit only ever touches the claimed worktree,
# never the cwd (a bare `cd "$PAR_WT"` to a missing path would hit the real repo).
if [ -d "$PAR_WT" ]; then
  git -C "$PAR_WT" config user.email t@e.com
  git -C "$PAR_WT" config user.name t
  git -C "$PAR_WT" config commit.gpgsign false
  printf 'widget impl\n' > "$PAR_WT/widget.txt"
  git -C "$PAR_WT" add widget.txt
  git -C "$PAR_WT" commit -qm "feat: add widget renderer" -m "Closes #61" >/dev/null 2>&1
fi
parity_run close "close --dry-run plan" "$PAR_GH" -- 61 --branch br-apple/demo-js-issue-61 --dry-run

# release (orphan: no worktree → deterministic best-effort no-op in both ports).
PAR_REPO="$(new_env)"
parity_run release "release of an unclaimed issue is a no-op" "$PAR_GH" -- 777

# status unknown-flag rejection (#39): a mistyped flag (e.g. --strrict) must be
# REJECTED loudly with the SAME exit code in both ports — not silently dropped.
# (js used to ignore it and exit 0, masking a disabled --strict gate in CI.)
# parity_run proves byte-identical stdout+stderr+exit; the explicit checks pin the
# absolute exit code to 2 — an unknown flag is a usage error (#44 thread 3, which
# flipped the #39 convention from 1 to 2; see the exit-code-convention block below).
PAR_REPO="$(new_env)"
parity_run status "rejects an unknown flag identically" "" -- --strrict
su_py="$TMPROOT/su.py.$RANDOM"; su_js="$TMPROOT/su.js.$RANDOM"
( cd "$PAR_REPO" && python3 "$PY_STATUS" --strrict ) >"$su_py" 2>&1; su_pe=$?
( cd "$PAR_REPO" && node    "$JS_STATUS" --strrict ) >"$su_js" 2>&1; su_je=$?
assert_exit "$su_pe" 2 "[py] status: unknown flag exits 2 (usage error)"
assert_exit "$su_je" 2 "[js] status: unknown flag exits 2 (usage error)"
assert_contains "$su_py" "unknown flag" "[py] status: names the unknown flag"
assert_contains "$su_js" "unknown flag" "[js] status: names the unknown flag"

# status --host gitlab clean-die (#43): the gitlab provider is a stub whose
# methods throw; status must translate that into a clean
# `[status] ✗ host 'gitlab' not yet supported` (exit 1, operational) in BOTH
# ports — never a raw interpreter stack trace.
HG_REPO="$(new_env)"
hg_py="$TMPROOT/hg.py.$RANDOM"; hg_js="$TMPROOT/hg.js.$RANDOM"
( cd "$HG_REPO" && python3 "$PY_STATUS" --host gitlab ) >"$hg_py" 2>&1; hg_pe=$?
( cd "$HG_REPO" && node    "$JS_STATUS" --host gitlab ) >"$hg_js" 2>&1; hg_je=$?
assert_exit "$hg_pe" 1 "[py] status --host gitlab exits 1 (not-yet-supported)"
assert_exit "$hg_je" 1 "[js] status --host gitlab exits 1 (not-yet-supported)"
assert_contains "$hg_py" "host 'gitlab' not yet supported" "[py] status --host gitlab: clean message"
assert_contains "$hg_js" "host 'gitlab' not yet supported" "[js] status --host gitlab: clean message"
if grep -q "Traceback" "$hg_py"; then fail "[py] status --host gitlab: leaks a Python traceback"; else pass "[py] status --host gitlab: no stack trace"; fi
if grep -qE "node:internal|at [A-Za-z].*:[0-9]+:[0-9]+" "$hg_js"; then fail "[js] status --host gitlab: leaks a node stack trace"; else pass "[js] status --host gitlab: no stack trace"; fi

# ---------------------------------------------------------------------------
# exit-code convention (#44 thread 3): a structurally-invalid invocation
# (unknown flag, unknown/missing subcommand, missing required arg, bad-typed
# positional) exits 2 — reserving exit 1 for OPERATIONAL failures — uniformly
# across every command and both ports, matching the dispatcher (already exit 2).
# These die during arg parsing, before any gh/network, so they run hermetically.
# ---------------------------------------------------------------------------
echo "-- exit-code convention: usage/arg errors exit 2, operational stay 1 (py + js) --"
EC_REPO="$(new_env)"
exit_both() { # <cmd> <expected-exit> <label> -- <args...>
  local cmd="$1" exp="$2" label="$3"; shift 3; [ "${1:-}" = "--" ] && shift
  local eo="$TMPROOT/ec.$RANDOM"
  ( cd "$EC_REPO" && python3 "$PMTOOLS_ROOT/py/$cmd.py" "$@" ) >"$eo" 2>&1
  assert_exit "$?" "$exp" "[py] $label"
  ( cd "$EC_REPO" && node    "$PMTOOLS_ROOT/js/$cmd.js" "$@" ) >"$eo" 2>&1
  assert_exit "$?" "$exp" "[js] $label"
}
# usage / argument errors -> 2
exit_both error     2 "error: unknown flag exits 2"            -- --bogus
exit_both error     2 "error: missing subcommand exits 2"      --
exit_both error     2 "error: unknown subcommand exits 2"      -- bogus
exit_both error     2 "error: log without payload exits 2"     -- log
exit_both velocity  2 "velocity: unknown flag exits 2"         -- --bogus
exit_both velocity  2 "velocity: unknown subcommand exits 2"   -- bogus
exit_both preflight 2 "preflight: non-numeric issue exits 2"   -- notanumber
exit_both claim     2 "claim: unknown flag exits 2"            -- 5 --bogus
exit_both claim     2 "claim: missing issue exits 2"           --
exit_both close     2 "close: unknown flag exits 2"            -- 5 --bogus
exit_both close     2 "close: missing issue exits 2"           --
exit_both release   2 "release: missing issue exits 2"         --
exit_both status    2 "status: unknown flag exits 2"           -- --strrict
exit_both status    2 "status: unknown --host value exits 2"   -- --host bogus
# operational failures stay 1 (the well-formed invocation, bad data/world state)
exit_both error     1 "error: invalid JSON content stays exit 1" -- log "{bad"
[ "$FAILS" -eq 0 ]
