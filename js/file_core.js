// file_core.js — pure decision seam for `pmtools file` (gated issue creation,
// #111). I/O-free; graded against fixtures/file/*.cases.json (the SAME files the
// Python harness loads). Twin of py/file_core.py.
//
// fileGateVerdict(opts, cfg) validates the creation request against the `create`
// config block and returns { ok, violations, labels }:
//   - violations: [{ gate, severity: 'hard'|'soft', message }] in a fixed order
//     (area → role → severity → bodyShape → titleHygiene). A HARD violation blocks
//     creation (ok=false); a SOFT one is a `[file] note:` and never blocks.
//   - labels: the resolved label set to hand to provider.createIssue.
'use strict';

const { VALID_ROLES } = require('./store_core');
const { needsAreaLabel } = require('./claim_core');

const AREA_PREFIX = 'area:';

// Ordered de-dup of a label list (drops non-string / empty).
function dedupeLabels(labels) {
  return [...new Set((labels || []).filter((l) => typeof l === 'string' && l))];
}

function fileGateVerdict(opts, cfg) {
  const o = opts || {};
  const c = cfg || {};
  const violations = [];

  const area = (typeof o.area === 'string' && o.area) ? o.area : null;
  const role = (typeof o.role === 'string' && o.role) ? o.role : null;
  const severity = (typeof o.severity === 'string' && o.severity) ? o.severity : null;
  const title = typeof o.title === 'string' ? o.title : '';
  const body = typeof o.body === 'string' ? o.body : '';
  const allowUncategorized = Boolean(o.allowUncategorized);

  // Resolved label set = passthrough --label values + the --area label.
  const resolved = dedupeLabels(o.labels);
  if (area) resolved.push(`${AREA_PREFIX}${area}`);

  const validAreas = Array.isArray(c.validAreas) ? c.validAreas : [];
  const validAreaSet = new Set(validAreas);
  const areaLabels = resolved.filter((l) => l.startsWith(AREA_PREFIX));
  const realAreas = areaLabels.filter((l) => validAreaSet.has(l.slice(AREA_PREFIX.length)));
  const areaGateOn = c.requireArea !== false && validAreas.length > 0;

  // --- 1. Area gate ---
  if (areaGateOn) {
    if (allowUncategorized) {
      if (realAreas.length !== 1) {
        const fb = (typeof c.uncategorizedFallback === 'string' && c.uncategorizedFallback)
          ? c.uncategorizedFallback : 'area:uncategorized';
        if (!resolved.includes(fb)) resolved.push(fb);
        violations.push({ gate: 'area', severity: 'soft',
          message: `filed as ${fb} (--allow-uncategorized) — assign a real area:* before work begins` });
      }
    } else if (areaLabels.length > 1) {
      violations.push({ gate: 'area', severity: 'hard',
        message: `exactly one area:* label allowed — got ${areaLabels.join(', ')}` });
    } else if (needsAreaLabel(resolved) || realAreas.length !== 1) {
      violations.push({ gate: 'area', severity: 'hard',
        message: `requires exactly one area:* label from [${validAreas.join(', ')}] — `
          + 'pass --area <one>, or --allow-uncategorized to defer' });
    }
  }

  // --- 2. Role gate (validate-only; role lives in the body, not a label) ---
  if (c.requireRole !== false) {
    if (!role) {
      violations.push({ gate: 'role', severity: 'hard',
        message: 'requires --role (a valid role, e.g. DEV, RESEARCH, WRITER)' });
    } else if (!VALID_ROLES.includes(role)) {
      violations.push({ gate: 'role', severity: 'hard',
        message: `role "${role}" is not a valid role` });
    }
  }

  // --- 3. Severity gate (severity:* only on defects — i.e. a `bug` label) ---
  if (severity) {
    if (c.severityOnlyOnDefects !== false && !resolved.includes('bug')) {
      violations.push({ gate: 'severity', severity: 'hard',
        message: `severity:${severity} is only allowed on a defect — add the \`bug\` label or drop --severity` });
    }
    resolved.push(`severity:${severity}`);
  }

  // --- 4. Body shape (soft; off by default) ---
  if (c.requireBodyShape === true) {
    const b = body.toLowerCase();
    if (!(b.includes('have') && b.includes('should'))) {
      violations.push({ gate: 'bodyShape', severity: 'soft',
        message: 'body is missing the have/should shape' });
    }
  }

  // --- 5. Title hygiene (soft; fires only when bannedTitleWords is non-empty) ---
  const banned = Array.isArray(c.bannedTitleWords) ? c.bannedTitleWords : [];
  if (banned.length) {
    const t = title.toLowerCase();
    const hits = banned.filter((w) => typeof w === 'string' && w && t.includes(w.toLowerCase()));
    if (hits.length) {
      violations.push({ gate: 'titleHygiene', severity: 'soft',
        message: `title contains discouraged word(s): ${hits.join(', ')}` });
    }
  }

  const ok = violations.every((v) => v.severity !== 'hard');
  return { ok, violations, labels: dedupeLabels(resolved) };
}

module.exports = { fileGateVerdict };
