// Tests: node tests/run.mjs   (needs `npm install` for pdfjs-dist, and python3 + reportlab for the sample PDFs)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { pdfToPages } from '../js/pdf-text.js';
import { parseCibcStatement, reconcile, parseSummary } from '../js/cibc-parser.js';
import { compileRules, cleanName, sanitizeDescription, categorize, productCategory, isMixedStore, hintCategory } from '../js/categorize.js';
import { applyBankSync, lastFileDay } from '../js/bank.js';
import { emptyVault, prepareImport, commitImport, buildModel, flow, spendByCategory, dailyBalance, planFromTemplate, planTargets, insights, splitParts } from '../js/ledger.js';
import { recurring, upcoming, duplicates, pace, unusual, cashflow } from '../js/analysis.js';
import { readOrderFiles, applyOrders, matchWaiting, _test as _amz } from '../js/amazon.js';
import { toCents } from '../js/format.js';
import { deflateRawSync } from 'node:zlib';
import { createSession, seal, open } from '../js/crypto.js';
import { scanDate, parseMoney, resolveOrder } from '../js/parse-util.js';
import { parseGenericStatement } from '../js/generic-parser.js';
import { readStatementFile, parseLoaded, loadFile } from '../js/statements.js';
import { FIXTURES } from './fixtures-generic.mjs';
import { EXPORTS } from './fixtures-exports.mjs';
import { WORLD_TXNS } from './fixtures-categories.mjs';

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
  // The merchant named first beats a place mentioned after it; a campus name alone is a weak hint.
  assert.equal(c('RETAIL PURCHASE BOUSTAN MCGILL'), 'dining');
  assert.equal(c('RETAIL PURCHASE MCGILL ATHLETIC'), 'fitness');
  assert.equal(c('INTERNET BILL PAY MCGILL UNIVERSITY'), 'education');
  assert.equal(c('RETAIL PURCHASE COLLEGE PIZZA'), 'dining');
  // The kind of transaction wins: pay is income, an e-transfer to someone named McGill is a transfer.
  assert.equal(c('PAY MCGILL UNIVERSI', 1800), 'income');
  assert.equal(c('E-TRANSFER Sample Mcgill'), 'transfers');
  assert.equal(c('SERVICE CHARGE DISCOUNT', 6.95), 'fees');
  assert.equal(c('VISA DEBIT PURCHASE UBER *EATS PENDING'), 'dining');
  assert.equal(c('CARD PAYMENT TO JOE S KITCHEN'), 'dining');
});
await test(`categories for banks around the world (${WORLD_TXNS.length} descriptions)`, () => {
  const wrong = WORLD_TXNS.filter(([d, a, want]) => categorize({ merchant: d, amount: a }, compiled, []).category !== want);
  assert.equal(wrong.length, 0, wrong.map(([d, , w]) => `${d} → expected ${w}`).join('; '));
});
await test('merchant names are cleaned for other banks too', () => {
  assert.equal(cleanName('CARD PAYMENT TO TESCO STORES 3021 ON 14 MAR'), 'Tesco Stores');
  assert.equal(cleanName('CARD PURCHASE 03/14 STARBUCKS STORE 12345 SEATTLE WA'), 'Starbucks Store');
  assert.equal(cleanName('ACHAT CB CARREFOUR MARKET 12/03 PARIS'), 'Carrefour Market');
  assert.equal(cleanName('UPI/412345678901/SWIGGY/swiggy@icici'), 'Swiggy');
  assert.equal(cleanName('EFTPOS WOOLWORTHS 1234 SYDNEY'), 'Woolworths');
  assert.equal(cleanName('PNP PICK N PAY'), 'Pnp Pick N Pay');
  assert.equal(cleanName('RETAIL PURCHASE ATELIER PARIS D'), 'Atelier Paris');
});
await test('merchant category codes, foreign currency and learned places', () => {
  const c = (merchant, amount = -5, rules = [], home = 'CAD') => categorize({ merchant, amount }, compiled, rules, home).category;
  assert.equal(c('PURCHASE MCC 5812 SOME LOCAL PLACE'), 'dining');
  assert.equal(c('INTL VISA DEB RETAIL PURCHASE JR CENTRAL 3000 JPY @ 0.0092'), 'travel');
  assert.equal(c('JR CENTRAL', -30, [], 'JPY'), 'transport');
  assert.equal(c('INTEREST CHARGED ON PURCHASES', -12), 'fees');
  // Teaching "Blue Heron" once covers its other branches.
  assert.equal(c('RETAIL PURCHASE BLUE HERON MAIN ST', -9, [{ name: 'Blue Heron', category: 'coffee', sign: -1 }]), 'coffee');
  assert.equal(c('RETAIL PURCHASE CAFE OLIMPICO', -4, [{ name: 'Cafe', category: 'dining', sign: -1 }]), 'coffee');
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
await test('re-importing part of a month never deletes the rest', () => {
  const st = (start, end, rows) => ({ period: { start, end }, opening: null, closing: null, summaryTotals: {}, transactions: rows.map(([date, description, amount]) => ({ date, description, amount })), balanceIssues: [], warnings: [], meta: { format: 'csv', unverified: true } });
  const v = emptyVault();
  // A statement period that crosses months (Dec 16 – Jan 15), then a CSV of all of December and January.
  commitImport(v, prepareImport(v, st('2025-12-16', '2026-01-15', [['2025-12-20', 'GROCERY MART', -40], ['2026-01-10', 'COFFEE SPOT', -4]]), compiled));
  for (const s of [st('2025-12-01', '2025-12-31', [['2025-12-05', 'BOOKSHOP', -12], ['2025-12-20', 'GROCERY MART', -40]]), st('2026-01-01', '2026-01-31', [['2026-01-10', 'COFFEE SPOT', -4], ['2026-01-25', 'PHARMACY', -9]])]) commitImport(v, prepareImport(v, s, compiled));
  assert.deepEqual(v.transactions.map((t) => t.date).sort(), ['2025-12-05', '2025-12-20', '2026-01-10', '2026-01-25']);
  // Two downloads covering different parts of the same month both stay.
  const w = emptyVault();
  commitImport(w, prepareImport(w, st('2026-03-02', '2026-03-10', [['2026-03-03', 'A SHOP', -1], ['2026-03-09', 'B SHOP', -2]]), compiled));
  commitImport(w, prepareImport(w, st('2026-03-16', '2026-03-28', [['2026-03-17', 'C SHOP', -3]]), compiled));
  assert.equal(w.transactions.length, 3);
  assert.deepEqual([w.statements[0].start, w.statements[0].end, w.statements[0].count], ['2026-03-02', '2026-03-28', 3]);
});
await test('a scanned PDF (no text) gets a helpful message', async () => {
  const fakePdf = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [] }), cleanup() {} }) }), destroy: async () => {} }) };
  await assert.rejects(loadFile({ name: 'scan.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }, { pdfjs: fakePdf }), /scanned image/);
});

console.log('Insights');
// A small made-up ledger: one account, months of everyday life, plus the patterns the insights look for.
function lifeVault({ months = 6, extra = () => {} } = {}) {
  const v = emptyVault();
  let n = 0;
  for (let k = 1; k <= months; k++) {
    const ym = `2026-${String(k).padStart(2, '0')}`;
    const last = new Date(2026, k, 0).getDate();
    const add = (d, merchant, amount) => v.transactions.push({ id: `${ym}-t-${String(++n).padStart(3, '0')}`, date: `${ym}-${String(d).padStart(2, '0')}`, merchant, name: '', amount, category: 'other', statement: ym });
    add(1, 'PREAUTHORIZED DEBIT SAMPLE PROPERTY MGMT', -1200);
    add(4, 'INTERNET BILL PAY FIZZ', -40.24);
    add(6, 'VISA DEBIT PURCHASE NETFLIX.COM', k < 4 ? -16.49 : -18.99);
    add(15, 'PAYROLL DEPOSIT EXAMPLE CORP', 2500);
    for (let d = 2; d <= 26; d += 3) add(d, 'RETAIL PURCHASE COUCHE-TARD', -4.25);
    for (let d = 3; d <= 27; d += 6) add(d, 'VISA DEBIT PURCHASE PROVIGO', -Math.round((48.1 + d + k * 3.17) * 100) / 100);
    add(20, 'E-TRANSFER Sample Roommate', -300);
    extra(add, k, ym, last);
    v.statements.push({ id: ym, start: `${ym}-01`, end: `${ym}-${last}`, opening: 1000, closing: 1000 });
  }
  v.transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  return v;
}

await test('recurring charges: subscriptions, bills, rent by e-transfer, and price changes', () => {
  const m = buildModel(lifeVault(), compiled);
  const rec = recurring(m);
  const by = (name) => rec.find((r) => r.name === name);
  assert.equal(by('Netflix')?.cadence.id, 'monthly');
  assert.equal(by('Netflix').kind, 'subscription');
  assert.deepEqual([by('Netflix').change.from, by('Netflix').change.to, by('Netflix').change.date], [1649, 1899, '2026-04-06']);
  assert.equal(by('Netflix').next, '2026-07-06');
  assert.equal(by('Fizz')?.kind, 'bill');
  assert.ok(by('Sample Roommate'), 'same e-transfer every month is a regular');
  assert.ok(!by('Couche-Tard'), 'a regular coffee is a habit, not a subscription');
  assert.ok(!by('Provigo'), 'groceries of varying amounts are not recurring');
});

await test('upcoming bills only when the data is recent', () => {
  const m = buildModel(lifeVault(), compiled);
  const soon = upcoming(m, '2026-07-02');
  assert.ok(soon.some((r) => r.name === 'Fizz' && r.due === '2026-07-04'));
  assert.equal(upcoming(m, '2027-03-01').length, 0);
});

await test('double charges are flagged, habits and dismissed ones are not', () => {
  const v = lifeVault({ extra: (add, k) => { if (k === 6) { add(12, 'VISA DEBIT PURCHASE SPORT CHEK', -64.99); add(12, 'VISA DEBIT PURCHASE SPORT CHEK', -64.99); } } });
  const m = buildModel(v, compiled);
  const d = duplicates(m);
  assert.equal(d.length, 1);
  assert.equal(d[0].a.name, 'Sport Chek');
  assert.equal(duplicates(buildModel(v, compiled), [d[0].key]).length, 0);
  // Two transit fares a day, every day: normal.
  const v2 = lifeVault({ extra: (add) => { for (const d of [3, 5, 9]) { add(d, 'RETAIL PURCHASE STM METRO', -25); add(d, 'RETAIL PURCHASE STM METRO', -25); } } });
  assert.equal(duplicates(buildModel(v2, compiled)).length, 0);
});

await test('pace of an unfinished month, unusual charges, money in vs out', () => {
  const v = lifeVault({ extra: (add, k) => { if (k === 6) add(10, 'VISA DEBIT PURCHASE PROVIGO', -480); } });
  // July so far: only the first 10 days.
  v.transactions.push({ id: '2026-07-t-1', date: '2026-07-01', merchant: 'PREAUTHORIZED DEBIT SAMPLE PROPERTY MGMT', name: '', amount: -1200, category: 'other', statement: '2026-07' });
  v.transactions.push({ id: '2026-07-t-2', date: '2026-07-08', merchant: 'VISA DEBIT PURCHASE PROVIGO', name: '', amount: -300, category: 'other', statement: '2026-07' });
  v.statements.push({ id: '2026-07', start: '2026-07-01', end: '2026-07-10', opening: 1000, closing: 1000 });
  const m = buildModel(v, compiled);
  const p = pace(m, '2026-07-11');
  assert.equal(p.ym, '2026-07');
  assert.equal(pace(m, '2026-12-01'), null, 'no "July so far" in December');
  assert.equal(p.day, 10);
  assert.ok(p.soFar > p.usualSoFar, 'spending more than usual by day 10');
  assert.ok(p.projected > p.usualTotal);
  const u = unusual(m);
  assert.equal(u[0].t.amount, -480);
  assert.equal(u[0].kind, 'merchant');
  const cf = cashflow(m);
  assert.equal(cf.months.length, 6);
  assert.ok(cf.rate < 1 && cf.rate > -1);
});

await test('insight cards: ranked, with a detail for every one', () => {
  const v = lifeVault({ extra: (add, k) => { if (k === 6) { add(12, 'VISA DEBIT PURCHASE SPORT CHEK', -64.99); add(12, 'VISA DEBIT PURCHASE SPORT CHEK', -64.99); } } });
  const cards = insights(buildModel(v, compiled), '2026-07-02');
  const ids = cards.map((c) => c.id);
  assert.equal(ids[0], 'duplicate');
  for (const id of ['pricehike', 'upcoming', 'recurring', 'savings']) assert.ok(ids.includes(id), id);
  for (let i = 1; i < cards.length; i++) assert.ok(cards[i - 1].score >= cards[i].score);
  assert.ok(cards.length <= 12);
  for (const c of cards) assert.ok(c.title && c.text && c.kicker && c.icon, c.id);
});

await test('one big month on a bill is not a price rise; a reversed part leaves the rest counted', () => {
  const v = lifeVault({ extra: (add, k) => { if (k === 6) add(4, 'INTERNET BILL PAY FIZZ', -17.86); } }); // that month's bill: 40.24 + 17.86
  const fizz = recurring(buildModel(v, compiled)).find((r) => r.name === 'Fizz');
  assert.equal(fizz?.change, null);
  const w = emptyVault();
  w.statements.push({ id: '2026-03', start: '2026-03-01', end: '2026-03-31', opening: 100, closing: 100 });
  w.transactions.push({ id: 'x', date: '2026-03-02', merchant: 'COSTCO WHOLESALE', name: '', amount: -150.01, category: 'other', statement: '2026-03', parts: [{ category: 'groceries', amount: -100 }, { category: 'household', amount: -50.01 }] });
  w.transactions.push({ id: 'y', date: '2026-03-09', merchant: 'VISA DEBIT REVERSAL COSTCO WHOLESALE', name: '', amount: 50.01, category: 'other', statement: '2026-03' });
  const m = buildModel(w, compiled);
  assert.equal(m.byId.get('x').live, -10000);
  assert.equal(m.byId.get('x').netted, false);
});

console.log('Amazon and split charges');
await test('what a product is, from its title or department', () => {
  const p = (title, dept = '') => productCategory(title, dept, compiled);
  assert.equal(p('Apple iPhone 15 Pro Max Silicone Case with MagSafe'), 'electronics');
  assert.equal(p('Anker USB C Charger 65W'), 'electronics');
  assert.equal(p('Organic Whole Bean Coffee Beans 2lb'), 'groceries');
  assert.equal(p('Cuisinart Coffee Maker 12-Cup'), 'household');
  assert.equal(p('Bounty Paper Towels, 12 Rolls'), 'household');
  assert.equal(p('Nature Made Fish Oil 1200 mg'), 'health');
  assert.equal(p('Whey Protein Powder, Chocolate'), 'fitness');
  assert.equal(p('LEGO Classic Bricks'), 'entertainment');
  assert.equal(p('Something', 'Grocery & Gourmet Food'), 'groceries');
  assert.equal(p('Mystery widget'), null);
});

await test('Amazon descriptors that say what they were', () => {
  const c = (merchant) => categorize({ merchant, amount: -10 }, compiled, []);
  assert.deepEqual(c('AMZN Mktp CA*2A3B4C5D6'), { name: 'Amazon', category: 'shopping' });
  assert.equal(c('Amazon Prime*1A2B3C').category, 'entertainment');
  assert.equal(c('Kindle Svcs*X1Y2').category, 'entertainment');
  assert.equal(c('AMAZON FRESH').category, 'groceries');
  assert.equal(c('WHOLEFDS MKT 10234').category, 'groceries');
  assert.equal(c('AMAZON PHARMACY').category, 'health');
  assert.equal(c('BEST BUY #123').category, 'electronics');
  assert.equal(c('HOME DEPOT 7034').category, 'household');
  assert.ok(isMixedStore('Amazon', compiled) && isMixedStore('Costco', compiled) && !isMixedStore('Netflix', compiled));
});

// The columns Amazon's "Your Orders" export has, with made-up values.
const AMZ_HEAD = ['Website', 'Order ID', 'Order Date', 'Purchase Order Number', 'Currency', 'Unit Price', 'Unit Price Tax', 'Shipping Charge', 'Total Discounts', 'Total Owed', 'Shipment Item Subtotal', 'Shipment Item Subtotal Tax', 'ASIN', 'Product Condition', 'Quantity', 'Payment Instrument Type', 'Order Status', 'Shipment Status', 'Ship Date', 'Shipping Option', 'Shipping Address', 'Billing Address', 'Carrier Name & Tracking Number', 'Product Name', 'Gift Message', 'Gift Sender Name', 'Gift Recipient Contact Details', 'Item Serial Number'];
const amzRow = (order, date, ship, total, title, status = 'Closed') => ['Amazon.ca', order, `${date}T15:00:00Z`, 'Not Applicable', 'CAD', String(total), '0', '0', '0', String(total), 'Not Available', 'Not Available', 'B0SAMPLE', 'New', '1', 'Visa - 0000', status, 'Shipped', ship ? `${ship}T10:00:00Z` : 'Not Available', 'std', '1 SAMPLE STREET SAMPLETOWN', '1 SAMPLE STREET SAMPLETOWN', 'CARRIER(TRACK0000)', title, '', '', '', ''];
const csvOf = (rows) => [AMZ_HEAD, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
function zipOf(files) {
  // A minimal zip: deflated entries, central directory, end record (CRCs aren't checked by the reader).
  const parts = [], central = [];
  let off = 0;
  for (const [name, text] of files) {
    const nameB = Buffer.from(name), data = deflateRawSync(Buffer.from(text)), raw = Buffer.byteLength(text);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw, 22); local.writeUInt16LE(nameB.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw, 24); cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(off, 42);
    parts.push(local, nameB, data); central.push(cd, nameB);
    off += 30 + nameB.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, end]));
}

