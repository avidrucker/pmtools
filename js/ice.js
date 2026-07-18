#!/usr/bin/env node
// ice.js — score GitHub issues by ICE (Impact x Confidence x Ease). Twin of py/ice.py.
//
//   ice score '<batch json>'        {"<issue>":{"I":_,"C":_,"E":_, ...}} upsert (human, provisional=0)
//   ice score --auto [--dry-run]    provisionally score unscored open issues from labels
//   ice list [--label S] [--json]   ranked view (table or JSON)
//   ice export [--csv P]            ranked CSV mirror (ICE_CSV_COLS incl. derived ice_rank)
//   ice set-tier <critical|elevated|none> --issue N --why … --until …  (#112)
//                                   opt-in priority override: apply/clear priority:* label,
//                                   store tier on the row, post a Who/Why/Expiry audit comment
//
// ICE is OPT-IN (disabled by default). Exit codes: 0 success/disabled; 2 usage;
// 1 operational. Pure scoring/ranking/auto live in ice_core (#99); persistence in
// store (#101). The provider seam is injectable (last main()/cmdScore arg) for tests.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const store = require('./store');
const core = require('./store_core');
const iceCore = require('./ice_core');
const { getProvider } = require('./provider');
const { makeDie, wantsHelp } = require('./sh');

const AUTO_LIMIT = 500;

const USAGE = 'usage: ice <score|list|export|set-tier> [...]';

function nowIso() {
  return new Date().toISOString();
}

// Adapt the provider's name-string labels to the [{name:..}] shape ice_core wants.
function labelDicts(names) {
  return (names || []).map((n) => ({ name: n }));
}

// Own arg parser (the generic parseStoreArgs only knows log|export, rejects --auto).
function parse(argv) {
  const a = {
    cmd: null, json: null, tier: null, auto: false, dryRun: false,
    label: null, asJson: false, dbPath: null, csv: null, noCsv: false,
    issue: null, why: null, until: null, as: null,
  };
  const pos = [];
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (t === '--auto') a.auto = true;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--json') a.asJson = true;
    else if (t === '--no-csv') a.noCsv = true;
    else if (t === '--label') { i += 1; a.label = argv[i] ?? null; }
    else if (t === '--db-path') { i += 1; a.dbPath = argv[i] ?? null; }
    else if (t === '--csv') { i += 1; a.csv = argv[i] ?? null; }
    else if (t === '--issue') { i += 1; a.issue = argv[i] ?? null; }
    else if (t === '--why') { i += 1; a.why = argv[i] ?? null; }
    else if (t === '--until') { i += 1; a.until = argv[i] ?? null; }
    else if (t === '--as') { i += 1; a.as = argv[i] ?? null; }
    else if (t.startsWith('--')) throw new Error(`unknown flag: ${t}`);
    else pos.push(t);
    i += 1;
  }
  a.cmd = pos[0] ?? null;
  a.json = pos[1] ?? null;    // score: the batch JSON
  a.tier = pos[1] ?? null;    // set-tier: the tier arg (same positional slot)
  return a;
}

// Custom rank-aware export: selectAll -> rankRows -> ICE_CSV_COLS (with ice_rank).
// NOT store.exportCsv (raw table cols, no rank). Atomic temp->rename.
function rankedCsv(dbPath, csvPath) {
  const ranked = iceCore.rankRows(store.selectAll(dbPath, 'ice'));
  const resolved = path.resolve(config.expanduser(dbPath));
  const lines = [core.csvPreamble(resolved), core.csvHeader(iceCore.ICE_CSV_COLS)];
  for (const r of ranked) lines.push(core.csvEncodeRow(r, iceCore.ICE_CSV_COLS));
  const out = path.resolve(config.expanduser(csvPath));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, out);
  return ranked.length;
}

function buildAutoRows(prov, dbPath) {
  const issues = prov.listOpenIssuesWithLabels(AUTO_LIMIT);
  const scored = new Set(store.selectAll(dbPath, 'ice').map((r) => r.issue));
  const rows = [];
  for (const it of issues) {
    if (scored.has(it.number)) continue;
    const sc = iceCore.deriveAutoScore(labelDicts(it.labels));
    rows.push({
      issue: it.number, title: it.title ?? null,
      I: sc.I, C: sc.C, E: sc.E,
      tier: iceCore.detectIceTier(labelDicts(it.labels)),
      labels: (it.labels || []).join(';') || null,
      notes: 'auto-swept from labels (provisional — review I/C/E)',
      provisional: 1,
    });
  }
  return rows;
}

