// Pure close-core functions, ported faithfully from lccjs scripts/close.js.
//
// These are the I/O-free decision seams of the `close` command: push-error
// classification, the cleanup gate, claim-ref delete command/classification,
// rebase-conflict classification, the closing-commit body matcher, the Guard 2
// keyword tokenizer/overlap, marker-presence detection, and the scope-audit diff
// command. The git/gh side effects in close.js's main() are NOT ported here —
// only the pure parts, graded against the shared fixtures/close/*.cases.json (the
// SAME files py/close_core.py loads).
//
// Parity: every function mirrors its Python twin in py/close_core.py. The
// lccjs-specific velocity-CSV / learnings-README auto-resolve and parent-tracker
// scan are OUT of scope for the pmtools port, so UNION_FILES defaults to EMPTY
// and classifyRebaseConflict treats any conflict as 'blocking'.
'use strict';

const DEFAULT_MAX_RETRIES = 5;

// --- injection safety (#37) ------------------------------------------------
// A branch/ref is safe to interpolate into a git command iff it is a non-empty
// string of ref-legal characters only (letters, digits, dot, underscore, slash,
// dash). Every shell metacharacter is rejected. close/release pass `--branch`
// (or a porcelain-parsed branch) through this before any interpolation; the
// arg-array exec migration is defense-in-depth on top. Twin of claim_core's.
const SAFE_REF_RE = /^[A-Za-z0-9._/-]+$/;
function isSafeRef(s) {
  return typeof s === 'string' && SAFE_REF_RE.test(s);
}

// lccjs's merge=union auto-resolve set is OUT of scope for the pmtools port: any
// rebase conflict is treated as human-resolvable ('blocking'). Kept as an empty
// default so the signature matches the Python twin and callers may pass their own.
const UNION_FILES = [];

// --- push / cleanup classification -----------------------------------------

// Classify a FAILED git push's stdout+stderr into a retry decision.
//   'race'           — lost the rebase→push window; re-fetch/rebase clears it.
//   'rejected-other' — non-racy rejection (hook, auth, protected branch) or
//                      unrecognised → abort (don't loop blindly).
// Only call on a non-zero push: success is decided by the exit code. Race
// signals are checked FIRST — the "[remote rejected]" prefix of the #200
// incident is NOT itself fatal; the parenthetical reason is.
function classifyPushError(output) {
  const s = String(output || '');
  const RACE = [
    /cannot lock ref/i,
    /non-fast-forward/i,
    /\bfetch first\b/i,
    /tip of your current branch is behind/i,
    /\[rejected\]/i,
  ];
  if (RACE.some((re) => re.test(s))) return 'race';
  return 'rejected-other';
}

// The gate. Cleanup is permitted IFF onOriginMain is exactly true. The single
// chokepoint that makes "tear down after a failed push" structurally impossible.
function shouldCleanup({ onOriginMain }) {
  return onOriginMain === true;
}

// --- claim-ref delete ------------------------------------------------------

// The refspec command that deletes the cross-clone claim ref (leading `:`).
function claimRefDeleteCommand(issue) {
  return `git push origin :refs/claims/issue-${issue}`;
}

// Classify the claim-ref delete output. Idempotent by design.
//   'DELETED' — removed, or a clean/empty exit (nothing to report).
//   'ABSENT'  — the ref did not exist remotely → already deleted / never staked.
//   'WARN'    — offline / auth / unrecognised → best-effort; the close continues.
function classifyClaimRefDelete(output) {
  const s = String(output || '');
  if (/\[deleted\]/i.test(s)) return 'DELETED';
  if (/remote ref does not exist|unable to delete/i.test(s)) return 'ABSENT';
  if (s.trim() === '') return 'DELETED';
  return 'WARN';
}

// --- rebase conflict -------------------------------------------------------

// Classify a rebase's conflicted paths.
//   'none'       — no conflicts.
//   'union-only' — every path is in unionFiles (out of scope: default EMPTY).
//   'blocking'   — at least one non-union file conflicts → resolve manually.
function classifyRebaseConflict(paths, unionFiles = UNION_FILES) {
  const list = (paths || []).map((p) => String(p).trim()).filter(Boolean);
  if (list.length === 0) return 'none';
  const allUnion = list.every((p) => unionFiles.includes(p));
  return allUnion ? 'union-only' : 'blocking';
}