await test('Amazon order history: read from the zip, grouped by shipment, addresses never kept', async () => {
  const csv = csvOf([
    amzRow('701-0000001-0000001', '2026-03-03', '2026-03-04', 22.59, 'Organic Whole Bean Coffee Beans 2lb'),
    amzRow('701-0000001-0000001', '2026-03-03', '2026-03-04', 33.89, 'Anker USB C Charger 65W'),
    amzRow('701-0000001-0000001', '2026-03-03', '2026-03-09', 12.5, 'Paper Towels, 6 Rolls'),
    amzRow('701-0000002-0000002', '2026-03-10', '2026-03-11', 1015.87, 'Samsung Galaxy S24 128GB Unlocked'),
    amzRow('701-0000003-0000003', '2026-03-12', null, 16.95, 'Bounty Paper Towels', 'Cancelled'),
  ]);
  const zip = zipOf([['Retail.OrderHistory.1/Retail.OrderHistory.1.csv', csv], ['Digital-Ordering.1/Digital Items.csv', 'ASIN,Title\nX,Y\n']]);
  const ships = await readOrderFiles([{ bytes: zip }], compiled);
  assert.deepEqual(ships.map((s) => [s.date, s.ship, s.cents, s.items.map((i) => i.category).join('+')]), [
    ['2026-03-03', '2026-03-04', 5648, 'groceries+electronics'],
    ['2026-03-03', '2026-03-09', 1250, 'household'],
    ['2026-03-10', '2026-03-11', 101587, 'electronics'],
  ]);
  const v = emptyVault();
  applyOrders(v, ships);
  assert.equal(v.orders.length, 3, 'waiting for statements');
  const json = JSON.stringify(v);
  assert.ok(!/SAMPLE STREET|TRACK0000|701-000|Visa - 0000/.test(json), 'no address, tracking, order number or card kept');
  // The CSV inside works on its own too.
  assert.equal((await readOrderFiles([{ bytes: new TextEncoder().encode(csv) }], compiled)).length, 3);
  await assert.rejects(readOrderFiles([{ bytes: new TextEncoder().encode('Date,Description,Amount\n2026-01-01,X,1\n') }], compiled), /No Amazon orders/);
  // Two files out of order make one timeline.
  const two = await readOrderFiles([{ bytes: new TextEncoder().encode(csvOf([amzRow('701-9', '2026-05-02', '2026-05-03', 9, 'Pasta')])) }, { bytes: new TextEncoder().encode(csv) }], compiled);
  assert.deepEqual(two.map((x) => x.date), ['2026-03-03', '2026-03-03', '2026-03-10', '2026-05-02']);
  assert.deepEqual([_amz.day('03/25/2024'), _amz.day('25/03/2024'), _amz.day('13/13/2024')], ['2024-03-25', '2024-03-25', null]);
});