function buildBatchRows(prov, batch, die) {
  const rows = [];
  for (const [numStr, fields] of Object.entries(batch)) {
    const num = parseInt(numStr, 10);
    if (!Number.isInteger(num)) die(`issue keys must be integers — got ${JSON.stringify(numStr)}`);
    let labels = [];
    try { labels = (prov.issueStates([num])[num] || {}).labels || []; } catch { labels = []; }
    let title = null;
    try { title = prov.issueTitle(num); } catch { title = null; }
    const raw = { ...fields, issue: num };
    if (title && raw.title === undefined) raw.title = title;
    if (raw.tier === undefined) raw.tier = iceCore.detectIceTier(labelDicts(labels));
    if (raw.labels === undefined) raw.labels = labels.join(';') || null;
    rows.push(raw);
  }
  return rows;
}

function cmdScore(a, dbPath, storeCfg, die, provider) {
  if (!storeCfg.enabled) { console.log('ice store disabled for this project'); return 0; }
  const prov = provider || getProvider('github');
  let raws;
  let summary;
  if (a.auto) {
    raws = buildAutoRows(prov, dbPath);
    summary = `Auto sweep: ${raws.length} unscored open issue(s).`;
  } else {
    if (!a.json) {
      die("usage: ice score '{\"<issue>\":{\"I\":1,\"C\":0.8,\"E\":5}}' [--auto] [--dry-run]", 2);
    }
    let batch;
    try { batch = JSON.parse(a.json); } catch (e) { die(`invalid JSON: ${e.message}`); }
    if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
      die('payload must be a JSON object of {issue: {I,C,E}}');
    }
    raws = buildBatchRows(prov, batch, die);
    summary = `Scored ${raws.length} issue(s).`;
  }

  const validated = [];
  for (const raw of raws) {
    let row;
    try { row = iceCore.validateIceRow(raw); } catch (e) { die(e.message); }
    row.updated_iso = nowIso();
    validated.push(row);
  }

  if (a.dryRun) {
    for (const row of validated) {
      console.log(`[dry-run] #${row.issue} I=${row.I} C=${row.C} E=${row.E} -> ICE=${row.ice_score}`);
    }
    console.log(`[dry-run] ${summary} (no writes)`);
    return 0;
  }

  for (const row of validated) {
    try { store.upsert(dbPath, 'ice', row); } catch (e) { die(`DB upsert failed: ${e.message}`); }
  }
  console.log(summary);

  const csvPath = a.noCsv ? null : (a.csv || storeCfg.csvMirror);
  if (csvPath) console.log(`Exported ${rankedCsv(dbPath, csvPath)} rows -> ${csvPath}`);
  return 0;
}

function cmdList(a, dbPath, storeCfg) {
  if (!storeCfg.enabled) { console.log('ice store disabled for this project'); return 0; }
  let rows = store.selectAll(dbPath, 'ice');
  if (a.label) rows = rows.filter((r) => (r.labels || '').includes(a.label));
  const ranked = iceCore.rankRows(rows);
  if (a.asJson) { console.log(JSON.stringify(ranked)); return 0; }
  if (!ranked.length) { console.log('(no ICE-scored issues)'); return 0; }
  for (const r of ranked) {
    const icev = (r.ice_score === null || r.ice_score === undefined) ? '?' : r.ice_score;
    console.log(`${String(r.ice_rank).padStart(4)}. #${r.issue}  ICE=${icev}  I=${r.I} C=${r.C} E=${r.E}  ${(r.title || '').slice(0, 50)}`);
  }
  return 0;
}

function cmdExport(a, dbPath, storeCfg, die) {
  if (!storeCfg.enabled) { console.log('ice store disabled for this project'); return 0; }
  const csvPath = a.csv || storeCfg.csvMirror;
  if (!csvPath) die('no CSV target: pass --csv P or set storage.ice.csvMirror');
  console.log(`Exported ${rankedCsv(dbPath, csvPath)} rows -> ${csvPath}`);
  return 0;
}

// The Who/Why/Expiry audit comment posted on every set-tier (#112).
function auditComment({ tier, who, why, until }) {
  if (tier === 'none') {
    return ['**Priority override cleared** (tier → none)', '',
      `- **Who:** ${who || 'unknown'}`,
      ...(why ? [`- **Why:** ${why}`] : []),
      ...(until ? [`- **Until:** ${until}`] : []),
      '', '_Set via `pmtools ice set-tier`._'].join('\n');
  }
  return ['**Priority escalated → `priority:' + tier + '`**', '',
    `- **Who:** ${who}`, `- **Why:** ${why}`, `- **Until:** ${until}`,
    '', '_Set via `pmtools ice set-tier`._'].join('\n');
}

