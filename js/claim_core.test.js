// Golden-fixture parity tests for the pure claim core. Run: node --test 'js/*.test.js'
//
// Loads the SAME fixtures/claim/<fn>.cases.json files the Python harness grades,
// dispatches each fixture stem to the corresponding camelCase function, and asserts
// deepEqual(fn(...args), expected). Also re-checks the shared status reconcile edge
// fixtures so JS and Python agree on the same golden output.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const claim = require('./claim_core');
const { reconcile } = require('./reconcile');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const CLAIM_FIXTURES = path.join(FIXTURES, 'claim');
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// fixture stem (snake_case) -> pure callable (camelCase)
const DISPATCH = {
  slugify: claim.slugify,
  is_safe_ref: claim.isSafeRef,
  normalize_identity: claim.normalizeIdentity,
  infer_fruit_from_branch: claim.inferFruitFromBranch,
  resolve_identity: claim.resolveIdentity,
  parse_args: claim.parseArgs,
  check_identity_name: claim.checkIdentityName,
  assess_base_staleness: claim.assessBaseStaleness,
  sentinel_branch: claim.sentinelBranch,
  is_sentinel_stale_by_age: claim.isSentinelStaleByAge,
  apply_marker_flip: claim.applyMarkerFlip,
  worktrees_with_issue: claim.worktreesWithIssue,
  find_live_worktree_for_issue: claim.findLiveWorktreeForIssue,
  find_same_issue_collision: claim.findSameIssueCollision,
  should_block_worktree_guard: claim.shouldBlockWorktreeGuard,
  should_block_claim: claim.shouldBlockClaim,
  needs_area_label: claim.needsAreaLabel,
  should_block_uncategorized: claim.shouldBlockUncategorized,
  classify_claim_push_result: claim.classifyClaimPushResult,
  build_claim_message: claim.buildClaimMessage,
  claim_push_action: claim.claimPushAction,
  claim_ref_is_stale: claim.claimRefIsStale,
  build_banner_lines: claim.buildBannerLines,
  lang_tag: claim.langTag,
  build_branch: claim.buildBranch,
  build_worktree_name: claim.buildWorktreeName,
  branch_to_worktree_name: claim.branchToWorktreeName,
};

test('every claim fixture file has a dispatch entry (1:1)', () => {
  const stems = fs.readdirSync(CLAIM_FIXTURES)
    .filter((f) => f.endsWith('.cases.json'))
    .map((f) => f.replace('.cases.json', ''))
    .sort();
  assert.deepEqual(stems, Object.keys(DISPATCH).sort());
});

for (const [stem, fn] of Object.entries(DISPATCH)) {
  const cases = load(path.join(CLAIM_FIXTURES, `${stem}.cases.json`));
  for (const c of cases) {
    test(`claim:${stem} — ${c.name}`, () => {
      assert.deepEqual(fn(...c.args), c.expected);
    });
  }
}

// The three new status reconcile edge fixtures, graded against the same golden output.
for (const name of ['empty', 'two-worktrees', 'same-issue-two-markers']) {
  test(`status edge fixture: ${name}`, () => {
    const input = load(path.join(FIXTURES, `${name}.input.json`));
    const expected = load(path.join(FIXTURES, `${name}.expected.json`));
    const result = reconcile(input.grep, input.worktrees, input.issues);
    assert.deepEqual(result, expected);
  });
}
