"""Pure status core (#15) — canonical PDD-marker grammar + .pddignore matching.

Mirrors js/status_core.js exactly; both graded against fixtures/status/*.

Two decisions live here so they are unit-testable without git I/O:
  parse_canonical_marker — is a grep hit a real puzzle (@(todo|inprogress)
    #N:<estimate>) vs incidental prose / an estimate-less mention?
  parse_pddignore + is_pdd_ignored — does a per-repo .pddignore (gitignore-style
    globs) exclude a file? Keeps pmtools generic: a consumer expresses its own
    exclusions (e.g. tests/**/*.spec.js) in its .pddignore; no consumer path is
    ever hard-coded here.
"""
import re

# Canonical PDD puzzle: keyword + #N + a REQUIRED estimate after the colon
# (e.g. `#134:60m`, `#252:30`). Same shape as lccjs's curated scan
# (`@(todo|inprogress) #[0-9]+:[0-9]`). Bare `@todo #208` / `@todo` is prose.
_CANONICAL_RE = re.compile(r"@(todo|inprogress)\s+#(\d+):(\d+[a-z]*)", re.IGNORECASE)


def parse_canonical_marker(content):
    """{keyword, issue, estimate} for a canonical marker in `content`, else None."""
    m = _CANONICAL_RE.search("" if content is None else str(content))
    if not m:
        return None
    return {"keyword": "@" + m.group(1).lower(), "issue": int(m.group(2)),
            "estimate": m.group(3)}


def parse_pddignore(text):
    """Clean glob patterns from a .pddignore file: drop blanks + `#` comments,
    trim whitespace and trailing CR. Pure."""
    out = []
    for line in ("" if text is None else str(text)).split("\n"):
        line = line.rstrip("\r").strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out


_ESCAPE_RE = re.compile(r"[.+^${}()|\[\]\\]")


def _glob_to_regex(pattern):
    """One gitignore-style glob → an anchored compiled regex (documented subset:
    `**` = any chars incl. `/`; `*` = any non-`/`; `?` = one non-`/`; a pattern
    with a `/` is rooted at repo top, else it matches a basename at any depth; a
    matched dir also matches everything beneath). Negation (`!`) unsupported."""
    p = pattern
    if p.startswith("/"):
        p = p[1:]
    if p.endswith("/"):
        p = p[:-1]
    rooted = "/" in p
    body = []
    i = 0
    n = len(p)
    while i < n:
        c = p[i]
        if c == "*":
            if i + 1 < n and p[i + 1] == "*":
                body.append(".*")
                i += 1
                if i + 1 < n and p[i + 1] == "/":
                    i += 1
            else:
                body.append("[^/]*")
        elif c == "?":
            body.append("[^/]")
        else:
            body.append(_ESCAPE_RE.sub(lambda m: "\\" + m.group(0), c))
        i += 1
    prefix = "^" if rooted else "(?:^|.*/)"
    return re.compile(prefix + "".join(body) + r"(?:/.*)?$")


def is_pdd_ignored(file, patterns):
    """True iff `file` matches any .pddignore pattern. Pure."""
    f = "" if file is None else str(file)
    for pat in (patterns or []):
        if _glob_to_regex(pat).search(f):
            return True
    return False
