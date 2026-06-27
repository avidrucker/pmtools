// preflight_core.js — pure preflight-core functions, the twin of
// py/preflight_core.py. I/O-free decision seams only; graded against the shared
// fixtures/preflight/*.cases.json (the SAME files the Python harness loads).
//
// Extracted from preflight.js (#46) so the JS port honors the documented
// pure/impure split the Python port already had: preflight.js re-exports these
// and does only the git/gh I/O + wiring.
'use strict';

const DEFAULT_EVIDENCE_DIRS = ['docs/logs', 'docs/research'];

// Pure: OPEN-state gate from a gh `state` string (or null when gh unavailable).
function preflightIssueGate(state) {
  if (state == null || String(state).trim() === '') {
    return { ok: true, warn: 'issue state unknown (gh unavailable) — proceeding best-effort.' };
  }
  const s = String(state).trim().toUpperCase();
  if (s === 'OPEN') return { ok: true };
  return { ok: false, error: `issue is ${s}, not OPEN — nothing to start (raced a close?). Pick another issue.` };
}

// Pure: surface in-repo evidence for every #N referenced in `text`, matching
// `<dir>/<N>-slug.md` ANCHORED to the basename prefix (so #76 != 1076-*).
// `evidenceDirs` is injected (parameterized) rather than hardcoded.
function preflightEvidence(text, fileList, evidenceDirs = DEFAULT_EVIDENCE_DIRS) {
  const refs = new Set();
  const re = /#(\d+)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) refs.add(m[1]);

  const dirs = evidenceDirs.map((d) => (d.endsWith('/') ? d : d + '/'));
  const hits = new Set();
  for (const f of Array.isArray(fileList) ? fileList : []) {
    const p = String(f).replace(/^\.\//, '');
    const dir = dirs.find((d) => p.startsWith(d));
    if (!dir) continue;
    const prefix = p.slice(dir.length).match(/^(\d+)-/);
    if (prefix && refs.has(prefix[1])) hits.add(p);
  }
  return Array.from(hits).sort();
}

module.exports = { preflightIssueGate, preflightEvidence, DEFAULT_EVIDENCE_DIRS };
