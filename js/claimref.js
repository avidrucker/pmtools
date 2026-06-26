// claimref.js — best-effort, idempotent claim-ref delete shared by close +
// release (#74). Previously duplicated in both with a silent drift: release
// passed --no-verify (so a messy tree can't block its own cleanup) where close
// did not. That difference is now an explicit option; the caller passes its own
// tagged `log` so the message keeps the [close]/[release] prefix.
'use strict';

const { sh } = require('./sh');
const { claimRefDeleteCommand, classifyClaimRefDelete } = require('./close_core');

function deleteClaimRef(issue, { noVerify = false, log } = {}) {
  const flag = noVerify ? ' --no-verify' : '';
  const out = sh(`${claimRefDeleteCommand(issue)}${flag} 2>&1 || true`, true) || '';
  const verdict = classifyClaimRefDelete(out);
  if (verdict === 'DELETED') log(`claim ref refs/claims/issue-${issue} deleted.`);
  else if (verdict === 'ABSENT') log(`claim ref refs/claims/issue-${issue} already absent — no-op.`);
  else log(`warn: could not delete claim ref refs/claims/issue-${issue} (best-effort; continuing).`);
}

module.exports = { deleteClaimRef };
