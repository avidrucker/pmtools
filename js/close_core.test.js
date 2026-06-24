// Golden-fixture parity tests for the pure close core. Run: node --test 'js/*.test.js'
//
// Loads the SAME fixtures/close/<fn>.cases.json files the Python harness grades,
// dispatches each fixture stem to the corresponding camelCase function, and asserts
// deepEqual(fn(...args), expected).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const close = require('./close_core');

const ROOT = path.resolve(__dirname, '..');
const CLOSE_FIXTURES = path.join(ROOT, 'fixtures', 'close');
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// extract_keywords' optional 2nd arg is a stop set; the JSON encodes it as an
// array, so wrap it in a Set to match the JS signature. Other fns take their
// args verbatim.
function extractKeywords(...args) {
  if (args.length === 2) return close.extractKeywords(args[0], new Set(args[1]));
  return close.extractKeywords(...args);
}

const DISPATCH = {
  classify_push_error: close.classifyPushError,
  should_cleanup: close.shouldCleanup,
  claim_ref_delete_command: close.claimRefDeleteCommand,
  classify_claim_ref_delete: close.classifyClaimRefDelete,
  classify_rebase_conflict: close.classifyRebaseConflict,
  body_closes_issue: close.bodyClosesIssue,
  extract_keywords: extractKeywords,
  keywords_overlap: close.keywordsOverlap,
  marker_still_present: close.markerStillPresent,
  scope_audit_diff_command: close.scopeAuditDiffCommand,
  velocity_row_present: close.velocityRowPresent,
  velocity_ticket_mismatch: close.velocityTicketMismatch,
  compute_velocity_mismatch: close.computeVelocityMismatch,
  parse_worktree_porcelain: close.parseWorktreePorcelain,
  find_worktree_for_issue: close.findWorktreeForIssue,
  release_guard_verdict: close.releaseGuardVerdict,
};

test('every close fixture file has a dispatch entry (1:1)', () => {
  const stems = fs.readdirSync(CLOSE_FIXTURES)
    .filter((f) => f.endsWith('.cases.json'))
    .map((f) => f.replace('.cases.json', ''))
    .sort();
  assert.deepEqual(stems, Object.keys(DISPATCH).sort());
});

for (const [stem, fn] of Object.entries(DISPATCH)) {
  const cases = load(path.join(CLOSE_FIXTURES, `${stem}.cases.json`));
  for (const c of cases) {
    test(`close:${stem} — ${c.name}`, () => {
      assert.deepEqual(fn(...c.args), c.expected);
    });
  }
}

test('UNION_FILES defaults to empty (any conflict is blocking in pmtools)', () => {
  assert.deepEqual(close.UNION_FILES, []);
});
