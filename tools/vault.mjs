#!/usr/bin/env node
// Command-line companion to the app. Everything runs locally; nothing is uploaded.
//
//   node tools/vault.mjs check  statements/*        Parse + reconcile statement files (PDF, CSV, OFX, QIF) and print the table. Writes nothing.
//   node tools/vault.mjs import statements/*        Same, then add them to data/vault.enc.json (asks for the passphrase).
//   node tools/vault.mjs report                     Decrypt data/vault.enc.json and print statements + category totals.
//
// Needs `npm install` once (for pdfjs-dist).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import readline from 'node:readline';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readStatementFile } from '../js/statements.js';
import { compileRules } from '../js/categorize.js';
import { emptyVault, prepareImport, commitImport, buildModel, spendByCategory, flow } from '../js/ledger.js';
import * as crypto from '../js/crypto.js';

const VAULT = new URL('../data/vault.enc.json', import.meta.url);
const compiled = compileRules(JSON.parse(readFileSync(new URL('../data/rules.json', import.meta.url))));
const [cmd, ...files] = process.argv.slice(2);
const f2 = (n) => (n == null ? '—' : n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pad = (s, n, right = true) => (right ? String(s).padStart(n) : String(s).padEnd(n));

function ask(q, hidden = false) {
  if (process.env.MONEY_PASSPHRASE && hidden) return Promise.resolve(process.env.MONEY_PASSPHRASE);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(q)) rl.output.write(q); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

async function parseAll(vault) {
  const preps = [];
  const work = structuredClone(vault);
  for (const f of files) {
    try {
      const { statements } = await readStatementFile({ name: f, bytes: new Uint8Array(readFileSync(f)) }, { pdfjs });
      for (const parsed of statements) {
        const prep = prepareImport(work, parsed, compiled);
        commitImport(work, prep);
        preps.push({ file: f, parsed, prep });
      }
    } catch (e) {
      preps.push({ file: f, error: e.message });
    }
  }
  preps.sort((a, b) => (a.prep?.id || '').localeCompare(b.prep?.id || ''));
  return preps;
}

function table(preps) {
  console.log('\n' + ['Month', 'Opening', 'Deposits', 'Withdrawals', 'Closing', 'Computed close', 'Txns', 'Dupes', 'Result'].map((h, i) => pad(h, [9, 12, 12, 12, 12, 15, 5, 6, 0][i], i > 0 && i < 8)).join('  '));
  for (const p of preps) {
    if (p.error) { console.log(`${p.file}: ERROR ${p.error}`); continue; }
    const r = p.prep.reconciliation;
    const comp = r.checks.find((c) => c.label === 'Closing balance')?.computed;
    console.log([
      pad(p.prep.id, 9, false), pad(f2(p.prep.opening), 12), pad(f2(p.prep.summaryTotals.deposits), 12), pad(f2(p.prep.summaryTotals.withdrawals), 12),
      pad(f2(p.prep.closing), 12), pad(f2(comp), 15), pad(p.prep.transactions.length, 5), pad(p.prep.duplicates, 6), r.ok ? '✓ reconciled' : r.ok === null ? '· not checked' : '✗ MISMATCH',
    ].join('  '));
    for (const i of r.issues) console.log('           ↳ ' + i);
  }
  // chain: each opening should equal the previous closing
  const ok = preps.filter((p) => p.prep);
  for (let i = 1; i < ok.length; i++) {
    const a = ok[i - 1].prep, b = ok[i].prep;
    if (Math.round(a.closing * 100) !== Math.round(b.opening * 100)) console.log(`   ⚠ ${b.id} opens at ${f2(b.opening)} but ${a.id} closed at ${f2(a.closing)}`);
  }
  const bad = preps.filter((p) => p.error || !p.prep.reconciliation.ok).length;
  console.log(bad ? `\n${bad} statement(s) need attention.` : `\nAll ${preps.length} statement(s) reconcile to the cent.`);
  return bad;
}

async function openVault() {
  if (!existsSync(VAULT)) return null;
  const env = JSON.parse(readFileSync(VAULT, 'utf8'));
  const pass = await ask('Passphrase: ', true);
  const { session, data } = await crypto.open(env, pass).catch(() => { console.error('Incorrect passphrase.'); process.exit(1); });
  return { env, session, data };
}

if (cmd === 'check' || cmd === 'import') {
  if (!files.length) { console.error(`Usage: node tools/vault.mjs ${cmd} statements/*.pdf`); process.exit(1); }
  let opened = null;
  if (cmd === 'import') opened = await openVault();
  const vault = opened?.data || emptyVault();
  const preps = await parseAll(vault);
  const bad = table(preps);
  if (cmd === 'check') process.exit(bad ? 1 : 0);
  const good = preps.filter((p) => p.prep && (p.prep.reconciliation.ok || process.argv.includes('--force')));
  if (!good.length) { console.log('Nothing to import.'); process.exit(1); }
  if (bad && !process.argv.includes('--force')) console.log('Skipping statements that don’t reconcile (use --force to import them flagged).');
  for (const p of good) commitImport(vault, prepareImport(vault, p.parsed, compiled));
  let session = opened?.session;
  if (!session) {
    const p1 = await ask('New passphrase (12+ characters): ', true);
    const p2 = await ask('Confirm passphrase: ', true);
    if (p1 !== p2 || p1.length < 12) { console.error('Passphrases differ or are too short.'); process.exit(1); }
    session = await crypto.createSession(p1);
  }
  const env = await crypto.seal(session, vault, (opened?.env.rev || 0) + 1);
  writeFileSync(VAULT, JSON.stringify(env, null, 1) + '\n');
  console.log(`\nWrote data/vault.enc.json (rev ${env.rev}, ${vault.transactions.length} transactions, encrypted). Commit and push it.`);
} else if (cmd === 'report') {
  const opened = await openVault();
  if (!opened) { console.error('No data/vault.enc.json yet.'); process.exit(1); }
  const m = buildModel(opened.data, compiled);
  console.log(`\n${m.statements.length} statements, ${m.txns.length} transactions (${m.txns.filter((t) => t.netted).length} netted reversals)\n`);
  for (const s of m.statements) {
    const f = flow(m, s.start, s.end);
    console.log(`${s.id}  open ${pad(f2(s.opening), 10)}  in ${pad(f2(f.inn / 100), 10)}  out ${pad(f2(f.out / 100), 10)}  close ${pad(f2(s.closing), 10)}  ${s.reconciled ? '✓' : '✗'}`);
  }
  console.log('\nEverything spending by category:');
  for (const r of spendByCategory(m.txns, 'everything')) console.log(`  ${pad(r.cat.name, 22, false)} ${pad(f2(r.cents / 100), 11)}  (${r.count})`);
} else {
  console.log('Usage:\n  node tools/vault.mjs check statements/*.pdf\n  node tools/vault.mjs import statements/*.pdf [--force]\n  node tools/vault.mjs report');
}
