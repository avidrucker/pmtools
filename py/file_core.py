"""Pure decision seam for `pmtools file` (gated issue creation, #111). I/O-free;
graded against fixtures/file/*.cases.json (the SAME files the JS harness loads).
Twin of js/file_core.js.

file_gate_verdict(opts, cfg) validates the creation request against the `create`
config block and returns {ok, violations, labels}: violations are ordered
area -> role -> severity -> bodyShape -> titleHygiene; a HARD violation blocks
creation (ok False), a SOFT one is a `[file] note:` and never blocks; labels is
the resolved label set to hand to provider.create_issue.
"""
from store_core import VALID_ROLES
from claim_core import needs_area_label

_AREA_PREFIX = "area:"


def _dedupe_labels(labels):
    """Ordered de-dup (drops non-string / empty)."""
    seen = {}
    for l in (labels or []):
        if isinstance(l, str) and l:
            seen[l] = None
    return list(seen.keys())


def file_gate_verdict(opts, cfg):
    o = opts or {}
    c = cfg or {}
    violations = []

    area = o.get("area") if (isinstance(o.get("area"), str) and o.get("area")) else None
    role = o.get("role") if (isinstance(o.get("role"), str) and o.get("role")) else None
    severity = o.get("severity") if (isinstance(o.get("severity"), str) and o.get("severity")) else None
    title = o.get("title") if isinstance(o.get("title"), str) else ""
    body = o.get("body") if isinstance(o.get("body"), str) else ""
    allow_uncategorized = bool(o.get("allowUncategorized"))

    resolved = _dedupe_labels(o.get("labels"))
    if area:
        resolved.append(_AREA_PREFIX + area)

    valid_areas = c.get("validAreas") if isinstance(c.get("validAreas"), list) else []
    valid_area_set = set(valid_areas)
    area_labels = [l for l in resolved if l.startswith(_AREA_PREFIX)]
    real_areas = [l for l in area_labels if l[len(_AREA_PREFIX):] in valid_area_set]
    area_gate_on = c.get("requireArea") is not False and len(valid_areas) > 0

    # 1. Area gate
    if area_gate_on:
        if allow_uncategorized:
            if len(real_areas) != 1:
                fb = c.get("uncategorizedFallback")
                if not (isinstance(fb, str) and fb):
                    fb = "area:uncategorized"
                if fb not in resolved:
                    resolved.append(fb)
                violations.append({"gate": "area", "severity": "soft",
                    "message": "filed as {} (--allow-uncategorized) — assign a real area:* before work begins".format(fb)})
        elif len(area_labels) > 1:
            violations.append({"gate": "area", "severity": "hard",
                "message": "exactly one area:* label allowed — got {}".format(", ".join(area_labels))})
        elif needs_area_label(resolved) or len(real_areas) != 1:
            violations.append({"gate": "area", "severity": "hard",
                "message": "requires exactly one area:* label from [{}] — "
                           "pass --area <one>, or --allow-uncategorized to defer".format(", ".join(valid_areas))})

    # 2. Role gate (validate-only; role lives in the body, not a label)
    if c.get("requireRole") is not False:
        if not role:
            violations.append({"gate": "role", "severity": "hard",
                "message": "requires --role (a valid role, e.g. DEV, RESEARCH, WRITER)"})
        elif role not in VALID_ROLES:
            violations.append({"gate": "role", "severity": "hard",
                "message": 'role "{}" is not a valid role'.format(role)})

    # 3. Severity gate (severity:* only on defects — i.e. a `bug` label)
    if severity:
        if c.get("severityOnlyOnDefects") is not False and "bug" not in resolved:
            violations.append({"gate": "severity", "severity": "hard",
                "message": "severity:{} is only allowed on a defect — add the `bug` label or drop --severity".format(severity)})
        resolved.append("severity:" + severity)

    # 4. Body shape (soft; off by default)
    if c.get("requireBodyShape") is True:
        b = body.lower()
        if not ("have" in b and "should" in b):
            violations.append({"gate": "bodyShape", "severity": "soft",
                "message": "body is missing the have/should shape"})

    # 5. Title hygiene (soft; fires only when bannedTitleWords is non-empty)
    banned = c.get("bannedTitleWords") if isinstance(c.get("bannedTitleWords"), list) else []
    if banned:
        t = title.lower()
        hits = [w for w in banned if isinstance(w, str) and w and w.lower() in t]
        if hits:
            violations.append({"gate": "titleHygiene", "severity": "soft",
                "message": "title contains discouraged word(s): {}".format(", ".join(hits))})

    ok = all(v["severity"] != "hard" for v in violations)
    return {"ok": ok, "violations": violations, "labels": _dedupe_labels(resolved)}
