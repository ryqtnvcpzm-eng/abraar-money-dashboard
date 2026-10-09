// Tests: node tests/run.mjs   (needs `npm install` for pdfjs-dist, and python3 + reportlab for the sample PDFs)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { pdfToPages } from '../js/pdf-text.js';
import { parseCibcStatement, reconcile, parseSummary } from '../js/cibc-parser.js';
import { compileRules, cleanName, sanitizeDescription, categorize } from '../js/categorize.js';
import { emptyVault, prepareImport, commitImport, buildModel, flow, spendByCategory, dailyBalance, planFromTemplate, planTargets, insights } from '../js/ledger.js';
import { createSession, seal, open } from '../js/crypto.js';
import { scanDate, parseMoney, resolveOrder } from '../js/parse-util.js';
import { parseGenericStatement } from '../js/generic-parser.js';
import { readStatementFile, parseLoaded, loadFile } from '../js/statements.js';
import { FIXTURES } from './fixtures-generic.mjs';
import { EXPORTS } from './fixtures-exports.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failures.push(name); console.log('  ✗', name, '\n    ', e.message); }
}

const compiled = compileRules(JSON.parse(readFileSync(new URL('../data/rules.json', import.meta.url))));

console.log('Merchant clean-up');
await test('sanitize removes card, reference and account numbers', () => {
  const s = sanitizeDescription('VISA DEBIT PURCHASE 4506*********123 AMAZON.CA ref 000001234567 Account number 12-34567');
  assert.ok(!/\d{5,}/.test(s), s);
  assert.ok(!/4506/.test(s), s);
  assert.ok(!/34567/.test(s), s);
});
await test('clean names', () => {
  assert.equal(cleanName('RETAIL PURCHASE 000001234567 DOLLARAMA #123 MONTREAL QC'), 'Dollarama');
  assert.equal(cleanName('VISA DEBIT RETAIL PURCHASE SQ *CAFE OLIMPICO'), 'Cafe Olimpico');
  assert.equal(cleanName('E-TRANSFER 105123456789 Sample Person'), 'Sample Person');
  assert.equal(cleanName('SERVICE CHARGE'), 'Service Charge');
  assert.equal(cleanName('RETAIL PURCHASE NIKE CANADA MAR'), 'Nike Canada');
  assert.equal(cleanName('RETAIL PURCHASE 3JM0QY020000 LS Time Out Le'), 'Time Out');
  assert.equal(cleanName('INTL VISA DEB RETAIL PURCHASE MOBILE SUICA AP 5000 JPY @ 0.'), 'Mobile Suica Ap');
  assert.equal(cleanName('INTL VISA DEB RETAIL PURCHASE DISCORD* TEMPOR 0.99 USD @ 1.'), 'Discord');
  assert.equal(cleanName('RETAIL PURCHASE SHAWARMAZ (DOWN'), 'Shawarmaz');
});
await test('rules categorize common merchants', () => {
  const c = (merchant, amount = -5) => categorize({ merchant, amount }, compiled, []).category;
  assert.equal(c('RETAIL PURCHASE COUCHE-TARD #212'), 'coffee');
  assert.equal(c('INTERNET BILL PAY MCGILL UNIVERSITY'), 'education');
  assert.equal(c('VISA DEBIT PURCHASE PROVIGO LE MARCHE'), 'groceries');
  assert.equal(c('E-TRANSFER Sample Person'), 'transfers');
  assert.equal(c('E-TRANSFER Sample Person', 50), 'transfer_in');
  assert.equal(c('PAYROLL DEPOSIT EXAMPLE CORP', 2400), 'income');
  assert.equal(c('VISA DEBIT PURCHASE UBER *EATS'), 'dining');
  assert.equal(c('VISA DEBIT PURCHASE UBER *TRIP'), 'transport');
  assert.equal(c('INTERNET BILL PAY FIZZ'), 'internet');
  assert.equal(c('VISA DEBIT RETAIL PURCHASE VESTA *CHATR'), 'bills');
  assert.equal(c('RETAIL PURCHASE MASSOTHERAPIE PLATEAU'), 'fitness');
  assert.equal(c('VISA DEBIT PURCHASE APPLE.COM/BILL'), 'entertainment');
  assert.equal(c('VISA DEBIT PURCHASE BANANA REPUBLIC'), 'other');
  assert.equal(c('DEPOSIT TPS/GST', 120), 'transfer_in');
  assert.equal(c('VISA DEBIT RETAIL PURCHASE AIR CAN*'), 'travel');
  assert.equal(c('VISA DEBIT RETAIL PURCHASE IC* INSTACART'), 'groceries');
});
await test('user rules beat rules.json, and locked choices beat both', () => {
  const t = { merchant: 'RETAIL PURCHASE COUCHE-TARD #2', amount: -3 };
  assert.equal(categorize(t, compiled, [{ name: 'Couche-Tard', category: 'dining', sign: -1 }]).category, 'dining');
  assert.equal(categorize({ ...t, locked: true, category: 'groceries' }, compiled, [{ name: 'Couche-Tard', category: 'dining' }]).category, 'groceries');
});