// --- closing-commit detection ----------------------------------------------

// True if the commit log text carries a GitHub close keyword for the issue.
// Accepts close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved. The
// text may be one commit body or several concatenated.
function bodyClosesIssue(text, issue) {
  const re = new RegExp(`\\b(clos(e|es|ed)|fix(e|es|ed)?|resolv(e|es|ed))\\s+#${issue}\\b`, 'i');
  return re.test(String(text || ''));
}

// True if the commit text REFERENCES #issue (e.g. `(#N)` or a bare `#N`) but does
// NOT carry a close keyword for it — the already-pushed-without-`Closes #N` case
// (#7). False when it closes the issue (bodyClosesIssue owns that), when #issue is
// absent, or when text is empty/null. The `\b` after the number keeps `#250` from
// matching issue 25. Mirrors py pushed_commit_references_issue.
function pushedCommitReferencesIssue(text, issue) {
  if (text === null || text === undefined) return false;
  const s = String(text);
  const references = new RegExp(`#${issue}\\b`).test(s);
  return references && !bodyClosesIssue(s, issue);
}

// Targeted, teaching rejection for a flag recognized as meaningful on a SIBLING
// command but genuinely unsupported on `close` (#9). Returns the guidance string,
// or null for a truly unknown flag (keeps the generic 'unknown flag' rejection).
// Both stay exit 2 (usage error) — this only improves the text. Currently `--as`:
// claim takes it, but close infers identity from the worktree branch. Mirrors py
// unsupported_flag_hint.
function unsupportedFlagHint(flag) {
  if (flag === '--as') {
    return '`close` takes no --as; identity is inferred from the worktree branch ' +
           '([br-]<agent>/issue-N). Just run: pmtools close <N> (from inside the worktree).';
  }
  return null;
}

// --- Guard 2: keyword extraction / overlap ---------------------------------

// Stop-set for keyword extraction — role prefixes / filler with no signal.
const KEYWORD_STOP_SET = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'will', 'into', 'onto',
  'also', 'when', 'then', 'than', 'what', 'where', 'which',
  'writer', 'research', 'architect', 'spike', 'data',
]);

// Short technical acronyms meaningful here that bypass the 4-char floor.
const SHORT_TECH_WORDS = new Set(['cli', 'api', 'lcc', 'tdd', 'e2e']);

// Tokenize text into discriminating keywords. Splits on non-word chars,
// lowercases, keeps words ≥4 chars (or in SHORT_TECH_WORDS) that are neither
// pure numbers nor in the stop-set.
function extractKeywords(text, stopSet = KEYWORD_STOP_SET) {
  return String(text || '')
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => (w.length >= 4 || SHORT_TECH_WORDS.has(w)) && !/^\d+$/.test(w) && !stopSet.has(w));
}

// True if ≥1 word from titleWords appears in subjectWords. An empty array on
// either side is treated as "no signal" and returns false.
function keywordsOverlap(titleWords, subjectWords) {
  const s = new Set(subjectWords || []);
  return (titleWords || []).some((w) => s.has(w));
}

// --- marker-presence (Guard) + scope audit ---------------------------------

