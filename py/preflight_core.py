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


def resolves_to_pmtools(cmd, verb):
    """Does `cmd` invoke pmtools-<verb>? True iff it contains the token
    `pmtools <verb>` (case-insensitive substring), so a full path like
    `/usr/local/bin/pmtools close` still matches. (#63)"""
    if not isinstance(cmd, str) or not cmd:
        return False
    return "pmtools {}".format(str(verb).lower()) in cmd.lower()


def preflight_close_coherence(claim_command, close_command):
    """Config-coherence check (#63). When a consumer claims with pmtools (which
    mints self-describing br-/wt- branch names, #17) but its closeCommand is a
    DIFFERENT, non-pmtools close, that close may not parse the br-/wt- names and
    will reject the branch at close time — after the work is done. Surface a
    non-blocking note at preflight instead. Returns {"warn": ...} to print, or
    None when there is nothing to say:
      - claimCommand does not resolve to pmtools-claim -> None (not on pmtools claim)
      - closeCommand is unset/empty                    -> None (no conflicting close)
      - closeCommand already resolves to pmtools-close -> None (coherent)
    The substring match cannot tell a capable non-pmtools close (one taught the
    br-/wt- form) from an incapable one, so a capable close draws a harmless false
    note — acceptable because this only ever prints a note, never blocks."""
    if not resolves_to_pmtools(claim_command, "claim"):
        return None
    if not isinstance(close_command, str) or not close_command:
        return None
    if resolves_to_pmtools(close_command, "close"):
        return None
    return {"warn": 'claiming with pmtools (br-/wt- branch names) but closeCommand '
            'is "{}"; ensure it accepts br-/wt- branch names or the close will be '
            'rejected.'.format(close_command)}