await test('Amazon orders matched to charges: split by category, refunds sorted, whole-order charges', async () => {
  const csv = csvOf([
    amzRow('701-0000001-0000001', '2026-03-03', '2026-03-04', 22.59, 'Organic Whole Bean Coffee Beans 2lb'),
    amzRow('701-0000001-0000001', '2026-03-03', '2026-03-04', 33.89, 'Anker USB C Charger 65W'),
    amzRow('701-0000002-0000002', '2026-03-10', '2026-03-11', 1015.87, 'Samsung Galaxy S24 128GB Unlocked'),
    amzRow('701-0000004-0000004', '2026-03-14', '2026-03-15', 10, 'Dish Soap'),
    amzRow('701-0000004-0000004', '2026-03-14', '2026-03-17', 20, 'Vitamin D3 Softgels'),
  ]);
  const ships = await readOrderFiles([{ bytes: new TextEncoder().encode(csv) }], compiled);
  const v = emptyVault();
  v.statements.push({ id: '2026-03', start: '2026-03-01', end: '2026-03-31', opening: 2000, closing: 0 });
  const tx = (id, date, merchant, amount) => v.transactions.push({ id, date, merchant, name: '', amount, category: 'other', statement: '2026-03' });
  tx('a', '2026-03-05', 'AMZN Mktp CA*2A3B4C5', -56.48);
  tx('b', '2026-03-12', 'AMAZON.CA*XY12', -1015.87);
  tx('c', '2026-03-14', 'AMAZON.CA*AB34', -30);
  tx('d', '2026-03-20', 'AMAZON.CA', 33.89);
  tx('e', '2026-03-21', 'AMAZON.CA*ZZ', -12.0);
  // The statement with the last charge comes later.
  const late = v.transactions.splice(v.transactions.findIndex((t) => t.id === 'c'), 1)[0];
  buildModel(v, compiled); // names first, as the app has them
  const r = applyOrders(v, ships);
  assert.deepEqual([r.charges, r.matched, r.refunds], [3, 2, 1]);
  assert.equal(v.orders.length, 2, 'only the shipments still waiting are kept');
  v.transactions.push(late);
  buildModel(v, compiled);
  assert.equal(matchWaiting(v).matched, 1);
  assert.equal(v.orders, undefined, 'nothing left waiting');
  const m = buildModel(v, compiled);
  const parts = m.txns.filter((t) => t.partOf === 'a');
  assert.deepEqual(parts.map((t) => [t.cat.id, t.c]), [['groceries', -2259], ['electronics', -3389]]);
  assert.equal(m.byId.get('a').split.length, 2, 'the whole charge is still one entry');
  assert.equal(m.byId.get('b').cat.id, 'electronics');
  assert.deepEqual(m.txns.filter((t) => t.partOf === 'c').map((t) => t.cat.id).sort(), ['health', 'household']);
  assert.equal(m.byId.get('d').cat.id, 'electronics', 'refund of the charger reduces Electronics');
  assert.equal(m.byId.get('e').cat.id, 'shopping');
  // Totals add up the same with or without splits.
  assert.equal(m.txns.reduce((s, t) => s + t.c, 0), v.transactions.reduce((s, t) => s + toCents(t.amount), 0));
  const cats = Object.fromEntries(spendByCategory(m.txns).map((x) => [x.cat.id, x.cents]));
  assert.equal(cats.electronics, 3389 + 101587 - 3389);
  // Your own fix to an item survives matching again.
  v.transactions.find((t) => t.id === 'a').items[0].category = 'household';
  v.transactions.find((t) => t.id === 'a').items[0].set = true;
  applyOrders(v, ships);
  assert.equal(v.transactions.find((t) => t.id === 'a').items[0].category, 'household');
});