// `ice set-tier <critical|elevated|none> --issue N [--why … --until … --as …]`
// (#112): apply/clear the priority:* override label, store the tier on the ice
// row, and post the Who/Why/Expiry audit comment. Opt-in; host writes fail-soft.
function cmdSetTier(a, dbPath, storeCfg, die, provider) {
  if (!storeCfg.enabled) { console.log('ice store disabled for this project'); return 0; }
  if (!dbPath) return die('no dbPath configured — set storage.dbPath in .claude/orchestrate.json');
  const t = a.tier ? String(a.tier).toLowerCase() : null;
  if (!t) return die('usage: ice set-tier <critical|elevated|none> --issue N --why "…" --until "…"', 2);
  const issue = parseInt(a.issue, 10);
  if (!a.issue || !Number.isInteger(issue) || issue <= 0) {
    return die('set-tier requires --issue <positive integer>', 2);
  }
  const who = a.as || process.env.CLAUDE_AGENT_NAME || null;
  if (t === 'critical' || t === 'elevated') {
    if (!who) return die('set-tier critical|elevated requires an agent identity: --as <name> or $CLAUDE_AGENT_NAME', 2);
    if (!a.why) return die('set-tier critical|elevated requires --why "<one sentence>"', 2);
    if (!a.until) return die('set-tier critical|elevated requires --until "<date|event>"', 2);
  }

  const prov = provider || getProvider('github');
  let labels = [];
  try { labels = (prov.issueStates([issue])[issue] || {}).labels || []; } catch { labels = []; }

  let plan;
  try { plan = iceCore.setTierPlan(t, labels); } catch (e) { return die(e.message, 2); }

  // Apply the label mutation (fail-soft: a gh failure warns, does not abort).
  for (const lbl of plan.remove) {
    if (!prov.removeLabel(issue, lbl)) console.error(`[ice] note: could not remove ${lbl} on #${issue} (gh unavailable?)`);
  }
  if (plan.add && !prov.addLabel(issue, plan.add)) {
    console.error(`[ice] note: could not add ${plan.add} on #${issue} (gh unavailable?)`);
  }

  // Store the tier on the ice row — read-merge-write so I/C/E are preserved
  // (upsert is INSERT OR REPLACE). No prior row → a minimal tier-only row.
  const existing = store.selectAll(dbPath, 'ice').find((r) => r.issue === issue) || null;
  const raw = existing
    ? { ...existing, tier: plan.storedTier }
    : { issue, tier: plan.storedTier, notes: 'tier set via ice set-tier' };
  let row;
  try { row = iceCore.validateIceRow(raw); } catch (e) { return die(e.message); }
  row.updated_iso = nowIso();
  try { store.upsert(dbPath, 'ice', row); } catch (e) { return die(`DB upsert failed: ${e.message}`); }

  // Post the audit comment (fail-soft).
  if (!prov.createComment(issue, auditComment({ tier: t, who, why: a.why, until: a.until }))) {
    console.error(`[ice] note: could not post audit comment on #${issue} (gh unavailable?)`);
  }

  const detail = [plan.add ? `+${plan.add}` : null, plan.remove.length ? `-${plan.remove.join(', ')}` : null]
    .filter(Boolean).join(' ');
  console.log(`#${issue}: ${t === 'none' ? 'cleared tier override' : `tier=${t}`}${detail ? ` (${detail})` : ''}`);
  return 0;
}

function main(argv, provider) {
  const die = makeDie('ice');
  if (wantsHelp(argv)) { console.log(USAGE); return 0; } // #117 command-aware --help
  let a;
  try { a = parse(argv); } catch (e) { return die(e.message, 2); }
  const cfg = config.loadStorageConfig();
  const storeCfg = cfg.ice;
  const dbPath = a.dbPath || cfg.dbPath;
  if (a.cmd === 'score') return cmdScore(a, dbPath, storeCfg, die, provider);
  if (a.cmd === 'list') return cmdList(a, dbPath, storeCfg, die);
  if (a.cmd === 'export') return cmdExport(a, dbPath, storeCfg, die);
  if (a.cmd === 'set-tier') return cmdSetTier(a, dbPath, storeCfg, die, provider);
  return die(`${USAGE}  (got ${JSON.stringify(a.cmd)})`, 2);
}

module.exports = { main, parse, cmdScore, cmdList, cmdExport, cmdSetTier, auditComment, rankedCsv };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
