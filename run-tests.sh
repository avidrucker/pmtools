#!/usr/bin/env bash
# run-tests.sh — run every pmtools test stage. Exits non-zero if any stage fails.
#
#   1. Python port unit tests (stdlib unittest, vs fixtures)   — python3 -m unittest
#   2. Node port unit tests (node:test, vs the SAME fixtures)  — node --test
#   3. Integration tests for the impure CLIs (py + js)         — tests/integration.sh
set -u
cd "$(dirname "$0")"

RC=0

echo "=== [1/3] Python unit tests (python3 -m unittest discover -s py) ==="
if python3 -m unittest discover -s py; then
  echo "--- python: PASS"
else
  echo "--- python: FAIL"; RC=1
fi
echo

echo "=== [2/3] Node unit tests (node --test 'js/*.test.js') ==="
if node --test 'js/*.test.js'; then
  echo "--- node: PASS"
else
  echo "--- node: FAIL"; RC=1
fi
echo

echo "=== [3/3] Integration tests (bash tests/integration.sh) ==="
if bash tests/integration.sh; then
  echo "--- integration: PASS"
else
  echo "--- integration: FAIL"; RC=1
fi
echo

if [ "$RC" -eq 0 ]; then
  echo "=== ALL STAGES PASSED ==="
else
  echo "=== SOME STAGES FAILED ==="
fi
exit "$RC"
