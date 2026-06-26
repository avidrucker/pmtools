// store.js — IMPURE sqlite engine for the pmtools error + velocity stores.
//
// JS twin of py/store.py. Python uses the stdlib sqlite3 module; Node v24 has no
// stable bundled sqlite, and the brief forbids node:sqlite, so this port shells
// out to the `sqlite3` CLI instead. SQLite is the source of truth; the CSV
// mirror (exportCsv) is a derived full-table dump written via store_core's
// encoders (NOT sqlite3's own .mode csv) so the bytes match the Python output
// exactly, preamble included.
//
// Schemas + indices are copied verbatim from py/store.py (which copied them from
// the lccjs seed scripts). connect() is idempotent (CREATE ... IF NOT EXISTS),
// so the first write to a fresh DB seeds it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const core = require('./store_core');
const { expanduser } = require('./config');

// --- schema (verbatim from py/store.py) --------------------------------------

const CREATE_ERRORS = `CREATE TABLE IF NOT EXISTS errors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_iso TEXT    NOT NULL,
  agent        TEXT,
  model        TEXT,
  ticket       INTEGER,
  repo         TEXT,
  error_type   TEXT,
  message      TEXT,
  context      TEXT,
  notes        TEXT
);`;

const ERRORS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS errors_agent_time ON errors (agent, occurred_iso);',
  'CREATE INDEX IF NOT EXISTS errors_type ON errors (error_type);',
  'CREATE INDEX IF NOT EXISTS errors_ticket ON errors (ticket);',
];

const CREATE_VELOCITY = `CREATE TABLE IF NOT EXISTS velocity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket        INTEGER,
  title         TEXT,
  role          TEXT,
  h_min         REAL,
  c_min         REAL,
  actual_min    REAL,
  delta_h_min   REAL,
  delta_c_min   REAL,
  started_iso   TEXT,
  finished_iso  TEXT,
  closed_commit TEXT,
  notes         TEXT,
  agent         TEXT,
  model         TEXT,
  repo          TEXT
);`;

const VELOCITY_INDEXES = [
  // Partial unique index: NULL started_iso rows are excluded.
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_velocity_session '
  + 'ON velocity(ticket, agent, started_iso) WHERE started_iso IS NOT NULL;',
];

// Non-id columns, in schema order, per table — what insert() binds.
const INSERT_COLS = {
  errors: core.ERROR_COLS.filter((c) => c !== 'id'),
  velocity: core.VELOCITY_COLS.filter((c) => c !== 'id'),
};

const TABLES = ['errors', 'velocity'];

// expanduser + absolutise a DB path (mirrors py _resolve).
function resolveDb(dbPath) {
  return path.resolve(expanduser(dbPath));
}

