#!/usr/bin/env bash
# 121-verify.sh — re-run every load-bearing number in the muda audit and print PASS/FAIL.
#
# You should not have to trust the report. Run this.
# Each check is: a command, an expected value, and a comparison. No interpretation.
#
#   ./121-verify.sh            # run all checks
#
# Requires: the T0 snapshot. If it is gone, this script says so and exits 2 rather
# than silently passing — an absent snapshot must never look like a green run.

set -uo pipefail

SNAP="${SNAP:-/tmp/claude-1000/-home-avi-Documents-Study/91c90cb5-b4c5-40c6-a1a0-c24d850c785b/scratchpad/muda-T0}"
LCC="$SNAP/db/lccjs.db"
PYC="$SNAP/db/pycats.db"
PMT="$SNAP/db/pmtools.db"

pass=0; fail=0; skip=0

if [ ! -f "$LCC" ]; then
  echo "SNAPSHOT ABSENT at $SNAP — cannot verify. Exiting 2."
  echo "(An absent snapshot must not look like a green run.)"
  exit 2
fi

echo "=== snapshot integrity: the DBs must be the ones the report was written against ==="
expect_lcc="c549050128e7a1d40a24e3190c85a130732a9d1a79b18d203e5c39fff044e6d6"
actual_lcc="$(sha256sum "$LCC" | cut -d' ' -f1)"
if [ "$actual_lcc" = "$expect_lcc" ]; then
  echo "PASS  lccjs.db sha256 matches the report"
  pass=$((pass+1))
else
  echo "FAIL  lccjs.db sha256 CHANGED — every number below is now unverifiable"
  echo "      expected $expect_lcc"
  echo "      actual   $actual_lcc"
  fail=$((fail+1))
fi
echo

check() {  # check <label> <expected> <command...>
  local label="$1"; local expected="$2"; shift 2
  local actual; actual="$("$@" 2>&1)"
  if [ "$actual" = "$expected" ]; then
    printf 'PASS  %-58s %s\n' "$label" "$actual"
    pass=$((pass+1))
  else
    printf 'FAIL  %-58s got %s, expected %s\n' "$label" "$actual" "$expected"
    fail=$((fail+1))
  fi
}

echo "=== the numbers the report rests on ==="

check "lccjs errors: row count" "403" \
  sqlite3 "$LCC" "select count(*) from errors where id <= 403"

check "lccjs errors: latest row (NOT 2026-06-27)" "2026-07-01T17:06:31-1000" \
  sqlite3 "$LCC" "select max(occurred_iso) from errors where id <= 403"

check "lccjs velocity: latest finish is AFTER the last commit" "2026-07-05T08:32:46-1000" \
  sqlite3 "$LCC" "select max(finished_iso) from velocity where id <= 1520"

check "date() silently NULLs 275 of 403 error rows" "275/403" \
  sqlite3 "$LCC" "select sum(case when date(occurred_iso) is null then 1 else 0 end) || '/' || count(*) from errors where id <= 403"

check "SQLite really does fail on a -1000 offset" "NULL|2026-07-02" \
  sqlite3 ":memory:" "select coalesce(date('2026-07-01T17:06:31-1000'),'NULL'), coalesce(date('2026-07-01T17:06:31-10:00'),'NULL')"

check "pycats velocity: zero rows (deliberate, not a loss)" "0" \
  sqlite3 "$PYC" "select count(*) from velocity"

check "pycats OTHER share" "40/141" \
  sqlite3 "$PYC" "select sum(error_type='OTHER') || '/' || count(*) from errors where id <= 142"

check "lccjs OTHER share" "20/403" \
  sqlite3 "$LCC" "select sum(error_type='OTHER') || '/' || count(*) from errors where id <= 403"

check "pycats error types are a SUBSET of lccjs's (empty = subset)" "(empty)" \
  sqlite3 "$PYC" "attach '$LCC' as l; select coalesce(group_concat(t),'(empty)') from (select distinct error_type t from errors where id<=142 except select distinct error_type from l.errors where id<=403)"

check "BEHAVIORAL_FAIL rows in use (skill defines it 0 times)" "30" \
  sqlite3 "$LCC" "attach '$PYC' as p; select (select count(*) from errors where error_type='BEHAVIORAL_FAIL' and id<=403) + (select count(*) from p.errors where error_type='BEHAVIORAL_FAIL' and id<=142)"

check "lccjs ice_scores: row count (NOT the CSV's 182)" "178" \
  sqlite3 "$LCC" "select count(*) from ice_scores where id <= 217"

