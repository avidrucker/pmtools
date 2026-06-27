// Pure `status` reconciliation core. See ../CONTRACT.md for the spec.
// Mirrors py/reconcile.py exactly — both are graded against fixtures/.
'use strict';

const { isBlocked } = require('./status_core');

/**
 * Join markers + worktrees + issue state into a status report.
 * @param {Array<{file,line,keyword,issue}>} grep
 * @param {Array<{branch,issue,agent}>} worktrees
 * @param {Array<{number,state,labels}>} issues
 * @returns {{markers: Array, stale: Array}}
 */
function reconcile(grep, worktrees, issues) {
  const stateByIssue = new Map(issues.map((r) => [r.number, r.state]));
  const labelsByIssue = new Map(issues.map((r) => [r.number, r.labels]));
  const blockedByCountByIssue = new Map(issues.map((r) => [r.number, r.blockedByCount]));
  const agentByIssue = new Map(worktrees.map((r) => [r.issue, r.agent]));

  const markers = grep.map((m) => {
    const state = stateByIssue.has(m.issue) ? stateByIssue.get(m.issue) : 'UNKNOWN';
    const worktree = agentByIssue.has(m.issue) ? agentByIssue.get(m.issue) : null;

    let status;
    if (worktree !== null) {
      // A live worktree exists: distinguish actively-in-progress work
      // (@inprogress) from claimed-but-not-started (@todo). (#77)
      status = m.keyword === '@inprogress' ? 'IN-PROGRESS' : 'CLAIMED';
    } else if (state === 'CLOSED' || m.keyword === '@inprogress') {
      status = 'STALE';
    } else {
      status = 'IDLE';
    }

    return {
      issue: m.issue,
      file: m.file,
      line: m.line,
      keyword: m.keyword,
      state,
      worktree,
      status,
      // Overlay flag (#78, extended #87), orthogonal to status: true iff the
      // issue carries the `blocked` label OR has an active `blocked-by` relation.
      // Absent labels / count (issue not in `issues`) → false.
      blocked: isBlocked(labelsByIssue.get(m.issue), blockedByCountByIssue.get(m.issue) || 0),
    };
  });

  const stale = markers.filter((m) => m.status === 'STALE');
  return { markers, stale };
}

module.exports = { reconcile };
