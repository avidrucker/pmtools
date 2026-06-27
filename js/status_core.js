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

// Filter a claims list (issue numbers, from parseClaimRefs) to the genuine
// in-flight set given the issue states the provider resolved. The signal is
// claims minus the CONFIRMED-CLOSED: an issue closed without `pmtools close`
// leaves a dangling refs/claims/issue-N (#81), and a consumer that reads
// `claims` as in-flight (#70) would otherwise hold a finished ticket. #71's
// sweep deletes such refs on the next claim; this guards the window before it.
// Degrade-safe: only a state the provider reports CLOSED drops a claim — OPEN
// or unknown (offline / not looked up) is kept, so an active claim is never
// lost merely because the host lookup failed. Pure. (#81, follow-up #70/#71.)
function filterOpenClaims(claimNumbers, issueStates) {
  const closed = new Set();
  for (const s of issueStates || []) {
    if (s && String(s.state).toUpperCase() === 'CLOSED') closed.add(s.number);
  }
  return (claimNumbers || []).filter((n) => !closed.has(n));
}

// The BLOCKED overlay decision (#78). An issue is blocked iff it carries the
// canonical `blocked` label — an OVERLAY orthogonal to the lifecycle status (an
// issue can be IN-PROGRESS *and* blocked). Exact match on the lowercase shared
// label name; degrade-safe on a null/absent label list. Pure; the `blocked-by`
// relation + marker-less blocked issues are out of scope here (→ #84).
// The BLOCKED overlay decision (#78, extended #87). Blocked iff the issue carries
// the canonical `blocked` label OR has an active `blocked-by` relation
// (`blockedByCount > 0`, sourced from `gh issue view --json blockedBy`). An
// overlay orthogonal to the lifecycle status; degrade-safe on null/absent labels.
function isBlocked(labels, blockedByCount = 0) {
  const labelBlocked = Array.isArray(labels) && labels.includes('blocked');
  return labelBlocked || Number(blockedByCount) > 0;
}

// Pure CLI arg parser for `status [--strict] [--json] [--host H]
// [--branch-pattern RX] [--limit N]` (#46). An unknown --flag THROWS (the impure
// status.js wrapper catches it and dies, exit 2). `branchPattern` defaults to
// null — the wrapper substitutes its OWN DEFAULT_BRANCH_PATTERN, whose
// named-group syntax differs per port (`(?<n>)` vs `(?P<n>)`), so the default
// stays out of the shared fixtures. A value-taking flag with no following token
// (or a non-numeric --limit) degrades to its default. Bare positionals are
// ignored — status takes none.
function parseArgs(argv) {
  const a = { strict: false, json: false, host: 'github', branchPattern: null, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--strict') a.strict = true;
    else if (t === '--json') a.json = true;
    else if (t === '--host') a.host = (i + 1 < argv.length) ? argv[++i] : null;
    else if (t === '--branch-pattern') a.branchPattern = (i + 1 < argv.length) ? argv[++i] : null;
    else if (t === '--limit') {
      const n = (i + 1 < argv.length) ? parseInt(argv[++i], 10) : NaN;
      a.limit = Number.isNaN(n) ? 50 : n;
    } else if (t.startsWith('--')) throw new Error('unknown flag: ' + t);
  }
  return a;
}

module.exports = {
  parseCanonicalMarker, parsePddignore, isPddIgnored, filterOpenClaims, isBlocked,
  parseArgs,
};