check "velocity: actual_min exceeds the h_min hard cap on only N rows" "28" \
  sqlite3 "$LCC" "select count(*) from velocity where id<=1520 and h_min is not null and actual_min is not null and repo='lccjs' and actual_min > h_min"

check "velocity: c_min is populated (draft claimed it was blank)" "1370/1487" \
  sqlite3 "$LCC" "select sum(case when c_min is not null and c_min > 0 then 1 else 0 end) || '/' || count(*) from velocity where id<=1520 and repo!='claude-config'"

check "velocity: closed_commit filled on only 63 of 1493 rows" "63/1493" \
  sqlite3 "$LCC" "select sum(case when closed_commit is not null and closed_commit != '' then 1 else 0 end) || '/' || count(*) from velocity where id <= 1520"

echo
echo "=== the defects nobody was looking for ==="

check "agent names are CASE-SPLIT in lccjs.velocity" "SPLIT" \
  sqlite3 "$LCC" "select case when count(distinct agent) > count(distinct lower(agent)) then 'SPLIT' else 'clean' end from velocity where id<=1520 and agent is not null"

check "lccjs.velocity is contaminated with another repo's rows" "CONTAMINATED" \
  sqlite3 "$LCC" "select case when count(*) > 0 then 'CONTAMINATED' else 'clean' end from velocity where id<=1520 and repo != 'lccjs'"

check "lccjs.errors is contaminated with another repo's rows" "CONTAMINATED" \
  sqlite3 "$LCC" "select case when count(*) > 0 then 'CONTAMINATED' else 'clean' end from errors where id<=403 and repo != 'lccjs'"

echo
echo "=== why flow efficiency is NOT ASSESSED — the DATA is broken, not the finding ==="
echo "    (this is the real join: logged active minutes vs the ticket's ACTUAL created->closed lifespan)"

impossible() {
  python3 - "$LCC" "$SNAP/gh/lccjs-closed.json" <<'PY'
import sqlite3, json, sys
from datetime import datetime
db, gh = sys.argv[1], sys.argv[2]
life = {}
for i in json.load(open(gh)):
    if i.get("createdAt") and i.get("closedAt"):
        c = datetime.fromisoformat(i["createdAt"].replace("Z", "+00:00"))
        k = datetime.fromisoformat(i["closedAt"].replace("Z", "+00:00"))
        life[i["number"]] = (k - c).total_seconds() / 60.0
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = con.execute(
    "select ticket, actual_min from velocity "
    "where id<=1520 and ticket is not null and actual_min is not null and actual_min > 0"
).fetchall()
joined = [(t, a, life[t]) for t, a in rows if t in life]
bad = [(t, a, e) for t, a, e in joined if a > e]
# report as "impossible/joined" so the denominator is never hidden
print(f"{len(bad)}/{len(joined)}")
PY
}
# The analysts reported 153/1059. This INDEPENDENT reimplementation gets 151/1133 -- the
# defect is confirmed, the exact count is NOT reproducible across implementations (they appear
# to dedupe by ticket; this counts rows). So the check asserts what is ROBUST: impossible rows
# exist, and they are >10% of joined tickets. The precise count is implementation-dependent and
# must not be quoted as if it were a fact about the world.
#
# This distinction is the whole point: re-running someone's COMMAND reproduces their arithmetic.
# Re-deriving their number INDEPENDENTLY tests their claim. Only the second is verification.
robust() {
  local r; r="$(impossible)"          # "bad/joined"
  local bad="${r%%/*}"; local tot="${r##*/}"
  if [ "$bad" -gt 0 ] && [ $(( bad * 100 / tot )) -ge 10 ]; then
    echo "DEFECT_CONFIRMED"
  else
    echo "no ($r)"
  fi
}
check "active-time EXCEEDS ticket lifespan on >10% of tickets" "DEFECT_CONFIRMED" robust
echo "      note: this run gets $(impossible); the analysts reported 153/1059."
echo "      The DEFECT reproduces. The exact COUNT does not, across implementations."
echo "      Quote the defect. Do not quote the count."

echo
echo "════════════════════════════════════════════"
printf "PASS %d   FAIL %d   SKIP %d\n" "$pass" "$fail" "$skip"
echo "════════════════════════════════════════════"
[ "$fail" -eq 0 ] || echo "A FAIL means the report is wrong, or the snapshot moved. Either way: do not trust the number."
exit $(( fail > 0 ? 1 : 0 ))
