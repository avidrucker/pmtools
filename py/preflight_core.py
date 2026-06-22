"""Pure preflight-core functions, ported from js/preflight.js (seeded from lccjs
scripts/preflight.js). I/O-free decision seams only; graded against the shared
fixtures/preflight/*.cases.json (the SAME files the JS harness loads).
"""

import re

DEFAULT_EVIDENCE_DIRS = ["docs/logs", "docs/research"]


def preflight_issue_gate(state):
    """OPEN-state gate from a gh `state` string (or None when gh unavailable).

    OPEN -> proceed; anything else -> block loudly; None/'' (offline) ->
    warn-and-proceed. Returns {ok, ...} with `error` or `warn` as appropriate.
    """
    if state is None or str(state).strip() == "":
        return {"ok": True, "warn": "issue state unknown (gh unavailable) — proceeding best-effort."}
    s = str(state).strip().upper()
    if s == "OPEN":
        return {"ok": True}
    return {"ok": False,
            "error": "issue is {}, not OPEN — nothing to start (raced a close?). Pick another issue.".format(s)}


def preflight_evidence(text, file_list, evidence_dirs=None):
    """Surface in-repo evidence for every #N referenced in `text`.

    Matches `<dir>/<N>-slug.md` ANCHORED to the basename prefix (so #76 != 1076-*).
    `evidence_dirs` is parameterizable (default ['docs/logs','docs/research']).
    Returns the deduped, sorted list of matching paths.
    """
    if evidence_dirs is None:
        evidence_dirs = DEFAULT_EVIDENCE_DIRS

    refs = set(re.findall(r"#(\d+)", str(text) if text is not None else ""))

    dirs = [d if d.endswith("/") else d + "/" for d in evidence_dirs]
    hits = set()
    for f in (file_list if isinstance(file_list, list) else []):
        p = re.sub(r"^\./", "", str(f))
        dir_match = next((d for d in dirs if p.startswith(d)), None)
        if not dir_match:
            continue
        prefix = re.match(r"^(\d+)-", p[len(dir_match):])
        if prefix and prefix.group(1) in refs:
            hits.add(p)
    return sorted(hits)
