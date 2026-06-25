#!/usr/bin/env bash
# run-tests.sh — run every pmtools test stage. Exits non-zero if any stage fails.
#
#   1. Python port unit tests (stdlib unittest, vs fixtures)   — python3 -m unittest
#   2. Node port unit tests (node:test, vs the SAME fixtures)  — node --test
#   3. Integration tests for the impure CLIs (py + js)         — tests/integration.sh
#   4. Dispatcher tests for the public bin/pmtools router      — tests/dispatcher.sh
set -u
cd "$(dirname "$0")"

RC=0

echo "=== [1/4] Python unit tests (python3 -m unittest discover -s py) ==="
if python3 -m unittest discover -s py; then
  echo "--- python: PASS"
else
  echo "--- python: FAIL"; RC=1
fi
echo

echo "=== [2/4] Node unit tests (node --test 'js/*.test.js') ==="
if node --test 'js/*.test.js'; then
  echo "--- node: PASS"
else
  echo "--- node: FAIL"; RC=1
fi
echo

echo "=== [3/4] Integration tests (bash tests/integration.sh) ==="
if bash tests/integration.sh; then
  echo "--- integration: PASS"
else
  echo "--- integration: FAIL"; RC=1
fi
echo

echo "=== [4/4] Dispatcher tests (bash tests/dispatcher.sh) ==="
if bash tests/dispatcher.sh; then
  echo "--- dispatcher: PASS"
else
  echo "--- dispatcher: FAIL"; RC=1
fi
echo

if [ "$RC" -eq 0 ]; then
  echo "=== ALL STAGES PASSED ==="
else
  echo "=== SOME STAGES FAILED ==="
fi
exit "$RC"
