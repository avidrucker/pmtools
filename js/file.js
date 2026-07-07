#!/usr/bin/env node
'use strict';
/*
 * file.js — gated issue creation (`pmtools file`, alias `create`, #111). Twin of
 * py/file.py. Wraps `gh issue create` through the provider, applying the pure
 * `fileGateVerdict` requirement gates BEFORE the issue exists; on success it echoes
 * the VERIFIED number read back from the create response (which structurally
 * prevents the concurrent-create number race, pycats#541).
 *
 *   pmtools file --title "<t>" [--area A] [--role R] [--body S | --body-file F]
 *                [--label L ...] [--severity S] [--dry-run] [--allow-uncategorized]
 *
 * Exit codes: 0 created / clean dry-run · 2 usage error · 1 hard gate block or
 * provider create failure (nothing created).
 */

const fs = require('node:fs');

const config = require('./config');
const { getProvider } = require('./provider');
const { makeDie } = require('./sh');
const { fileGateVerdict } = require('./file_core');

function out(s) { process.stdout.write(String(s).replace(/\n?$/, '\n')); }
const die = makeDie('file');

function parseArgs(argv) {
  const a = {
    title: null, area: null, role: null, body: null, bodyFile: null,
    labels: [], severity: null, dryRun: false, allowUncategorized: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--title') a.title = argv[++i];
    else if (t === '--area') a.area = argv[++i];
    else if (t === '--role') a.role = argv[++i];
    else if (t === '--body') a.body = argv[++i];
    else if (t === '--body-file') a.bodyFile = argv[++i];
    else if (t === '--label') a.labels.push(argv[++i]);
    else if (t === '--severity') a.severity = argv[++i];
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--allow-uncategorized') a.allowUncategorized = true;
    else if (t.startsWith('--')) throw new Error(`unknown flag: ${t}`);
    else throw new Error(`unexpected argument: ${t}`);
  }
  return a;
}

// The resolved `gh issue create` invocation, for --dry-run display. Title quoted
// via JSON (parity with py json.dumps) so the two ports render byte-identically.
function ghInvocation(title, labels) {
  const parts = ['gh issue create', `--title ${JSON.stringify(String(title))}`, '--body-file -'];
  for (const l of labels) parts.push(`--label ${l}`);
  return parts.join(' ');
}

function main(argv, provider) {
  let a;
  try { a = parseArgs(argv); } catch (e) { return die(e.message, 2); }
  if (!a.title) {
    return die('usage: file --title T [--area A] [--role R] [--body S | --body-file F] '
      + '[--label L ...] [--severity S] [--dry-run] [--allow-uncategorized]', 2);
  }
  if (a.body !== null && a.bodyFile !== null) return die('pass only one of --body or --body-file', 2);
  let body = '';
  if (a.bodyFile !== null) {
    try { body = fs.readFileSync(a.bodyFile, 'utf8'); }
    catch (e) { return die(`could not read --body-file ${a.bodyFile}: ${e.message}`, 2); }
  } else if (a.body !== null) {
    body = a.body;
  }

  const cfg = config.loadCreateConfig();
  const verdict = fileGateVerdict({
    area: a.area, role: a.role, severity: a.severity, title: a.title,
    labels: a.labels, allowUncategorized: a.allowUncategorized, body,
  }, cfg);

  // Soft notes first — never block.
  for (const v of verdict.violations) {
    if (v.severity === 'soft') process.stderr.write(`[file] note: ${v.message}\n`);
  }
  const hard = verdict.violations.filter((v) => v.severity === 'hard');
  if (hard.length) {
    for (const v of hard) process.stderr.write(`[file] ✗ ${v.message}\n`);
    if (a.dryRun) out(`[dry-run] would NOT create — ${hard.length} hard violation(s): ${ghInvocation(a.title, verdict.labels)}`);
    return 1; // nothing created
  }

  if (a.dryRun) {
    out(`[dry-run] would create: ${ghInvocation(a.title, verdict.labels)}`);
    return 0;
  }

  const prov = provider || getProvider('github');
  const num = prov.createIssue(a.title, body, verdict.labels);
  if (num === null || num === undefined) {
    return die('issue creation failed (gh unavailable / rejected?) — nothing created.', 1);
  }
  out(`created #${num}${verdict.labels.length ? ` [${verdict.labels.join(', ')}]` : ''}`);
  return 0;
}

module.exports = { main, parseArgs, ghInvocation };

if (require.main === module) process.exit(main(process.argv.slice(2)));