// Does a puzzle marker (todo/inprogress) for the issue still appear in the grep
// output? Returns { found, lines }.
function markerStillPresent(issue, grepOutput) {
  const re = new RegExp(`@(?:todo|inprogress)\\s+#${issue}\\b`, 'i');
  const lines = String(grepOutput || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const matched = lines.filter((l) => re.test(l));
  return { found: matched.length > 0, lines: matched };
}

// Pick the diff the scope audit shows. Prefer merge-base..HEAD (the branch's own
// delta); fall back to the bare origin/main comparison when no merge-base.
function scopeAuditDiffCommand(base) {
  const b = (base || '').trim();
  return b ? `git diff --stat ${b} HEAD` : 'git diff --stat origin/main';
}

// --- velocity-row guard (ported from lccjs scripts/close.js; #5) --------------
// pmtools is DB-only (no velocity-CSV commit), so the I/O wrapper in close.js
// reads the rows from SQLite and feeds these PURE decisions. The guard is
// config-gated upstream (skipped when storage.velocity is disabled).

// Check A decision (lccjs #359): does at least one velocity row exist for the
// ticket? Pure: takes the rows the DB returned, returns boolean.
function velocityRowPresent(rows) {
  return Array.isArray(rows) && rows.length > 0;
}

// Guard 1 helper (lccjs #310): which of the given ticket numbers disagree with
// the issue being closed. Empty == consistent. Pure: tickets + issue → number[].
function velocityTicketMismatch(tickets, issue) {
  const n = Number(issue);
  // A null ticket is an issueless PM/triage row (#56) — it pertains to no issue,
  // so it is neither a match nor a mismatch; skip it rather than report it.
  return (tickets || []).filter((t) => t != null && Number(t) !== n);
}

// A rebase whose ONLY conflicted path is the velocity CSV mirror is
// auto-resolvable: the mirror is a full-table SQLite export, and the DB (the
// source of truth) already holds both agents' rows, so the conflict is resolved
// by re-exporting rather than aborting. Pure: conflicted paths + the configured
// mirror (repo-root-relative). False when the mirror is unset, no paths
// conflicted, or any non-mirror file also conflicted. (#57; lccjs #313)
function isVelocityCsvOnlyConflict(paths, csvMirror) {
  if (!csvMirror) return false;
  const list = (paths || []).map((p) => String(p).trim()).filter(Boolean);
  return list.length > 0 && list.every((p) => p === csvMirror);
}

// A rebase whose ONLY conflicted paths are consumer-configured append-only
// markdown indexes is auto-resolvable: each agent appended a row at the bottom,
// a trivially mergeable conflict (keep both rows). Pure: conflicted paths + the
// configured file list (repo-root-relative). False when the list is empty, no
// paths conflicted, or any non-index file also conflicted. (#36 guard 4 / lccjs #971)
function isMarkdownIndexOnlyConflict(paths, files) {
  const set = (files || []).map((f) => String(f).trim()).filter(Boolean);
  if (set.length === 0) return false;
  const list = (paths || []).map((p) => String(p).trim()).filter(Boolean);
  return list.length > 0 && list.every((p) => set.includes(p));
}

// Resolve an append-only markdown conflict in text: drop git conflict-marker
// lines (keeping both sides' appended rows), then collapse any adjacent
// exact-duplicate non-blank line (two agents appending an identical row, which
// lands adjacent once the `=======` separator is removed). Blank lines are never
// deduped, so document spacing is preserved. The diff3 base marker (|||||||) is
// stripped too; for an append-only file the base section is empty, so the result
// is correct regardless of merge.conflictstyle. Pure text→text. (#36 guard 4 / lccjs #971)
function resolveAppendOnlyMarkdownConflict(text) {
  const MARKERS = ['<<<<<<<', '|||||||', '=======', '>>>>>>>'];
  const out = [];
  for (const line of String(text).split('\n')) {
    if (MARKERS.some((m) => line.startsWith(m))) continue;
    if (line !== '' && out.length > 0 && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.join('\n');
}

// Scan open tracker issues for an UNCHECKED checklist box referencing the given
// child issue. Pure: takes [{number, body}] + issue number (int or string),
// returns [{trackerNumber, line}] (line trimmed) per matched line, in document
// order. (#36 guard 3 / lccjs #907)
function findParentTrackers(issues, issueNumber) {
  const re = new RegExp(`- \\[ \\].*#${issueNumber}\\b`);
  const matches = [];
  for (const iss of (issues || [])) {
    for (const line of String((iss && iss.body) || '').split('\n')) {
      if (re.test(line)) matches.push({ trackerNumber: iss.number, line: line.trim() });
    }
  }
  return matches;
}

// Tick the checklist box(es) referencing the given child issue in a tracker
// body: flip `- [ ]` → `- [x]` on a line whose SOLE issue ref is that child (a
// multi-ref line is left alone — never prematurely check an umbrella box). Pure
// text→text; returns the body unchanged when nothing safe matches.
// (#36 guard 3 / lccjs #907)
function tickCheckboxForIssue(body, issueNumber) {
  const re = new RegExp(`- \\[ \\].*#${issueNumber}\\b`);
  return String(body || '').split('\n').map((line) => {
    if (!re.test(line)) return line;
    const refs = line.match(/#\d+/g) || [];
    if (refs.length !== 1) return line;
    return line.replace('- [ ]', '- [x]');
  }).join('\n');
}

// Guard 1 decision (lccjs #361): given the velocity rows {ticket, agent}, the
// issue, and the closing agent, return the mismatching ticket numbers (empty =
// pass). If ANY row records the correct ticket the close is consistent; only
// when none do, filter to the closing agent's own rows to catch a wrong-ticket
// log (the #278 digit-transposition) without false-blocking on a concurrent
// agent's unrelated row.
function computeVelocityMismatch(rows, issue, closingAgent) {
  const n = Number(issue);
  const all = rows || [];
  if (all.some((r) => r.ticket != null && Number(r.ticket) === n)) return [];
  const mine = closingAgent
    ? all.filter((r) => String(r.agent).toLowerCase() === String(closingAgent).toLowerCase())
    : all;
  return velocityTicketMismatch(mine.map((r) => r.ticket), issue);
}

// --- release-command seams (#22; the cleanup half of close, shared core) -----

// Parse `git worktree list --porcelain` into [{path, branch}] (branch short
// name, refs/heads/ stripped; detached entries keep branch null). Pure.
function parseWorktreePorcelain(porcelain) {
  const rows = [];
  let cur = null;
  for (const line of String(porcelain || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length).trim(), branch: null };
      rows.push(cur);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim().replace('refs/heads/', '');
    }
  }
  return rows;
}

// The worktree staked for issue N: branch matching `[-/]issue-<N>` (so both
// legacy `<agent>/issue-<N>` and new-scheme `…-issue-<N>` branches match by
// branch, mirroring claimCore.worktreesWithIssue, #51) or path basename ending
// `-issue-<N>`. Skips the main entry (rows[0]). The `(?:[^0-9]|$)` boundary
// keeps `issue-9` from matching `issue-99`. Pure: rows + issue → {path, branch} | null.
function findWorktreeForIssue(rows, issue) {
  const reBranch = new RegExp(`[-/]issue-${issue}(?:[^0-9]|$)`);
  const rePath = new RegExp(`-issue-${issue}$`);
  for (const r of (rows || []).slice(1)) {
    const base = String(r.path).split('/').pop();
    if ((r.branch && reBranch.test(r.branch)) || rePath.test(base)) return r;
  }
  return null;
}

// The release data-loss guard decision (#22). ahead = commits on the branch not
// on origin/main; dirty = worktree has uncommitted changes; force = --force.
// Returns 'unpushed' | 'dirty' | 'ok' (ahead checked first). Pure.
function releaseGuardVerdict(ahead, dirty, force) {
  if (force) return 'ok';
  if (Number(ahead) > 0) return 'unpushed';
  if (dirty) return 'dirty';
  return 'ok';
}

// Pure arg parser for the release CLI (#46): `release <N> [--force]`. Accepts a
// single numeric issue, a `--force` flag, and a bare `--` separator (skipped).
// THROWS on a second issue number or any other token (the impure release.js
// wrapper turns the throw into a usage die, exit 2). A missing issue yields
// issue=null — the wrapper validates and dies, so the parser stays pure.
function parseReleaseArgs(argv) {
  const a = { issue: null, force: false };
  for (const t of argv) {
    if (t === '--force') a.force = true;
    else if (t === '--') continue;
    else if (/^\d+$/.test(t)) {
      if (a.issue !== null) throw new Error(`unexpected extra arg: ${t} (usage: release <N> [--force])`);
      a.issue = t;
    } else throw new Error(`unknown arg: ${t} (usage: release <N> [--force])`);
  }
  return a;
}

module.exports = {
  DEFAULT_MAX_RETRIES, UNION_FILES, KEYWORD_STOP_SET, SHORT_TECH_WORDS,
  isSafeRef,
  classifyPushError, shouldCleanup,
  claimRefDeleteCommand, classifyClaimRefDelete,
  classifyRebaseConflict, bodyClosesIssue, pushedCommitReferencesIssue, unsupportedFlagHint,
  extractKeywords, keywordsOverlap,
  markerStillPresent, scopeAuditDiffCommand,
  velocityRowPresent, velocityTicketMismatch, computeVelocityMismatch,
  isVelocityCsvOnlyConflict, isMarkdownIndexOnlyConflict, resolveAppendOnlyMarkdownConflict,
  findParentTrackers, tickCheckboxForIssue,
  parseWorktreePorcelain, findWorktreeForIssue, releaseGuardVerdict,
  parseReleaseArgs,
};
