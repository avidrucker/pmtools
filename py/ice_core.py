"""Pure ICE-scoring core (no I/O) for the pmtools `ice` store.

Ported faithfully from lccjs scripts/ice-score.js (the standalone scorer this
command replaces). ICE = Impact x Confidence x Ease, a per-issue triage score.

These are the I/O-free seams — the column orders, the score formula, the
ranking, the label-derived --auto heuristic, and the row validator (which RAISES
ValueError on a bad row). The sqlite engine (store.py) and the CLI (ice.py) call
in so the rules are testable without a DB and graded against fixtures/ice/*.

Parity: js/ice_core.js mirrors every function here and is graded against the SAME
fixtures. Validation-FAILURE fixtures use {"name":..., "args":[row],
"expected_error": true} — both languages assert a raised/thrown error.

Scales (verbatim from ice-score.js):
  I (Impact):     3=massive · 2=high · 1=medium · 0.5=low · 0.25=minimal
  C (Confidence): 1.0=high  · 0.8=medium · 0.5=low
  E (Ease):       10=trivial · 7=easy · 5=moderate · 3=hard · 1=very hard
Formula: ICE = I x C x E (higher Ease => higher ICE); tiebreak +1/(issue*1000).
"""


def _to_str(v):
    """Empty/None -> None, else str(v). Mirrors _to_str / lccjs toStr."""
    if v is None or v == "":
        return None
    return str(v)


# Closed input vocabularies — a value outside the set is rejected.
VALID_I = (0.25, 0.5, 1, 2, 3)
VALID_C = (0.5, 0.8, 1.0)
VALID_E = (1, 3, 5, 7, 10)

# Tier overrides sit above the normal ICE queue (lower = sorts first).
ICE_TIER_ORDER = {"critical": 0, "elevated": 1, "": 2}

# Stored (INSERT) columns — ice_rank is NOT stored; it is derived at export.
ICE_COLS = [
    "id", "issue", "title", "type", "I", "C", "E", "ice_score", "tier",
    "yegor_priority", "actionable", "provisional", "labels", "notes", "updated_iso",
]
# CSV export columns — inserts the derived ice_rank after ice_score and drops id,
# matching the lccjs stats/ice-scores.csv this store replaces.
ICE_CSV_COLS = [
    "issue", "title", "type", "I", "C", "E", "ice_score", "ice_rank", "tier",
    "yegor_priority", "actionable", "provisional", "labels", "notes", "updated_iso",
]


def compute_ice(I, C, E):
    """ICE = round(I x C x E, 4). Multiplicative: higher Ease => higher score
    (lccjs #1327 reversed the old `/E` that sank quick wins). Half-up rounding
    to mirror JS Math.round exactly (ICE is always >= 0)."""
    return int(I * C * E * 10000 + 0.5) / 10000


def final_score(ice, issue):
    """Tiebreaker: earlier issues win ties but cannot flip a higher score."""
    return ice + 1 / (issue * 1000)


def sort_rows(rows):
    """Stable sort by tier (critical > elevated > normal) then final_score desc."""
    def key(r):
        tier = ICE_TIER_ORDER.get(r.get("tier") or "", 2)
        return (tier, -final_score(r.get("ice_score") or 0, r["issue"]))
    return sorted(rows, key=key)


def rank_rows(rows):
    """sort_rows + a 1-based `ice_rank` on each row (returns new dicts)."""
    out = []
    for i, r in enumerate(sort_rows(rows)):
        nr = dict(r)
        nr["ice_rank"] = i + 1
        out.append(nr)
    return out


def derive_auto_score(labels):
    """Provisional {I,C,E} from labels alone (the --auto sweep). Rough on
    purpose: I from severity, C a neutral 0.8 (labels can't reveal confidence),
    E a coarse guess from the type label. Rows scored this way are flagged
    provisional=1 for later human review."""
    names = [l.get("name") for l in (labels or []) if isinstance(l, dict)]
    if "severity:critical" in names:
        I = 3
    elif "severity:high" in names:
        I = 2
    elif "severity:medium" in names:
        I = 1
    elif "severity:low" in names:
        I = 0.5
    else:
        I = 1
    if any(n in names for n in ("documentation", "chore", "cleanup", "style")):
        E = 7
    elif any(n in names for n in ("research", "spike", "experiment")):
        E = 3
    else:
        E = 5
    return {"I": I, "C": 0.8, "E": E}


