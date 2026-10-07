// Made-up sample data for exploring the app without unlocking a real vault. Nothing here is real.
import { emptyVault, planFromTemplate } from './ledger.js';
import { iso } from './format.js';
import { app } from './state.js';

function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

export function demoVault() {
  const r = rng(7);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const amt = (lo, hi) => Math.round((lo + r() * (hi - lo)) * 100) / 100;
  const v = emptyVault();
  v.account = { bank: 'Sample Bank', name: 'Chequing', currency: 'CAD' };
  let bal = 8200;
  const year = 2026;
  for (let m = 1; m <= 9; m++) {
    const days = new Date(year, m, 0).getDate();
    const id = `${year}-${String(m).padStart(2, '0')}`;
    const list = [];
    const add = (d, merchant, amount) => list.push({ date: iso(new Date(year, m - 1, d)), merchant, amount });
    for (let d = 1; d <= days; d++) {
      if (r() < 0.42) add(d, pick(['RETAIL PURCHASE COUCHE-TARD', 'RETAIL PURCHASE COUCHE-TARD', 'RETAIL PURCHASE TIM HORTONS', 'VISA DEBIT PURCHASE STARBUCKS']), -amt(2.2, 8.5));
      if (r() < 0.16) add(d, pick(['VISA DEBIT PURCHASE PROVIGO', 'VISA DEBIT PURCHASE METRO PLUS', 'VISA DEBIT PURCHASE MARCHE ADONIS', 'VISA DEBIT PURCHASE SUPER C']), -amt(14, 72));
      if (r() < 0.1) add(d, pick(['VISA DEBIT PURCHASE UBER *EATS', 'VISA DEBIT PURCHASE A&W', 'VISA DEBIT PURCHASE SUSHI SHOP', 'VISA DEBIT PURCHASE PIZZA IL FORNO', 'VISA DEBIT PURCHASE RAMEN KINTON']), -amt(12, 46));
      if (r() < 0.08) add(d, pick(['RETAIL PURCHASE DOLLARAMA', 'VISA DEBIT PURCHASE AMAZON.CA', 'VISA DEBIT PURCHASE CANADIAN TIRE', 'VISA DEBIT PURCHASE IKEA']), -amt(4, 60));
      if (r() < 0.05) add(d, pick(['VISA DEBIT PURCHASE UBER *TRIP', 'VISA DEBIT PURCHASE LYFT']), -amt(9, 26));
      if (r() < 0.03) add(d, 'VISA DEBIT PURCHASE JEAN COUTU', -amt(6, 30));
    }
    add(1, 'PREAUTHORIZED DEBIT GESTION IMMOBILIERE SAMPLE', -950);
    add(2, 'RETAIL PURCHASE STM OPUS', -97);
    add(4, 'INTERNET BILL PAY FIZZ', -40.24);
    add(6, 'VISA DEBIT PURCHASE NETFLIX.COM', -18.39);
    add(8, 'PREAUTHORIZED DEBIT ENERGIE CARDIO', -24.14);
    add(15, 'PAYROLL DEPOSIT SAMPLE EMPLOYER', 1460 + Math.round(r() * 40));
    add(Math.min(days, 30), 'PAYROLL DEPOSIT SAMPLE EMPLOYER', 1460 + Math.round(r() * 40));
    if (r() < 0.6) add(10 + Math.floor(r() * 10), 'E-TRANSFER Sample Friend', -amt(20, 120));
    if (r() < 0.4) add(5 + Math.floor(r() * 20), 'E-TRANSFER Sample Friend', amt(15, 80));
    add(days, 'SERVICE CHARGE MONTHLY FEE', -6.95);
    add(days, 'SERVICE CHARGE DISCOUNT', 6.95);
    if (m === 1 || m === 5) add(12, 'INTERNET BILL PAY SAMPLE UNIVERSITY TUITION', -amt(2800, 3400));
    if (m === 4) { add(9, 'VISA DEBIT PURCHASE AIR CANADA', -1240.5); add(18, 'VISA DEBIT PURCHASE AIRBNB', -612.4); add(19, 'VISA DEBIT PURCHASE LAWSON TOKYO', -23.1); }
    if (m === 6) { add(14, 'VISA DEBIT PURCHASE AMAZON.CA', -89.99); add(17, 'VISA DEBIT PURCHASE REVERSAL AMAZON.CA', 89.99); }
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    const opening = Math.round(bal * 100) / 100;
    let wd = 0, dep = 0;
    list.forEach((t, i) => {
      bal += t.amount;
      if (t.amount < 0) wd -= t.amount; else dep += t.amount;
      v.transactions.push({ id: `${id}-${String(i + 1).padStart(3, '0')}`, date: t.date, merchant: t.merchant, name: '', amount: t.amount, category: 'other', statement: id, balance: Math.round(bal * 100) / 100 });
    });
    bal = Math.round(bal * 100) / 100;
    v.statements.push({ id, start: `${id}-01`, end: `${id}-${days}`, opening, closing: bal, withdrawals: Math.round(wd * 100) / 100, deposits: Math.round(dep * 100) / 100, count: list.length, reconciled: true, checks: [], issues: [], importedAt: new Date().toISOString() });
  }
  v.plan = planFromTemplate(app.rules, { employer: 'Sample Co', start: '2026-11-02', takeHome: 5200, savePct: 60 });
  return v;
}