await test('splitting a charge by hand, and a refund of a whole split charge', () => {
  const v = emptyVault();
  v.statements.push({ id: '2026-03', start: '2026-03-01', end: '2026-03-31', opening: 100, closing: 100 });
  v.transactions.push({ id: 'x', date: '2026-03-02', merchant: 'COSTCO WHOLESALE', name: '', amount: -150.01, category: 'other', statement: '2026-03', parts: [{ category: 'groceries', amount: -100 }, { category: 'household', amount: -50.01 }] });
  v.transactions.push({ id: 'y', date: '2026-03-09', merchant: 'VISA DEBIT REVERSAL COSTCO WHOLESALE', name: '', amount: 150.01, category: 'other', statement: '2026-03' });
  const m = buildModel(v, compiled);
  assert.deepEqual(m.txns.filter((t) => t.partOf).map((t) => [t.cat.id, t.c, t.netted]), [['groceries', -10000, true], ['household', -5001, true]]);
  assert.equal(m.byId.get('y').netted, true);
  assert.equal(m.byId.get('x').netted, true);
  assert.deepEqual(splitParts({ amount: -10, items: [{ amount: 3.33, category: 'a' }, { amount: 3.33, category: 'b' }, { amount: 3.34, category: 'a' }] }).map((p) => p.cents), [667, 333]);
});

