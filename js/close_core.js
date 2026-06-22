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

module.exports = {
  DEFAULT_MAX_RETRIES, UNION_FILES, KEYWORD_STOP_SET, SHORT_TECH_WORDS,
  classifyPushError, shouldCleanup,
  claimRefDeleteCommand, classifyClaimRefDelete,
  classifyRebaseConflict, bodyClosesIssue,
  extractKeywords, keywordsOverlap,
  markerStillPresent, scopeAuditDiffCommand,
};