def detect_ice_tier(labels):
    """The override tier from `priority:*` labels, or '' for the normal queue."""
    names = [l.get("name") for l in (labels or []) if isinstance(l, dict)]
    if "priority:critical" in names:
        return "critical"
    if "priority:elevated" in names:
        return "elevated"
    return ""


# The label a tier maps to; 'none' has no label (it clears the overrides).
OVERRIDE_LABEL = {"critical": "priority:critical", "elevated": "priority:elevated"}
VALID_TIERS = ["critical", "elevated", "none"]


def set_tier_plan(tier, current_labels):
    """Pure: plan the label mutation + stored tier for `ice set-tier` (#112),
    given a requested tier and the issue's CURRENT label NAMES (strings). Raises
    ValueError on an invalid tier. critical/elevated -> ensure that priority:*
    label and drop the other override; none -> drop both override labels. On an
    already-correct issue the plan is empty (add None, remove []), so `set-tier
    none` on a clean issue is a no-op. Returns {tier, storedTier, add, remove}:
    storedTier is '' for none (the normal-queue value detect_ice_tier uses), add
    is the label to add or None, remove lists only the override labels present."""
    t = str("" if tier is None else tier).lower()
    if t not in VALID_TIERS:
        raise ValueError("tier must be one of {} — got {}".format(VALID_TIERS, repr(tier)))
    names = [l for l in (current_labels or []) if isinstance(l, str) and l]
    crit = OVERRIDE_LABEL["critical"]
    elev = OVERRIDE_LABEL["elevated"]
    if t == "none":
        return {"tier": t, "storedTier": "", "add": None,
                "remove": [l for l in (crit, elev) if l in names]}
    target = OVERRIDE_LABEL[t]
    other = elev if t == "critical" else crit
    return {"tier": t, "storedTier": t,
            "add": None if target in names else target,
            "remove": [other] if other in names else []}


def _to_ice_input(name, v, valid):
    """None/'' -> None; a value in `valid` -> normalised number; else raise."""
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise ValueError('"{}" must be a number'.format(name))
    if n.is_integer():
        n = int(n)
    if n not in valid:
        raise ValueError(
            '"{}" must be one of {} — got {}'.format(name, list(valid), v))
    return n


def validate_ice_row(row):
    """Validate + normalise an ICE row. Required: issue (positive int). I/C/E
    are optional but, if given, must be in their valid sets; ice_score is
    computed when all three are present. provisional coerces to 0/1. Returns a
    dict keyed by the non-id, non-updated_iso ICE_COLS (the CLI stamps those)."""
    if not isinstance(row, dict):
        raise ValueError("ice row must be an object")

    issue = row.get("issue")
    if isinstance(issue, bool) or not isinstance(issue, int) or issue <= 0:
        raise ValueError('"issue" must be a positive integer')

    I = _to_ice_input("I", row.get("I"), VALID_I)
    C = _to_ice_input("C", row.get("C"), VALID_C)
    E = _to_ice_input("E", row.get("E"), VALID_E)
    ice_score = (compute_ice(I, C, E)
                 if (I is not None and C is not None and E is not None) else None)

    yp = row.get("yegor_priority")
    yegor_priority = yp if (isinstance(yp, int) and not isinstance(yp, bool)) else None

    return {
        "issue": issue,
        "title": _to_str(row.get("title")),
        "type": _to_str(row.get("type")),
        "I": I,
        "C": C,
        "E": E,
        "ice_score": ice_score,
        "tier": _to_str(row.get("tier")) or "",
        "yegor_priority": yegor_priority,
        "actionable": _to_str(row.get("actionable")) or "Y",
        "provisional": 1 if row.get("provisional") in (1, True) else 0,
        "labels": _to_str(row.get("labels")),
        "notes": _to_str(row.get("notes")),
    }