await test('the sample data shows every new kind of insight', async () => {
  const { app } = await import('../js/state.js');
  app.rules = compiled;
  const { demoVault } = await import('../js/demo.js');
  const ids = insights(buildModel(demoVault(), compiled), '2026-10-09').map((c) => c.id);
  for (const id of ['duplicate', 'pace', 'pricehike', 'upcoming', 'unusual', 'recurring', 'amazon']) assert.ok(ids.includes(id), id);
});

console.log('Bank sync');
const feed = (id, date, amount, name, extra = {}) => ({ id, account: extra.account || 'acc-chq', date, amount, currency: 'CAD', name, merchant: extra.merchant || '', original: extra.original ?? name.toUpperCase(), pending: !!extra.pending, pfc: extra.pfc || '' });
function fileVault() {
  // September from a statement file: opens at 900, one coffee, closes at 1000 after pay.
  const v = emptyVault();
  v.statements.push({ id: '2026-09', start: '2026-09-01', end: '2026-09-30', opening: 900, closing: 1000, reconciled: true, source: 'pdf' });
  v.transactions.push({ id: '2026-09-0901-001', date: '2026-09-02', merchant: 'VISA DEBIT PURCHASE STARBUCKS', name: '', amount: -5, category: 'other', statement: '2026-09' });
  v.transactions.push({ id: '2026-09-0901-002', date: '2026-09-15', merchant: 'PAYROLL DEPOSIT EXAMPLE CORP', name: '', amount: 105, category: 'other', statement: '2026-09' });
  v.bank = { institution: 'Sample Bank', accessToken: 'access-sandbox-x', accountId: 'acc-chq', accountName: 'Chequing', type: 'depository', cursor: '' };
  return v;
}

