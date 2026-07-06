// Pure storage-core seams (no I/O) for the pmtools error + velocity stores.
//
// JS twin of py/store_core.py — mirrors every function 1:1 and is graded against
// the SAME fixtures/{error,velocity}/*.cases.json the Python harness loads. Where
// Python raises ValueError, this throws Error. Validation-FAILURE fixtures use
// the convention {"name":..., "args":[row], "expected_error": true}; both
// languages assert a raised/thrown error rather than a return value.
'use strict';

// ---------------------------------------------------------------------------
// vocabularies (copied verbatim from py/store_core.py / lccjs)
// ---------------------------------------------------------------------------

// error-log.js VALID_ERROR_TYPES (closed vocabulary — hard reject on unknown).
const ERROR_TYPES = [
  'TOOL_DENIED', 'HOOK_BLOCK', 'CLAIM_FAIL', 'BASH_FAIL', 'GIT_FAIL',
  'GIT_STATE', 'GH_FAIL', 'GH_INFO', 'DB_FAIL', 'FILE_FAIL', 'EDIT_PRECOND',
  'SKILL_FAIL', 'NETWORK_FAIL', 'VALIDATION_FAIL',
  'COMPLIANCE_FAIL', 'BEHAVIORAL_FAIL',
  'OTHER',
];

// velocity-log.js VALID_ROLES (closed vocabulary — hard reject on unknown).
// Each role's one-clause meaning is glossed in CONTRACT.md §velocity schema
// ("Role glosses", #95) — the single definition; do not duplicate it here.
const VALID_ROLES = [
  'DEV', 'TEST', 'WRITER', 'RESEARCH', 'SPIKE', 'ARC', 'PM', 'COMBO',
  'DATA', 'CHORE', 'REVIEW',
];

// Canonical model format (e.g. opus-4.8). errors: hard reject; velocity: notice.
const CANONICAL_MODEL = /^[a-z]+-\d+\.\d+$/;

// Column order for each table — drives BOTH the INSERT and the CSV export header.
const ERROR_COLS = [
  'id', 'occurred_iso', 'agent', 'model', 'ticket', 'repo',
  'error_type', 'message', 'context', 'notes',
];

const VELOCITY_COLS = [
  'id', 'ticket', 'title', 'role',
  'h_min', 'c_min', 'actual_min', 'delta_h_min', 'delta_c_min',
  'started_iso', 'finished_iso', 'closed_commit',
  'notes', 'agent', 'model', 'repo',
];

// ---------------------------------------------------------------------------
// small value helpers (mirror py _to_str / _to_optional_number semantics)
// ---------------------------------------------------------------------------

// Empty/None -> null, else String(v). Mirrors Python _to_str (and lccjs toStr).
function toStr(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

// Python's `isinstance(x, int)` is true for bools; py code explicitly excludes
// bools and requires a true integer. Mirror that: a positive integer, not bool.
function isPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

// None/'' -> null; finite number -> that number; else throw. Mirrors
// velocity-log.js parseOptionalNumber / py _to_optional_number. Integral floats
// are normalised to int (20.0 -> 20); in JS all numbers are doubles so an
// integral value already compares == its int form.
function toOptionalNumber(name, v) {
  if (v === null || v === undefined || v === '') return null;
  // Python float() accepts numeric strings and numbers; bool is numeric in py
  // but here we only accept numbers and numeric strings, rejecting bools to be
  // safe (py float(True)==1.0, but fixtures never feed bools to numeric fields).
  let n;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    n = Number(trimmed);
  } else {
    throw new Error(`"${name}" must be a finite number`);
  }
  if (!Number.isFinite(n)) {
    throw new Error(`"${name}" must be a finite number`);
  }
  return n;
}

function toOptionalNonnegNumber(name, v) {
  const n = toOptionalNumber(name, v);
  if (n === null) return null;
  if (n < 0) throw new Error(`"${name}" must be >= 0`);
  return n;
}

// ---------------------------------------------------------------------------
// delta derivation (velocity-log.js deriveDelta)
// ---------------------------------------------------------------------------

// estimate - actual, or null when either operand is null.
function deriveDelta(estimate, actual) {
  if (estimate === null || estimate === undefined || actual === null || actual === undefined) {
    return null;
  }
  return estimate - actual;
}

// ---------------------------------------------------------------------------
// context normalisation (error-log.js normalizeContext)
// ---------------------------------------------------------------------------

// null/'' -> null; object/array -> compact JSON string; string -> must already
// be valid JSON (else throw).
function normalizeContext(ctx) {
  if (ctx === null || ctx === undefined || ctx === '') return null;
  if (typeof ctx === 'object') {
    // arrays and plain objects both serialize compactly
    return JSON.stringify(ctx);
  }
  const s = String(ctx);
  try {
    JSON.parse(s);
  } catch (e) {
    throw new Error(
      `"context" must be valid JSON (pass an object, or a JSON string) — ` +
      `got ${JSON.stringify(s.slice(0, 60))}: ${e.message}`,
    );
  }
  return s;
}

// ---------------------------------------------------------------------------
// row validators — return a normalised row object, or throw Error
// ---------------------------------------------------------------------------

function validateErrorRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('error row must be an object');
  }

  const occurred = row.occurred_iso;
  if (!occurred || typeof occurred !== 'string') {
    throw new Error('Missing required field: "occurred_iso"');
  }

  const message = row.message;
  if (message === null || message === undefined || String(message).trim() === '') {
    throw new Error(
      'Missing required field: "message" — a row with only a timestamp ' +
      'and error_type cannot be classified or acted on (analytically ' +
      'useless). Provide a short description of what failed.',
    );
  }

  const errorType = row.error_type;
  if (errorType !== null && errorType !== undefined && !ERROR_TYPES.includes(errorType)) {
    throw new Error(
      `unknown error_type "${errorType}" (valid: ${ERROR_TYPES.join(', ')})`,
    );
  }

  const model = row.model;
  if (model !== null && model !== undefined && model !== '' && !CANONICAL_MODEL.test(String(model))) {
    throw new Error(
      '"model" must follow canonical format <family>-<major>.<minor> ' +
      `(e.g. sonnet-4.6) — got "${model}"`,
    );
  }

  const ticket = row.ticket;
  if (ticket !== null && ticket !== undefined) {
    if (!isPositiveInt(ticket)) {
      throw new Error(`"ticket" must be a positive integer — got ${ticket}`);
    }
  }

  return {
    occurred_iso: occurred,
    agent: toStr(row.agent),
    model: toStr(model),
    ticket: (ticket !== null && ticket !== undefined) ? ticket : null,
    repo: toStr(row.repo),
    error_type: toStr(errorType),
    message: toStr(message),
    context: normalizeContext(row.context),
    notes: toStr(row.notes),
  };
}

function validateVelocityRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('velocity row must be an object');
  }

  const role = row.role;
  if (role === null || role === undefined || role === '') {
    throw new Error('Missing required field: "role"');
  }
  const agent = row.agent;
  if (agent === null || agent === undefined || agent === '') {
    throw new Error('Missing required field: "agent"');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`unknown role "${role}" (valid: ${VALID_ROLES.join(', ')})`);
  }

  const ticket = row.ticket;
  if (ticket !== null && ticket !== undefined) {
    if (!isPositiveInt(ticket)) {
      throw new Error('"ticket" must be a positive integer when provided');
    }
  }

  const hMin = toOptionalNonnegNumber('h_min', row.h_min);
  const cMin = toOptionalNonnegNumber('c_min', row.c_min);
  const actualMin = toOptionalNonnegNumber('actual_min', row.actual_min);

  return {
    ticket: (ticket !== null && ticket !== undefined) ? ticket : null,
    title: toStr(row.title),
    role,
    h_min: hMin,
    c_min: cMin,
    actual_min: actualMin,
    delta_h_min: deriveDelta(hMin, actualMin),
    delta_c_min: deriveDelta(cMin, actualMin),
    started_iso: toStr(row.started_iso),
    finished_iso: toStr(row.finished_iso),
    closed_commit: toStr(row.closed_commit),
    notes: toStr(row.notes),
    agent,
    model: toStr(row.model),
    repo: toStr(row.repo),
  };
}

// A non-canonical/new model is recorded but NOTICED for velocity. Returns a
// one-line notice string, or null when no notice is due.
function modelNotice(row) {
  const model = (row && typeof row === 'object') ? row.model : null;
  if (model !== null && model !== undefined && model !== '' && !CANONICAL_MODEL.test(String(model))) {
    return (
      `model "${model}" is new or non-canonical (canonical form is ` +
      `<family>-<major>.<minor>, e.g. opus-4.8) — recording it anyway`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV encoders (velocity-export.js encodeField/encodeRow + the preamble)
// ---------------------------------------------------------------------------

// RFC-4180 field encoding: null -> ''; quote+double-escape when the value
// contains a comma, double-quote, CR, or LF.
function csvEncodeField(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Encode one row object into a CSV line, in `cols` order.
function csvEncodeRow(row, cols) {
  return cols.map((c) => csvEncodeField(row[c])).join(',');
}

// The header line: the columns joined by commas.
function csvHeader(cols) {
  return cols.join(',');
}

// First line of every exported CSV — the AUTO-GENERATED provenance banner.
function csvPreamble(dbPath) {
  return `# AUTO-GENERATED by pmtools — do not edit directly. Source: ${dbPath}`;
}

// Pure CLI arg parser shared by the error + velocity wrappers (their argv shape
// is identical: `<cmd> [json] [--db-path P] [--csv P | --no-csv]`). The wrappers
// previously each inlined this; promoting it here removes that duplication and
// makes it gradeable against fixtures/{error,velocity}/parse_args.cases.json (#46).
// An unknown --flag THROWS (the impure wrapper catches it and dies, exit 2) so
// the parser stays pure/testable for every valid input. `--db-path`/`--csv` as
// the last token (no value to consume) yield null.
function parseStoreArgs(argv) {
  const a = { cmd: null, json: null, dbPath: null, csv: null, noCsv: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--db-path') { a.dbPath = (i + 1 < argv.length) ? argv[++i] : null; }
    else if (t === '--csv') { a.csv = (i + 1 < argv.length) ? argv[++i] : null; }
    else if (t === '--no-csv') { a.noCsv = true; }
    else if (t.startsWith('--')) { throw new Error('unknown flag: ' + t); }
    else { positionals.push(t); }
  }
  a.cmd = positionals.length ? positionals[0] : null;
  a.json = positionals.length > 1 ? positionals[1] : null;
  return a;
}

// Pure: the CSV mirror path to export to, or null. `--no-csv` wins; then an
// explicit `--csv`; then the project config's <store>.csvMirror. Shared by the
// error + velocity wrappers (#46).
function resolveCsv(args, storeCfg) {
  if (args.noCsv) return null;
  if (args.csv) return args.csv;
  return storeCfg.csvMirror;
}

module.exports = {
  ERROR_TYPES, VALID_ROLES, CANONICAL_MODEL, ERROR_COLS, VELOCITY_COLS,
  deriveDelta, normalizeContext, validateErrorRow, validateVelocityRow,
  modelNotice, csvEncodeField, csvEncodeRow, csvHeader, csvPreamble,
  parseStoreArgs, resolveCsv,
};
