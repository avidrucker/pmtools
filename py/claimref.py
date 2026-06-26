"""claimref.py — best-effort, idempotent claim-ref delete shared by close +
release (#74). Previously duplicated in both with a silent drift: release passed
--no-verify (so a messy tree can't block its own cleanup) where close did not.
That difference is now an explicit option; the caller passes its own tagged `log`
so the message keeps the [close]/[release] prefix. Twin of js/claimref.js.
"""
from sh import sh
from close_core import claim_ref_delete_command, classify_claim_ref_delete


def delete_claim_ref(issue, log, no_verify=False):
    flag = " --no-verify" if no_verify else ""
    out = sh("{}{} 2>&1 || true".format(claim_ref_delete_command(issue), flag), True) or ""
    verdict = classify_claim_ref_delete(out)
    if verdict == "DELETED":
        log("claim ref refs/claims/issue-{} deleted.".format(issue))
    elif verdict == "ABSENT":
        log("claim ref refs/claims/issue-{} already absent — no-op.".format(issue))
    else:
        log("warn: could not delete claim ref refs/claims/issue-{} "
            "(best-effort; continuing).".format(issue))