console.log('Statement summary');
await test('summary regexes', () => {
  const s = parseSummary('For Dec 1, 2025 to Jan 2, 2026\nOpening balance on Dec 1, 2025 $1,000.00\nWithdrawals - 250.10\nDeposits + 1,500.00\nClosing balance on Jan 2, 2026 = $2,249.90');
  assert.deepEqual(s.period, { start: '2025-12-01', end: '2026-01-02' });
  assert.equal(s.opening, 1000); assert.equal(s.closing, 2249.9); assert.equal(s.withdrawals, 250.1); assert.equal(s.deposits, 1500);
});

console.log('Encryption');
await test('seal/open round trip, wrong passphrase rejected, tampering rejected', async () => {
  const session = await createSession('correct horse battery staple');
  const env = await seal(session, { hello: 'world', n: 1 }, 3);
  const { data } = await open(env, 'correct horse battery staple');
  assert.deepEqual(data, { hello: 'world', n: 1 });
  await assert.rejects(open(env, 'wrong passphrase'), /WRONG_PASSPHRASE/);
  await assert.rejects(open({ ...env, rev: 4 }, 'correct horse battery staple'), /WRONG_PASSPHRASE/);
  assert.ok(!JSON.stringify(env).includes('world'));
});


console.log('Statements from any bank');
await test('dates in many formats and languages', () => {
  const d = (t) => { const x = scanDate(t); return x && !x.ambiguous ? [x.y, x.m, x.d] : x; };
  assert.deepEqual(d('31/01/2026 X'), [2026, 1, 31]);
  assert.deepEqual(d('2026-01-31'), [2026, 1, 31]);
  assert.deepEqual(d('Jan 31, 2026'), [2026, 1, 31]);
  assert.deepEqual(d('31 Jan 2026'), [2026, 1, 31]);
  assert.deepEqual(d('31-JAN-26'), [2026, 1, 31]);
  assert.deepEqual(d('12 de enero de 2026'), [2026, 1, 12]);
  assert.deepEqual(d('3 févr. 2026'), [2026, 2, 3]);
  assert.deepEqual(d('31. März 2026'), [2026, 3, 31]);
  assert.deepEqual([scanDate('01.07. 01.07. Miete').a, scanDate('01.07. 01.07. Miete').b, scanDate('01.07. 01.07. Miete').y], [1, 7, null]);
  assert.equal(scanDate('12.50'), null);
  assert.equal(scanDate('Main Street'), null);
  assert.equal(scanDate('05/03').ambiguous, true);
  assert.equal(resolveOrder([scanDate('05/03'), scanDate('02/13')]).order, 'mdy');
  assert.equal(resolveOrder([scanDate('05/03'), scanDate('13/02')]).order, 'dmy');
});
await test('amounts in many formats', () => {
  const v = (t, dec) => parseMoney(t, dec).value;
  assert.equal(v('1,234.56'), 1234.56);
  assert.equal(v('1.234,56', ','), 1234.56);
  assert.equal(v('1 234,56', ','), 1234.56);
  assert.equal(v("1'234.56"), 1234.56);
  assert.equal(v('(45.00)'), -45);
  assert.equal(v('45.00-'), -45);
  assert.equal(v('45.00 DR'), -45);
  assert.equal(v('12.00 CR'), 12);
  assert.equal(v('-$12.00'), -12);
  assert.equal(v('€1.234,56', ','), 1234.56);
});
for (const f of FIXTURES) {
  await test(`PDF layout: ${f.name}`, () => {
    const r = parseGenericStatement(f.pages);
    const e = f.expect;
    assert.deepEqual([r.period.start, r.period.end], e.period);
    assert.equal(r.opening, e.opening);
    assert.equal(r.closing, e.closing);
    assert.deepEqual(r.transactions.map((t) => t.amount), e.amounts);
    if (e.dates) assert.deepEqual(r.transactions.map((t) => t.date), e.dates);
    if (e.currency) assert.equal(r.meta.currency, e.currency);
    if (e.descIncludes) assert.ok(r.transactions.some((t) => t.description.includes(e.descIncludes)));
    assert.equal(reconcile(r).ok, true, reconcile(r).issues.join('; '));
  });
}
await test('the fix-it switches flip money in/out and the day/month order', () => {
  // No running balance to prove the direction: the switch flips every line.
  const de = FIXTURES[2];
  const flipped = parseGenericStatement(de.pages, { flip: true });
  assert.deepEqual(flipped.transactions.map((t) => t.amount), de.expect.amounts.map((a) => -a));
  // With running balances the balance wins, whatever the switch says.
  const us = FIXTURES[1];
  assert.deepEqual(parseGenericStatement(us.pages, { flip: true }).transactions.map((t) => t.amount), us.expect.amounts);
  const csv = EXPORTS[0];
  const file = { kind: 'csv', name: csv.name, text: csv.text };
  const dmy = parseLoaded(file, { dateOrder: 'dmy' });
  assert.ok(dmy.length > 0 && dmy.every((s) => s.meta.dateOrder === 'dmy'));
});
for (const f of EXPORTS) {
  await test(`Export: ${f.label}`, async () => {
    const r = await readStatementFile({ name: f.name, bytes: new TextEncoder().encode(f.text) });
    assert.deepEqual(r.statements.map((s) => s.period.end.slice(0, 7)), f.expect.months);
    for (const st of r.statements) {
      const ym = st.period.end.slice(0, 7);
      assert.deepEqual(st.transactions.map((t) => t.amount), f.expect.amounts[ym], ym);
      if (f.expect.opening?.[ym] != null) assert.equal(st.opening, f.expect.opening[ym]);
      if (f.expect.closing?.[ym] != null) assert.equal(st.closing, f.expect.closing[ym]);
      assert.equal(reconcile(st).ok, f.expect.verified, reconcile(st).issues.join('; '));
      if (f.expect.currency) assert.equal(st.meta.currency, f.expect.currency);
    }
    const vault = emptyVault();
    for (const st of r.statements) commitImport(vault, prepareImport(vault, st, compiled));
    assert.equal(vault.transactions.length, Object.values(f.expect.amounts).flat().length);
    assert.ok(!/\d{6,}/.test(JSON.stringify(vault.transactions.map((t) => t.merchant))), 'no account-like numbers stored');
  });
}
await test('a scanned PDF (no text) gets a helpful message', async () => {
  const fakePdf = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [] }), cleanup() {} }) }), destroy: async () => {} }) };
  await assert.rejects(loadFile({ name: 'scan.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }, { pdfjs: fakePdf }), /scanned image/);
});

console.log('PDF import (synthetic statements)');
const dir = mkdtempSync(join(tmpdir(), 'money-test-'));
try {
  const gen = execFileSync('python3', ['-I', new URL('./make_sample_statements.py', import.meta.url).pathname, dir], { encoding: 'utf8' });
  const expected = Object.fromEntries(gen.trim().split('\n').map((l) => {
    const [id, , o, , w, , d, , c, , n] = l.split(' ');
    return [id, { opening: +o, withdrawals: +w, deposits: +d, closing: +c, count: +n }];
  }));
  const vault = emptyVault();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.pdf')).sort()) {
    const pages = await pdfToPages(pdfjs, new Uint8Array(readFileSync(join(dir, f))));
    const parsed = parseCibcStatement(pages);
    const id = parsed.period?.end.slice(0, 7);
    await test(`${f}: parsed and reconciled`, () => {
      const e = expected[id];
      assert.ok(e, 'period ' + JSON.stringify(parsed.period));
      const rec = reconcile(parsed);
      assert.equal(parsed.transactions.length, e.count, 'transaction count');
      assert.ok(rec.ok, rec.issues.join('; '));
      assert.equal(parsed.opening, e.opening);
      assert.equal(parsed.closing, e.closing);
      const coffee = parsed.transactions.filter((t) => /TIM HORTONS/.test(t.description));
      assert.equal(coffee.length, 2, 'both same-day coffees kept');
      assert.ok(parsed.transactions.every((t) => /COUCHE|PROVIGO|FIZZ|E-TRANSFER|PAYROLL|AMAZON|SERVICE|TIM|MCGILL/.test(t.description)), 'descriptions joined across lines');
    });
    const prep = prepareImport(vault, parsed, compiled);
    commitImport(vault, prep);
    await test(`${f}: no account or reference numbers stored`, () => {
      const json = JSON.stringify(prep.transactions);
      assert.ok(!/\d{5,}/.test(json.replace(/"(amount|balance)":-?[\d.]+/g, '')), 'long digit run found');
      assert.ok(!/transit|Account number/i.test(json));
    });
  }

  await test('re-importing the same statement adds nothing (duplicates removed)', async () => {
    const f = readdirSync(dir).filter((x) => x.endsWith('.pdf')).sort()[0];
    const pages = await pdfToPages(pdfjs, new Uint8Array(readFileSync(join(dir, f))));
    const parsed = parseCibcStatement(pages);
    // Same statement, imported under a different id, would be all duplicates:
    const fake = { ...parsed, period: { start: parsed.period.start, end: '2030-01-31' } };
    const prep = prepareImport(vault, fake, compiled);
    assert.equal(prep.transactions.length, 0);
    assert.equal(prep.duplicates, parsed.transactions.length);
    // Same id is flagged as a replacement, not doubled:
    assert.equal(prepareImport(vault, parsed, compiled).alreadyImported, true);
  });

  const model = buildModel(vault, compiled);
  await test('reversals and waived fees are netted out', () => {
    const netted = model.txns.filter((t) => t.netted);
    assert.equal(netted.length, 4 * 4, 'Amazon purchase+reversal and fee+discount, 4 months');
    assert.ok(model.txns.filter((t) => /SERVICE CHARGE/.test(t.merchant)).every((t) => t.netted));
  });
  await test('net flow equals balance change for every month', () => {
    for (const st of model.statements) {
      const f = flow(model, st.start, st.end);
      assert.equal(f.net, Math.round(st.closing * 100) - Math.round(st.opening * 100), st.id);
    }
  });
  await test('daily balance ends on the last closing balance', () => {
    const d = dailyBalance(model);
    assert.equal(d[d.length - 1].bal, Math.round(model.statements.at(-1).closing * 100));
    assert.equal(d[0].date, '2026-01-01');
  });
  await test('everyday excludes tuition and transfers', () => {
    const april = model.txns.filter((t) => t.month === '2026-04');
    const all = spendByCategory(april, 'everything').map((r) => r.cat.id);
    const everyday = spendByCategory(april, 'everyday').map((r) => r.cat.id);
    assert.ok(all.includes('education') && all.includes('transfers'));
    assert.ok(!everyday.includes('education') && !everyday.includes('transfers'));
  });
  await test('plan template splits the spending budget exactly', () => {
    const plan = planFromTemplate(compiled, { start: '2026-11-02', takeHome: 5000, savePct: 60 });
    const t = planTargets(plan);
    assert.equal(t.save, 3000); assert.equal(t.spend, 2000);
    assert.equal(plan.lines.reduce((s, l) => s + l.amount, 0), 2000);
    assert.equal(t.eatingOut, plan.lines.filter((l) => l.categories.some((c) => plan.eatingOut.includes(c))).reduce((s, l) => s + l.amount, 0));
    assert.equal(plan.lines[0].categories[0], 'housing');
    assert.ok(plan.lines.some((l) => l.categories.includes('*')), 'a catch-all line exists');
    // every spend category is budgeted somewhere (or falls to the catch-all)
    assert.ok(compiled.categories.filter((c) => c.type === 'spend').every((c) => plan.lines.some((l) => l.categories.includes(c.id) || l.categories.includes('*'))));
    vault.plan = plan;
    assert.ok(insights(buildModel(vault, compiled), '2026-10-07').length >= 3);
  });

  await test('the general reader reads CIBC layouts exactly like the CIBC reader', async () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.pdf'))) {
      const pages = await pdfToPages(pdfjs, new Uint8Array(readFileSync(join(dir, f))));
      const g = parseGenericStatement(pages);
      const c = parseCibcStatement(pages);
      assert.equal(reconcile(g).ok, true, f);
      assert.deepEqual(g.transactions.map((t) => [t.date, t.amount, t.description]), c.transactions.map((t) => [t.date, t.amount, t.description]), f);
    }
  });

  const world = execFileSync('python3', ['-I', new URL('./make_world_statements.py', import.meta.url).pathname, dir], { encoding: 'utf8' });
  for (const line of world.trim().split('\n')) {
    const [file, id, o, c, n] = line.split(' ');
    await test(`real PDF from another bank: ${file}`, async () => {
      const r = await readStatementFile({ name: file, bytes: new Uint8Array(readFileSync(join(dir, file))) }, { pdfjs });
      const st = r.statements[0];
      assert.equal(st.period.end.slice(0, 7), id);
      assert.equal(st.opening, +o);
      assert.equal(st.closing, +c);
      assert.equal(st.transactions.length, +n);
      assert.equal(reconcile(st).ok, true, reconcile(st).issues.join('; '));
    });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
