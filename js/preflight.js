#!/usr/bin/env node
'use strict';
/*
 * preflight.js — guard task START (fleet workflow). Seeded from lccjs
 * scripts/preflight.js (#1036), with the two lccjs-specific paths parameterized:
 *
 *   - scratch dir:   ~/.lccjs/  ->  <scratchDir>  (default ~/.pmtools/<repo>/)
 *   - evidence dirs: docs/logs, docs/research  ->  <evidenceDirs>
 *
 *   pmtools preflight <issue> [--scratch-dir <dir>] [--evidence-dir <dir> ...]
 *
 * 1. Stamp started_iso to <scratchDir>/preflight-<issue>.iso.
 * 2. Start-of-task reads: git status, git worktree list, gh issue view.
 * 2.5 Surface in-repo evidence (<evidenceDirs>/<M>-*) for referenced #M.
 * 3. Assert the issue is OPEN; exit 1 otherwise.
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('./config');
const { makeDie } = require('./sh');
const { preflightIssueGate, preflightEvidence, preflightCloseCoherence, DEFAULT_EVIDENCE_DIRS } = require('./preflight_core');

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return (e && (e.stdout || e.stderr)) || null;
  }
}

function out(s) { process.stdout.write(String(s).replace(/\n?$/, '\n')); }
const die = makeDie('preflight');
const indent = (s) => String(s || '').replace(/^/gm, '    ').replace(/\s+$/, '');

function listEvidenceFiles(evidenceDirs) {
  const acc = [];
  for (const d of evidenceDirs) {
    try { for (const name of fs.readdirSync(d)) acc.push(`${d}/${name}`); }
    catch (_) { /* dir absent — best-effort */ }
  }
  return acc;
}

function defaultScratchDir() {
  // Key the scratch dir off the MAIN checkout so worktrees don't scatter
  // ~/.pmtools/<worktree>/ dirs (#26).
  const root = config.mainRepoRoot();
  const repo = root ? path.basename(root) : 'repo';
  return path.join(os.homedir(), '.pmtools', repo);
}

function parseArgs(argv) {
  const a = { issue: '', scratchDir: null, evidenceDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--scratch-dir') a.scratchDir = argv[++i];
    else if (t === '--evidence-dir') a.evidenceDirs.push(argv[++i]);
    else if (!a.issue) a.issue = t;
  }
  if (!a.scratchDir) a.scratchDir = defaultScratchDir();
  if (!a.evidenceDirs.length) a.evidenceDirs = DEFAULT_EVIDENCE_DIRS.slice();
  return a;
}

function main(argv) {
  const args = parseArgs(argv);
  const issue = String(args.issue || '').replace(/^#/, '');
  if (!/^\d+$/.test(issue)) die('usage: preflight <issue-number> [--scratch-dir D] [--evidence-dir D ...]', 2);

  const bar = '─'.repeat(58);
  out(bar); out(`  PREFLIGHT  ·  issue #${issue}`); out(bar);

  const stamp = (sh(`date '+%Y-%m-%dT%H:%M:%S%z'`) || '').trim();
  const scratch = path.join(args.scratchDir, `preflight-${issue}.iso`);
  try { fs.mkdirSync(args.scratchDir, { recursive: true }); fs.writeFileSync(scratch, stamp + '\n'); } catch (_) {}
  out(`  started_iso   ${stamp || '(date unavailable)'}`);
  out(`  saved to      ${scratch}`);
  out('');

  const status = sh('git status --short');
  out('  git status --short:');
  out(status && status.trim() ? indent(status) : '    (clean)');
  out('  git worktree list:');
  out(indent(sh('git worktree list')));
  out('');

  let info = null;
  const raw = sh(`gh issue view ${issue} --json number,title,state,body,comments`);
  if (raw) { try { info = JSON.parse(raw); } catch (_) {} }
  let body = '';
  let comments = [];
  if (info) {
    body = info.body || '';
    comments = Array.isArray(info.comments) ? info.comments : [];
    out(`  #${info.number} [${info.state}] ${info.title}`);
    out('  body:');
    out(indent(body && body.trim() ? body : '(no body)'));
    out(`  comments (${comments.length}):`);
    for (const c of comments) {
      const who = (c.author && c.author.login) || 'unknown';
      out(indent(`— @${who} (${c.createdAt || ''}):\n${(c.body || '').trim()}`));
    }
  } else {
    out(`  ⚠ gh issue view ${issue} unavailable (offline?) — skipping issue read.`);
  }
  out('');

  const refText = [body, ...comments.map((c) => c && c.body)].join('\n');
  const evidence = preflightEvidence(refText, listEvidenceFiles(args.evidenceDirs), args.evidenceDirs);
  out('  existing evidence — read these before writing findings:');
  if (evidence.length) { for (const p of evidence) out(`    • ${p}`); }
  else { out('    (none found for referenced tickets)'); }
  out('');

  // Config-coherence note (#63): claiming with pmtools but closing with a
  // non-pmtools close that may not parse br-/wt- branch names. Non-blocking.
  const enrich = config.loadEnrichmentConfig();
  const coherence = preflightCloseCoherence(enrich.claimCommand, enrich.closeCommand);
  if (coherence) process.stderr.write(`[preflight] note: ${coherence.warn}\n`);

  const gate = preflightIssueGate(info && info.state);
  if (gate.warn) out(`  ⚠ ${gate.warn}`);
  if (!gate.ok) die(gate.error);

  out(bar);
  out(`  PREFLIGHT OK  ·  #${issue} is OPEN  ·  started_iso stamped`);
  out(`  next: claim #${issue} under your agent identity (fleet workflow).`);
  out(bar);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { preflightIssueGate, preflightEvidence, preflightCloseCoherence, defaultScratchDir };
