// Pure status core (#15) — canonical PDD-marker grammar + .pddignore matching.
// Mirrors py/status_core.py exactly; both graded against fixtures/status/*.
//
// Two decisions live here so they are unit-testable without git I/O:
//   parseCanonicalMarker — is a grep hit a real puzzle (@(todo|inprogress)
//     #N:<estimate>) vs incidental prose / an estimate-less mention?
//   parsePddignore + isPddIgnored — does a per-repo .pddignore (gitignore-style
//     globs) exclude a file from the scan? Keeps pmtools generic: a consumer
//     expresses its own exclusions (e.g. tests/**/*.spec.js) in its .pddignore;
//     no consumer path is ever hard-coded here.
'use strict';

// Canonical PDD puzzle: the keyword, a #N issue ref, and a REQUIRED estimate
// after the colon (e.g. `#134:60m`, `#252:30`). lccjs's curated scan uses the
// same shape (`@(todo|inprogress) #[0-9]+:[0-9]`). A bare `@todo #208` or a
// plain `@todo` is prose, not a puzzle.
const CANONICAL_RE = /@(todo|inprogress)\s+#(\d+):(\d+[a-z]*)/i;

// Parse one grep-hit's content. Returns {keyword, issue, estimate} for a
// canonical marker, else null.
function parseCanonicalMarker(content) {
  const m = CANONICAL_RE.exec(String(content == null ? '' : content));
  if (!m) return null;
  return { keyword: '@' + m[1].toLowerCase(), issue: parseInt(m[2], 10), estimate: m[3] };
}

// Split a .pddignore file's text into clean glob patterns: drop blank lines and
// `#` comments, trim surrounding whitespace and trailing CR. Pure.
function parsePddignore(text) {
  return String(text == null ? '' : text)
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

// Translate one gitignore-style glob to an anchored RegExp (documented subset:
// `**` = any chars incl. `/`; `*` = any non-`/`; `?` = one non-`/`; a pattern
// containing a `/` is rooted at the repo top, otherwise it matches a basename at
// any depth; a matched dir also matches everything beneath it). Negation (`!`)
// is NOT supported (no consumer uses it yet).
function globToRegExp(pattern) {
  let p = pattern;
  if (p.startsWith('/')) p = p.slice(1);            // leading slash = explicit root anchor
  if (p.endsWith('/')) p = p.slice(0, -1);          // trailing slash = directory
  const rooted = p.includes('/');
  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {                        // `**` → across slashes
        body += '.*';
        i++;
        if (p[i + 1] === '/') i++;                   // swallow the slash in `**/`
      } else {
        body += '[^/]*';                             // `*` → within one segment
      }
    } else if (c === '?') {
      body += '[^/]';
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const prefix = rooted ? '^' : '(?:^|.*/)';
  return new RegExp(`${prefix}${body}(?:/.*)?$`);
}

// True iff `file` matches any .pddignore pattern. Pure: file path + patterns.
function isPddIgnored(file, patterns) {
  const f = String(file == null ? '' : file);
  for (const pat of patterns || []) {
    if (globToRegExp(pat).test(f)) return true;
  }
  return false;
}

module.exports = { parseCanonicalMarker, parsePddignore, isPddIgnored };