// Run a SQL script through the sqlite3 CLI against `dbPath`. The script is passed
// on stdin; stdout (if any) is returned. Throws on a non-zero exit so callers
// can surface a DB failure (parity with the Python sqlite3 exceptions).
function runSql(dbPath, sql, extraArgs = []) {
  return execFileSync('sqlite3', [...extraArgs, dbPath], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// SQL-literal escaping for a single bound value. Numbers are emitted inline;
// null/undefined -> NULL; everything else is a string literal with single-quote
// doubling (the canonical SQLite escape) to defeat injection.
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite numeric value');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v);
  return "'" + s.replace(/'/g, "''") + "'";
}

// Base preamble — everything EXCEPT the velocity unique index. Always safe to
// run against any DB (CREATE ... IF NOT EXISTS is genuinely idempotent here).
const DDL_BASE = [
  'PRAGMA journal_mode = WAL;',
  CREATE_ERRORS,
  ...ERRORS_INDEXES,
  CREATE_VELOCITY,
].join('\n');

// True iff the velocity table already holds duplicate (ticket, agent,
// started_iso) groups that would block the partial unique index.
const VELOCITY_DUP_CHECK = 'SELECT 1 FROM velocity WHERE started_iso IS NOT NULL '
  + 'GROUP BY ticket, agent, started_iso HAVING COUNT(*) > 1 LIMIT 1;';

// Idempotently seed both tables (creating parent dirs). Returns the resolved path.
//
// The velocity unique index is DEDUP-GATED: a legacy DB whose velocity table
// already holds duplicate sessions can't host uq_velocity_session, and
// `IF NOT EXISTS` does NOT suppress a uniqueness violation over existing data —
// it only suppresses "index already exists". Creating it unconditionally would
// throw here and abort ALL logging (errors included), since connect() runs on
// every write to either store (#10). So: detect dups first, and skip + warn
// instead of aborting. A fresh/clean DB has no dups, so it still gets the index
// and full constraint enforcement.
function connect(dbPath) {
  const resolved = resolveDb(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  runSql(resolved, DDL_BASE);
  if (runSql(resolved, VELOCITY_DUP_CHECK).trim()) {
    console.warn(
      'pmtools: velocity has duplicate (ticket, agent, started_iso) rows; '
      + 'skipping the uq_velocity_session unique index (logging continues). '
      + 'Resolve the duplicates and re-run to add it.');
  } else {
    for (const idx of VELOCITY_INDEXES) runSql(resolved, idx);
  }
  return resolved;
}

// Insert a (pre-validated) row object into `table`; return the new row id.
function insert(dbPath, table, row) {
  if (!TABLES.includes(table)) {
    throw new Error(`unknown table ${JSON.stringify(table)}`);
  }
  const resolved = connect(dbPath);
  const cols = INSERT_COLS[table];
  const values = cols.map((c) => sqlLiteral(row[c]));
  // Single script: the INSERT then the new rowid, in one connection so
  // last_insert_rowid() reflects this INSERT.
  const sql = [
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values.join(', ')});`,
    'SELECT last_insert_rowid();',
  ].join('\n');

  const out = runSql(resolved, sql).trim();
  const rid = parseInt(out, 10);
  if (!Number.isFinite(rid)) {
    throw new Error(`could not read last_insert_rowid (got ${JSON.stringify(out)})`);
  }
  return rid;
}

// Return all rows of `table` ordered by id, as a list of plain objects.
// sqlite3 -json emits [] for an empty result (newer builds emit nothing).
function selectAll(dbPath, table) {
  if (!TABLES.includes(table)) {
    throw new Error(`unknown table ${JSON.stringify(table)}`);
  }
  const resolved = connect(dbPath);
  const out = runSql(resolved, `SELECT * FROM ${table} ORDER BY id;`, ['-json']).trim();
  if (!out) return [];
  return JSON.parse(out);
}

// Row count for `table`.
function count(dbPath, table) {
  if (!TABLES.includes(table)) {
    throw new Error(`unknown table ${JSON.stringify(table)}`);
  }
  const resolved = connect(dbPath);
  const out = runSql(resolved, `SELECT COUNT(*) FROM ${table};`).trim();
  return parseInt(out, 10) || 0;
}

// Export `table` to `csvPath` as a derived full-file mirror, byte-for-byte
// matching py/store.py.export_csv: line 1 = preamble (Source: <resolved db>),
// line 2 = header, then one line per row in `cols` order. Atomic temp->rename.
function exportCsv(dbPath, table, csvPath, cols) {
  const rows = selectAll(dbPath, table);
  const resolvedDb = resolveDb(dbPath);
  const lines = [core.csvPreamble(resolvedDb), core.csvHeader(cols)];
  for (const r of rows) lines.push(core.csvEncodeRow(r, cols));
  const body = lines.join('\n') + '\n';

  const out = path.resolve(expanduser(csvPath));
  const parent = path.dirname(out);
  if (parent) fs.mkdirSync(parent, { recursive: true });
  const tmp = out + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, out);
  return rows.length;
}

module.exports = {
  connect, insert, selectAll, count, exportCsv,
  CREATE_ERRORS, CREATE_VELOCITY,
};