await test('synced transactions fill only the days after your statement files', () => {
  const v = fileVault();
  const res = {
    added: [
      feed('p1', '2026-09-15', -105, 'Payroll'), // already in the September file
      feed('o1', '2026-10-02', 12.5, 'Qwerty Studio', { pfc: 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS' }),
      feed('o2', '2026-10-03', 6.25, 'Starbucks', { merchant: 'Starbucks', original: 'VISA DEBIT PURCHASE STARBUCKS 1234', pfc: 'FOOD_AND_DRINK_RESTAURANT' }),
      feed('o3', '2026-10-04', 40, 'Pending thing', { pending: true }),
      feed('o4', '2026-10-04', 70, 'Card purchase', { account: 'acc-card' }),
      feed('o5', '2026-10-05', -200, 'Mystery deposit', { pfc: 'INCOME_WAGES' }),
    ],
    modified: [], removed: [], cursor: 'c6', accounts: [{ id: 'acc-chq', current: 1181.25, currency: 'CAD', type: 'depository' }],
  };
  const counts = applyBankSync(v, res, { today: '2026-10-08' });
  assert.deepEqual(counts, { added: 3, updated: 0, removed: 0, skipped: 1 });
  assert.equal(v.bank.cursor, 'c6');
  const m = buildModel(v, compiled);
  const by = (ext) => m.txns.find((t) => t.ext === ext);
  assert.equal(by('o1').amount, -12.5, 'money out is negative');
  assert.equal(by('o1').cat.id, 'fitness', 'unknown place: the bank feed’s category');
  assert.equal(by('o2').cat.id, 'coffee', 'known place: Money’s own rules win');
  assert.equal(by('o2').name, 'Starbucks');
  assert.equal(by('o5').cat.id, 'income');
  // October has its own statement, with balances worked back from the bank's balance now.
  const oct = v.statements.find((s) => s.id === '2026-10');
  assert.deepEqual([oct.start, oct.end, oct.opening, oct.closing, oct.source, oct.reconciled], ['2026-10-01', '2026-10-08', 1000, 1181.25, 'sync', null]);
  assert.equal(dailyBalance(m).at(-1).bal, 118125);
  assert.ok(!JSON.stringify(v).includes('access-sandbox-x') || v.bank.accessToken === 'access-sandbox-x', 'the token lives only in vault.bank');
});

await test('the bank’s corrections and removals, keeping your own changes', () => {
  const v = fileVault();
  applyBankSync(v, { added: [feed('o1', '2026-10-02', 12.5, 'Qwerty Studio'), feed('o2', '2026-10-03', 8, 'Corner Shop')], modified: [], removed: [], cursor: 'c2', accounts: [] }, { today: '2026-10-08' });
  const o1 = v.transactions.find((t) => t.ext === 'o1');
  o1.category = 'health'; o1.locked = true;
  applyBankSync(v, { added: [], modified: [feed('o1', '2026-10-02', 13.75, 'Qwerty Studio')], removed: ['o2'], cursor: 'c3', accounts: [] }, { today: '2026-10-08' });
  assert.equal(o1.amount, -13.75);
  assert.equal(o1.locked, true);
  assert.equal(o1.category, 'health');
  assert.equal(v.transactions.some((t) => t.ext === 'o2'), false);
});

await test('a statement added later replaces the synced days it covers', () => {
  const v = fileVault();
  applyBankSync(v, { added: [feed('o1', '2026-10-02', 12.5, 'Qwerty Studio'), feed('o2', '2026-11-03', 8, 'Corner Shop')], modified: [], removed: [], cursor: 'c2', accounts: [{ id: 'acc-chq', current: 979.5 }] }, { today: '2026-11-04' });
  // The October PDF arrives.
  const parsed = { period: { start: '2026-10-01', end: '2026-10-31' }, opening: 1000, closing: 987.5, transactions: [{ date: '2026-10-02', description: 'RETAIL PURCHASE QWERTY STUDIO', amount: -12.5, balance: 987.5 }] };
  commitImport(v, prepareImport(v, parsed, compiled));
  assert.equal(v.transactions.filter((t) => t.statement === '2026-10').length, 1);
  assert.equal(v.transactions.some((t) => t.ext === 'o1'), false);
  assert.notEqual(v.statements.find((s) => s.id === '2026-10').source, 'sync');
  // The feed sends October again: it belongs to the file now.
  const c = applyBankSync(v, { added: [feed('o1', '2026-10-02', 12.5, 'Qwerty Studio')], modified: [], removed: [], cursor: 'c3', accounts: [{ id: 'acc-chq', current: 979.5 }] }, { today: '2026-11-04' });
  assert.equal(c.skipped, 1);
  assert.equal(v.statements.find((s) => s.id === '2026-11').opening, 987.5);
});

await test('a file that stops mid-month is carried on by the feed', () => {
  const v = fileVault();
  v.statements.push({ id: '2026-10', start: '2026-10-01', end: '2026-10-15', opening: 1000, closing: 990, reconciled: null, source: 'csv' });
  v.transactions.push({ id: '2026-10-1001-001', date: '2026-10-10', merchant: 'CORNER SHOP', name: '', amount: -10, category: 'other', statement: '2026-10' });
  applyBankSync(v, { added: [feed('o1', '2026-10-12', 10, 'Corner Shop'), feed('o2', '2026-10-20', 25, 'Book Nook')], modified: [], removed: [], cursor: 'c2', accounts: [{ id: 'acc-chq', current: 965 }] }, { today: '2026-10-21' });
  const oct = v.statements.find((s) => s.id === '2026-10');
  assert.deepEqual([oct.fileEnd, oct.end, oct.closing, oct.synced, oct.count], ['2026-10-15', '2026-10-21', 965, true, 2]);
  assert.equal(lastFileDay(v), '2026-10-15');
  assert.equal(v.statements.length, 2);
});

await test('bank categories map to Money’s', () => {
  assert.equal(hintCategory('FOOD_AND_DRINK_GROCERIES'), 'groceries');
  assert.equal(hintCategory('GENERAL_MERCHANDISE_ELECTRONICS'), 'electronics');
  assert.equal(hintCategory('RENT_AND_UTILITIES_RENT'), 'housing');
  assert.equal(hintCategory('TRANSFER_OUT_ACCOUNT_TRANSFER'), 'own');
  assert.equal(hintCategory('INCOME_WAGES', -10), null, 'money out is never income');
  assert.equal(hintCategory('FOOD_AND_DRINK_RESTAURANT', 10), 'dining', 'a refund keeps its category');
  assert.equal(hintCategory('SOMETHING_NEW'), null);
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
