// Pure ICE-scoring core (no I/O) for the pmtools `ice` store.
//
// JS twin of py/ice_core.py — mirrors every function 1:1 and is graded against
// the SAME fixtures/ice/*.cases.json the Python harness loads. Where Python
// raises ValueError, this throws Error. Validation-FAILURE fixtures use
// {"name":..., "args":[row], "expected_error": true}.
//
// Scales: I 3/2/1/0.5/0.25 · C 1.0/0.8/0.5 · E 10/7/5/3/1.
// Formula: ICE = I*C*E (higher Ease => higher ICE); tiebreak +1/(issue*1000).
'use strict';

// Empty/None -> null, else String(v). Mirrors py _to_str / lccjs toStr.
function toStr(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

// Closed input vocabularies — a value outside the set is rejected.
const VALID_I = [0.25, 0.5, 1, 2, 3];
const VALID_C = [0.5, 0.8, 1.0];
const VALID_E = [1, 3, 5, 7, 10];

// Tier overrides sit above the normal ICE queue (lower = sorts first).
const ICE_TIER_ORDER = { critical: 0, elevated: 1, '': 2 };

// Stored (INSERT) columns — ice_rank is NOT stored; it is derived at export.
const ICE_COLS = [
  'id', 'issue', 'title', 'type', 'I', 'C', 'E', 'ice_score', 'tier',
  'yegor_priority', 'actionable', 'provisional', 'labels', 'notes', 'updated_iso',
];
// CSV export columns — inserts the derived ice_rank after ice_score and drops id,
// matching the lccjs stats/ice-scores.csv this store replaces.
const ICE_CSV_COLS = [
  'issue', 'title', 'type', 'I', 'C', 'E', 'ice_score', 'ice_rank', 'tier',
  'yegor_priority', 'actionable', 'provisional', 'labels', 'notes', 'updated_iso',
];

// ICE = round(I*C*E, 4). Multiplicative (lccjs #1327). Math.round is half-up,
// matching py int(x*10000 + 0.5) for the non-negative ICE domain.
function computeIce(I, C, E) {
  return Math.round(I * C * E * 10000) / 10000;
}

// Tiebreaker: earlier issues win ties but cannot flip a higher score.
function finalScore(ice, issue) {
  return ice + 1 / (issue * 1000);
}

// Stable sort by tier (critical > elevated > normal) then finalScore desc.
function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const ta = ICE_TIER_ORDER[a.tier || ''] ?? 2;
    const tb = ICE_TIER_ORDER[b.tier || ''] ?? 2;
    if (ta !== tb) return ta - tb;
    return finalScore(b.ice_score || 0, b.issue) - finalScore(a.ice_score || 0, a.issue);
  });
}

// sortRows + a 1-based ice_rank on each row (returns new objects).
function rankRows(rows) {
  return sortRows(rows).map((r, i) => ({ ...r, ice_rank: i + 1 }));
}

// Provisional {I,C,E} from labels alone (the --auto sweep). I from severity,
// C a neutral 0.8, E a coarse guess from the type label. provisional=1.
function deriveAutoScore(labels) {
  const names = (labels || []).filter((l) => l && typeof l === 'object').map((l) => l.name);
  let I;
  if (names.includes('severity:critical')) I = 3;
  else if (names.includes('severity:high')) I = 2;
  else if (names.includes('severity:medium')) I = 1;
  else if (names.includes('severity:low')) I = 0.5;
  else I = 1;
  let E;
  if (names.some((n) => ['documentation', 'chore', 'cleanup', 'style'].includes(n))) E = 7;
  else if (names.some((n) => ['research', 'spike', 'experiment'].includes(n))) E = 3;
  else E = 5;
  return { I, C: 0.8, E };
}

// The override tier from priority:* labels, or '' for the normal queue.
function detectIceTier(labels) {
  const names = (labels || []).filter((l) => l && typeof l === 'object').map((l) => l.name);
  if (names.includes('priority:critical')) return 'critical';
  if (names.includes('priority:elevated')) return 'elevated';
  return '';
}

// null/'' -> null; a value in `valid` -> the number; else throw.
function toIceInput(name, v, valid) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number`);
  if (!valid.includes(n)) {
    throw new Error(`"${name}" must be one of ${JSON.stringify(valid)} — got ${v}`);
  }
  return n;
}

// Validate + normalise an ICE row. Required: issue (positive int). I/C/E
// optional but, if given, must be in their valid sets; ice_score computed when
// all three present. Returns the non-id, non-updated_iso ICE_COLS (CLI stamps those).
function validateIceRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('ice row must be an object');
  }
  const issue = row.issue;
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue <= 0) {
    throw new Error('"issue" must be a positive integer');
  }
  const I = toIceInput('I', row.I, VALID_I);
  const C = toIceInput('C', row.C, VALID_C);
  const E = toIceInput('E', row.E, VALID_E);
  const ice_score = (I !== null && C !== null && E !== null) ? computeIce(I, C, E) : null;
  const yp = row.yegor_priority;
  const yegor_priority = Number.isInteger(yp) ? yp : null;

  return {
    issue,
    title: toStr(row.title),
    type: toStr(row.type),
    I,
    C,
    E,
    ice_score,
    tier: toStr(row.tier) || '',
    yegor_priority,
    actionable: toStr(row.actionable) || 'Y',
    provisional: (row.provisional === 1 || row.provisional === true) ? 1 : 0,
    labels: toStr(row.labels),
    notes: toStr(row.notes),
  };
}

module.exports = {
  VALID_I, VALID_C, VALID_E, ICE_TIER_ORDER, ICE_COLS, ICE_CSV_COLS,
  toStr, computeIce, finalScore, sortRows, rankRows,
  deriveAutoScore, detectIceTier, validateIceRow,
};
