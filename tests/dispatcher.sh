#!/usr/bin/env bash
# dispatcher.sh — exercise the public bin/pmtools dispatcher in isolation (#38):
# port routing (py default, --port, $PMTOOLS_PORT precedence + --port override),
# the exit-2 error paths (unknown command, unknown port, --port with no value),
# argument pass-through (--port stripped, the rest kept in order), and symlink
# self-location. Hermetic: a FAKE clone whose py/js command scripts merely
# announce "PORT=<p> CMD=<c> ARGS=<args>", so we observe which interpreter ran
# and with which args without touching the real tools or needing a git repo.
#
# Run directly:  bash tests/dispatcher.sh
set -u

PMTOOLS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REAL_BIN="$PMTOOLS_ROOT/bin/pmtools"

FAILS=0
PASSES=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pmtools-disp.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
pass() { PASSES=$((PASSES + 1)); echo "  ok   - $1"; }
fail() { FAILS=$((FAILS + 1)); echo "  FAIL - $1"; }
# assert_eq <actual> <expected> <label>
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1', expected '$2')"; fi; }
# assert_has <haystack> <needle> <label>
assert_has() { case "$1" in *"$2"*) pass "$3";; *) fail "$3 (missing '$2' in: $1)";; esac; }

# A fake clone: a copy of the REAL dispatcher (so the fix under test is exercised)
# plus stub py/js command scripts that print which port ran and the args they got.
CLONE="$TMP/clone"
mkdir -p "$CLONE/bin" "$CLONE/py" "$CLONE/js"
cp "$REAL_BIN" "$CLONE/bin/pmtools"
chmod +x "$CLONE/bin/pmtools"
for c in status file claim preflight close release error velocity ice; do
  cat > "$CLONE/py/$c.py" <<EOF
import sys
print("PORT=py CMD=$c ARGS=" + " ".join(sys.argv[1:]))
EOF
  cat > "$CLONE/js/$c.js" <<EOF
console.log("PORT=js CMD=$c ARGS=" + process.argv.slice(2).join(" "))
EOF
done
BIN="$CLONE/bin/pmtools"

echo "== pmtools dispatcher tests =="

# 1) Default port is py (no --port, no $PMTOOLS_PORT).
out="$(env -u PMTOOLS_PORT PMTOOLS_HOME="$CLONE" bash "$BIN" status --json 2>&1)"; rc=$?
assert_eq "$rc" 0 "default-port invocation exits 0"
assert_has "$out" "PORT=py CMD=status" "no flag/env -> defaults to the py port"

# 2) --port js routes to node.
out="$(env -u PMTOOLS_PORT PMTOOLS_HOME="$CLONE" bash "$BIN" status --port js 2>&1)"; rc=$?
assert_has "$out" "PORT=js CMD=status" "--port js routes to the node port"

# 3) $PMTOOLS_PORT overrides the py default.
out="$(PMTOOLS_PORT=js PMTOOLS_HOME="$CLONE" bash "$BIN" status 2>&1)"
assert_has "$out" "PORT=js" "\$PMTOOLS_PORT=js overrides the py default"

# 4) --port wins over $PMTOOLS_PORT (flag beats env).
out="$(PMTOOLS_PORT=py PMTOOLS_HOME="$CLONE" bash "$BIN" status --port js 2>&1)"
assert_has "$out" "PORT=js" "--port overrides \$PMTOOLS_PORT"

# 5) Argument pass-through: --port is stripped, the rest stay in order.
out="$(env -u PMTOOLS_PORT PMTOOLS_HOME="$CLONE" bash "$BIN" status --port js --json --foo bar 2>&1)"
assert_has "$out" "PORT=js CMD=status ARGS=--json --foo bar" "tool args pass through in order, --port stripped"

# 6) Unknown command -> exit 2 + message.
out="$(PMTOOLS_HOME="$CLONE" bash "$BIN" frobnicate 2>&1)"; rc=$?
assert_eq "$rc" 2 "unknown command exits 2"
assert_has "$out" "unknown command" "unknown command prints a message"

# 7) Unknown port -> exit 2 + message.
out="$(PMTOOLS_HOME="$CLONE" bash "$BIN" status --port xx 2>&1)"; rc=$?
assert_eq "$rc" 2 "unknown port exits 2"
assert_has "$out" "unknown port" "unknown port prints a message"

# 8) --port with no value -> exit 2 + message (was a silent `set -e` exit 1).
out="$(PMTOOLS_HOME="$CLONE" bash "$BIN" --port 2>&1)"; rc=$?
assert_eq "$rc" 2 "--port with no value exits 2"
assert_has "$out" "--port requires a value" "--port with no value prints a message"

# 9) Symlink self-location: a symlink to the dispatcher resolves the real clone
#    root even with $PMTOOLS_HOME unset (this is how ~/.local/bin/pmtools works).
mkdir -p "$TMP/elsewhere"
ln -s "$CLONE/bin/pmtools" "$TMP/elsewhere/pmtools"
out="$(env -u PMTOOLS_HOME -u PMTOOLS_PORT bash "$TMP/elsewhere/pmtools" status 2>&1)"; rc=$?
assert_eq "$rc" 0 "symlinked dispatcher exits 0"
assert_has "$out" "PORT=py CMD=status" "symlinked dispatcher self-locates its clone root"

# 10) `file` routes to both ports (#111).
out="$(env -u PMTOOLS_PORT PMTOOLS_HOME="$CLONE" bash "$BIN" file --title x 2>&1)"; rc=$?
assert_eq "$rc" 0 "file command routes (exits 0)"
assert_has "$out" "PORT=py CMD=file ARGS=--title x" "file routes to the py port with args in order"
out="$(env -u PMTOOLS_PORT PMTOOLS_HOME="$CLONE" bash "$BIN" file --port js --title x 2>&1)"
assert_has "$out" "PORT=js CMD=file ARGS=--title x" "file --port js routes to the node port"

# 11) `create` is an alias for `file` (#111): normalized before dispatch.
out="$(env -u PMTOOLS_PORT PMTOOLS_HOME="$CLONE" bash "$BIN" create --title x 2>&1)"
assert_has "$out" "PORT=py CMD=file ARGS=--title x" "create alias dispatches to the file command"

echo
echo "== dispatcher: $PASSES passed, $FAILS failed =="
[ "$FAILS" -eq 0 ]
