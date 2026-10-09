// The ledger: vault shape, importing statements, netting reversals, and every number the UI shows.
// Pure functions (no DOM) so they can be tested in Node.
import { money, toCents, fromCents, monthOf, addDays, daysBetween, parseISO, iso, monthLabel, nextMonth, daysInMonth } from './format.js';
import { categorize, sanitizeDescription } from './categorize.js';
import { reconcile } from './cibc-parser.js';

export const SCHEMA = 1;

export function emptyVault() {
  return {
    schema: SCHEMA,
    account: { bank: null, name: null, currency: 'CAD' },
    statements: [],
    transactions: [],
    userRules: [],
    plan: null,
    settings: { autoLockMinutes: 5 },
  };
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

const dupKey = (t) => `${t.date}|${toCents(t.amount)}|${(t.merchant || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}`;

/**
 * Turn a parsed statement into a candidate import: sanitized, categorized,
 * reconciled, and checked for duplicates against what the vault already has.
 */
export function prepareImport(vault, parsed, compiled) {
  const rec = reconcile(parsed);
  const id = parsed.period ? parsed.period.end.slice(0, 7) : null;
  const existing = id ? vault.statements.find((s) => s.id === id) : null;
  const inPeriod = inside(parsed.period);

  // Duplicate detection: a transaction already in the vault (same date, amount and description).
  // Counted as a multiset so two identical coffees on one day both survive. Lines of this month that
  // fall inside the new file's dates are about to be replaced, so they don't count.
  const counts = new Map();
  for (const t of vault.transactions) {
    if (existing && t.statement === id && inPeriod(t)) continue;
    const k = dupKey(t);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const txns = [];
  let duplicates = 0;
  const tag = parsed.period ? parsed.period.start.slice(5).replace('-', '') : '0000';
  parsed.transactions.forEach((t, i) => {
    const merchant = sanitizeDescription(t.description);
    const base = { id: `${id}-${tag}-${String(i + 1).padStart(3, '0')}`, date: t.date, merchant, name: '', amount: Math.round(t.amount * 100) / 100, category: 'other', statement: id };
    if (t.balance != null) base.balance = t.balance;
    const k = dupKey(base);
    if (counts.get(k) > 0) { counts.set(k, counts.get(k) - 1); duplicates++; return; }
    Object.assign(base, categorize(base, compiled, vault.userRules, vault.account?.currency));
    txns.push(base);
  });

  return {
    id,
    label: id ? monthLabel(id) : 'Unknown period',
    period: parsed.period,
    opening: parsed.opening,
    closing: parsed.closing,
    summaryTotals: parsed.summaryTotals,
    reconciliation: rec,
    warnings: parsed.warnings,
    transactions: txns,
    parsedCount: parsed.transactions.length,
    duplicates,
    meta: parsed.meta || { parser: 'cibc', format: 'pdf' },
    alreadyImported: !!existing,
  };
}

const inside = (period) => (t) => !period || (t.date >= period.start && t.date <= period.end);

/** Commit a prepared import into the vault (mutates and returns it). */
export function commitImport(vault, prep) {
  if (!prep.id) throw new Error('Statement period unknown');
  // The first statement in a new vault sets the account's currency and kind.
  if (!vault.statements.length && vault.account) {
    if (prep.meta?.currency) vault.account.currency = prep.meta.currency;
    if (prep.meta?.bank) vault.account.bank = prep.meta.bank;
    if (prep.meta?.card) vault.account.name = 'Credit Card';
  }
  // Re-importing replaces only the dates the new file covers (a partial CSV mustn't erase the rest of
  // the month), and keeps manual edits (category, one-off) on the same transactions.
  const covered = inside(prep.period);
  const replaced = (t) => t.statement === prep.id && covered(t);
  const old = new Map();
  for (const t of vault.transactions) if (replaced(t) && (t.locked || t.oneOff)) old.set(dupKey(t), t);
  for (const t of prep.transactions) {
    const o = old.get(dupKey(t));
    if (!o) continue;
    if (o.locked) { t.locked = true; t.category = o.category; t.name = o.name || t.name; }
    if (o.oneOff) t.oneOff = true;
  }
  const prev = vault.statements.find((s) => s.id === prep.id);
  vault.transactions = vault.transactions.filter((t) => !replaced(t)).concat(prep.transactions);
  vault.transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  let st = {
    id: prep.id,
    start: prep.period.start,
    end: prep.period.end,
    opening: prep.opening,
    closing: prep.closing,
    withdrawals: prep.reconciliation.totals.withdrawals,
    deposits: prep.reconciliation.totals.deposits,
    count: prep.transactions.length,
    reconciled: prep.reconciliation.ok, // true, false, or null when the file had no balances to check
    source: prep.meta?.parser === 'cibc' ? 'cibc' : prep.meta?.format || 'pdf',
    checks: prep.reconciliation.checks,
    issues: prep.reconciliation.issues,
    importedAt: new Date().toISOString(),
  };
  // The month already had dates the new file doesn't cover: merge the two into one statement.
  if (prev && (prev.start < st.start || prev.end > st.end)) {
    const mine = vault.transactions.filter((t) => t.statement === prep.id);
    let wd = 0, dep = 0;
    for (const t of mine) { if (t.amount < 0) wd += toCents(-t.amount); else dep += toCents(t.amount); }
    const both = [prev.reconciled, st.reconciled];
    st = {
      ...st,
      start: prev.start < st.start ? prev.start : st.start,
      end: prev.end > st.end ? prev.end : st.end,
      opening: prev.start < st.start ? prev.opening : st.opening,
      closing: prev.end > st.end ? prev.closing : st.closing,
      withdrawals: fromCents(wd),
      deposits: fromCents(dep),
      count: mine.length,
      reconciled: both.includes(false) ? false : both.includes(null) ? null : true,
      issues: [...(prev.issues || []), ...(st.issues || [])],
    };
  }
  vault.statements = vault.statements.filter((s) => s.id !== prep.id).concat(st).sort((a, b) => (a.start < b.start ? -1 : 1));
  return vault;
}

// ---------------------------------------------------------------------------
// Reversals, corrections and waived fees
// ---------------------------------------------------------------------------

const REVERSAL_RE = /REVERSAL|REVERSE|CORRECTION|REBATE|WAIVED|WAIVE|SERVICE CHARGE DISCOUNT|FEE DISCOUNT|RECLAIM|CANCEL|ANNUL|REFUND OF FEE|RETURNED/i;

/** Pair each reversal/correction/fee waiver with the transaction it undoes. Both are then excluded from totals. */
export function markReversals(txns) {
  for (const t of txns) { t.pair = null; t.netted = false; }
  const candidates = txns.filter((t) => REVERSAL_RE.test(t.merchant));
  for (const c of candidates) {
    if (c.pair) continue;
    let best = null;
    for (const p of txns) {
      if (p === c || p.pair || p.c !== -c.c) continue;
      // Only undo the same merchant (or a fee waived against a fee): a "cash back rebate" isn't an Amazon refund.
      if (p.name !== c.name && !(p.category === 'fees' && c.category === 'fees')) continue;
      const days = daysBetween(p.date, c.date);
      if (days < -3 || days > 60) continue;
      const score = (p.name === c.name ? 0 : 1000) + (REVERSAL_RE.test(p.merchant) ? 500 : 0) + Math.abs(days);
      if (!best || score < best.score) best = { p, score };
    }
    if (best) {
      c.pair = best.p.id; best.p.pair = c.id;
      c.netted = best.p.netted = true;
    }
  }
}

// ---------------------------------------------------------------------------
// The model the UI renders from
// ---------------------------------------------------------------------------

export function buildModel(vault, compiled) {
  const cats = compiled.cats;
  const fallback = cats.get('other');
  // Categorizing is the slow part of a rebuild; the answer only depends on the description, the
  // direction of money, your rules and the home currency, so each distinct merchant is worked out once.
  const home = vault.account?.currency;
  const sig = `${home}|${(vault.userRules || []).map((r) => `${r.name}\u0001${r.category}\u0001${r.sign}`).join('\u0002')}`;
  if (compiled.memoSig !== sig || !compiled.memo || compiled.memo.size > 50_000) { compiled.memo = new Map(); compiled.memoSig = sig; }
  const decide = (t) => {
    const key = `${Math.sign(t.amount) || -1}|${t.merchant}`;
    let r = compiled.memo.get(key);
    if (!r) { r = categorize({ ...t, locked: false }, compiled, vault.userRules, home); compiled.memo.set(key, r); }
    return r;
  };
  const txns = vault.transactions.map((t, i) => {
    if (!t.locked) Object.assign(t, decide(t));
    else if (!t.name) t.name = decide(t).name;
    return { ...t, c: toCents(t.amount), month: monthOf(t.date), cat: cats.get(t.category) || fallback, idx: i };
  });
  markReversals(txns);
  const byId = new Map(txns.map((t) => [t.id, t]));
  const statements = [...vault.statements].sort((a, b) => (a.start < b.start ? -1 : 1));
  const months = [...new Set(txns.map((t) => t.month))].sort();
  return { vault, compiled, cats, txns, byId, statements, months, plan: vault.plan };
}

export const live = (t) => !t.netted;
export const isSpend = (t) => t.cat.type === 'spend';
export const isEveryday = (t) => isSpend(t) && t.cat.everyday && !t.oneOff;
export const filterMode = (mode) => (mode === 'everyday' ? isEveryday : isSpend);

/** Money in / out / net (cents) for txns whose date is within [from, to]. Netted pairs excluded, so net = balance change. */
export function flow(model, from, to) {
  let inn = 0, out = 0, n = 0;
  for (const t of model.txns) {
    if (t.netted || t.date < from || t.date > to) continue;
    if (t.c > 0) inn += t.c; else out -= t.c;
    n++;
  }
  return { inn, out, net: inn - out, count: n };
}

/** Spending by category (cents, positive = spent). Refunds reduce their category. */
export function spendByCategory(txns, mode = 'everything') {
  const f = filterMode(mode);
  const map = new Map();
  for (const t of txns) {
    if (t.netted || !f(t)) continue;
    const e = map.get(t.cat.id) || { cat: t.cat, cents: 0, count: 0 };
    e.cents -= t.c;
    if (t.c < 0) e.count++;
    map.set(t.cat.id, e);
  }
  return [...map.values()].filter((e) => e.cents > 0).sort((a, b) => b.cents - a.cents);
}

export function monthTxns(model, ym) { return ym === 'all' ? model.txns : model.txns.filter((t) => t.month === ym); }

/** For the monthly stacked chart: [{ym, total, parts: Map(catId -> cents)}] */
export function monthlySpend(model, mode) {
  return model.months.map((ym) => {
    const rows = spendByCategory(monthTxns(model, ym), mode);
    return { ym, total: rows.reduce((s, r) => s + r.cents, 0), rows };
  });
}

export function topMerchants(txns, mode = 'everything', limit = 8) {
  const f = filterMode(mode);
  const map = new Map();
  for (const t of txns) {
    if (t.netted || !f(t)) continue;
    const e = map.get(t.name) || { name: t.name, cat: t.cat, cents: 0, count: 0 };
    e.cents -= t.c;
    if (t.c < 0) e.count++;
    map.set(t.name, e);
  }
  return [...map.values()].filter((e) => e.cents > 0).sort((a, b) => b.count - a.count || b.cents - a.cents).slice(0, limit);
}

/** End-of-day balance for every day covered by statements: [{date, bal (cents)}]. Worked out once per model. */
export function dailyBalance(model) {
  if (!model.daily) model.daily = computeDailyBalance(model);
  return model.daily;
}
function computeDailyBalance(model) {
  const out = [];
  const byDate = new Map();
  for (const t of model.txns) byDate.set(t.date, (byDate.get(t.date) || 0) + t.c);
  let bal = null;
  // Files without any balance (some CSV exports) still get a line: the running net from zero.
  out.relative = !model.statements.some((s) => s.opening != null);
  for (const st of model.statements) {
    if (st.opening == null && !out.relative && !out.length) continue;
    let day = st.start;
    if (out.length && out[out.length - 1].date >= day) day = addDays(out[out.length - 1].date, 1);
    bal = st.opening != null ? toCents(st.opening) : out.length ? out[out.length - 1].bal : 0;
    // CIBC's opening balance is as of the first day, before that day's transactions.
    const txIn = (d) => byDate.get(d) || 0;
    if (out.length && daysBetween(out[out.length - 1].date, st.start) > 1) {
      // gap between statements: hold the last known balance
      for (let d = addDays(out[out.length - 1].date, 1); d < st.start; d = addDays(d, 1)) out.push({ date: d, bal: out[out.length - 1].bal, gap: true });
    }
    for (let d = st.start; d <= st.end; d = addDays(d, 1)) {
      bal += txIn(d);
      if (d >= day) out.push({ date: d, bal });
    }
    // Snap to the statement's printed closing balance (they are equal when reconciled), but only when this
    // statement is what the line ends on (one nested inside another must not move the later balance).
    if (st.closing != null && out.length && out[out.length - 1].date === st.end) out[out.length - 1].bal = toCents(st.closing);
  }
  return out;
}

export function currentBalance(model) {
  const d = dailyBalance(model);
  if (!d.length) return null;
  return { cents: d[d.length - 1].bal, date: d[d.length - 1].date, relative: d.relative };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function planFromTemplate(compiled, { employer = '', start, takeHome, savePct }) {
  const save = Math.round(takeHome * savePct / 100);
  const spend = Math.round(takeHome - save);
  const lines = compiled.planTemplate.lines.map((l) => ({ id: l.id, name: l.name, amount: Math.round(spend * l.share), categories: [...l.categories] }));
  const diff = spend - lines.reduce((s, l) => s + l.amount, 0);
  const flex = lines.find((l) => l.categories.includes('*')) || lines[lines.length - 1];
  flex.amount += diff;
  return { employer, start, takeHome, savePct, lines, eatingOut: [...compiled.planTemplate.eatingOut] };
}

export const planTargets = (plan) => {
  const save = Math.round(plan.takeHome * plan.savePct / 100);
  return { save, spend: Math.round(plan.takeHome - save), eatingOut: plan.lines.filter((l) => l.categories.some((c) => plan.eatingOut.includes(c))).reduce((s, l) => s + l.amount, 0) };
};

/** Budget months: calendar months from the plan's start month onwards that we have data for (plus the current one). */
export function planMonths(model) {
  if (!model.plan?.start) return [];
  const first = monthOf(model.plan.start);
  const last = [model.months[model.months.length - 1] || first, monthOf(iso(new Date()))].sort().pop();
  const out = [];
  for (let m = first; m <= last; m = nextMonth(m)) out.push(m);
  return out;
}

/** Actuals for one month against the plan. All money in dollars. */
export function planMonth(model, ym) {
  const plan = model.plan;
  const targets = planTargets(plan);
  const from = ym === monthOf(plan.start) ? plan.start : `${ym}-01`;
  const txns = model.txns.filter((t) => t.month === ym && t.date >= from && !t.netted);
  let income = 0, spent = 0, eating = 0;
  const lineSpend = new Map(plan.lines.map((l) => [l.id, 0]));
  const assigned = new Map();
  for (const l of plan.lines) for (const c of l.categories) if (c !== '*') assigned.set(c, l.id);
  const catchAll = plan.lines.find((l) => l.categories.includes('*'));
  for (const t of txns) {
    if (t.cat.type === 'income' && t.c > 0) income += t.c;
    if (t.cat.type !== 'spend') continue;
    spent -= t.c;
    if (plan.eatingOut.includes(t.cat.id)) eating -= t.c;
    const lid = assigned.get(t.cat.id) || catchAll?.id;
    if (lid) lineSpend.set(lid, lineSpend.get(lid) - t.c);
  }
  const lastDay = txns.length ? txns[txns.length - 1].date : null;
  const covered = model.statements.some((s) => s.end >= `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`);
  return {
    ym, from, hasData: txns.length > 0, complete: covered, lastDay,
    income: fromCents(income), spent: fromCents(spent), saved: fromCents(income - spent), eatingOut: fromCents(eating),
    targets,
    lines: plan.lines.map((l) => ({ ...l, actual: fromCents(lineSpend.get(l.id) || 0) })),
  };
}

// ---------------------------------------------------------------------------
// Insights — short, true sentences written from the data
// ---------------------------------------------------------------------------

export function insights(model, today = iso(new Date())) {
  // Same data, same day: same cards (Overview asks on every render).
  if (model.insightsFor?.today === today) return model.insightsFor.cards;
  const cards = computeInsights(model, today);
  model.insightsFor = { today, cards };
  return cards;
}
function computeInsights(model, today) {
  const out = [];
  const months = model.months;
  if (!months.length) return out;
  const fullMonths = months.filter((ym) => model.statements.some((s) => s.end >= `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}` && s.start <= `${ym}-01`));
  const nFull = Math.max(fullMonths.length, 1);
  const $ = (c) => fromCents(c);

  // 1. Most frequent merchant
  // A habit is somewhere you choose to go, not a bill that comes every month.
  const BILLS = new Set(['housing', 'bills', 'internet', 'fees', 'transfers', 'education', 'government']);
  const freq = topMerchants(model.txns.filter((t) => !BILLS.has(t.category)), 'everyday', 1)[0];
  if (freq && freq.count >= 5) {
    const first = model.txns.find((t) => t.name === freq.name).date;
    const span = Math.max(1, daysBetween(first, model.txns[model.txns.length - 1].date));
    out.push({ id: 'habit', merchant: freq.name, icon: freq.cat.icon, color: freq.cat.color, kicker: 'Most visited', title: `${freq.name} ×${freq.count}`, value: $(freq.cents),
      text: `About once every ${Math.max(1, Math.round(span / freq.count))} days, averaging ${fmt$(freq.cents / freq.count)}. That’s ${fmt$(freq.cents / nFull, 0)} a month.` });
  }

  // 2. Everyday average vs plan
  const everyday = fullMonths.map((ym) => spendByCategory(monthTxns(model, ym), 'everyday').reduce((s, r) => s + r.cents, 0));
  if (everyday.length) {
    const avg = everyday.reduce((a, b) => a + b, 0) / everyday.length;
    const plan = model.plan ? planTargets(model.plan) : null;
    out.push({ id: 'everyday', icon: 'cart', color: 'blue', kicker: 'Everyday spending', title: `${fmt$(avg, 0)} a month`, value: $(avg),
      text: plan ? (avg <= plan.spend * 100
        ? `${fmt$(plan.spend * 100 - avg, 0)} under the ${fmt$(plan.spend * 100, 0)} you plan to spend each month. Tuition, transfers and one-offs aren’t counted.`
        : `${fmt$(avg - plan.spend * 100, 0)} over the ${fmt$(plan.spend * 100, 0)} monthly plan. Tuition, transfers and one-offs aren’t counted.`)
        : `Average over ${everyday.length} full months, without tuition, transfers and one-offs.` });
  }

  // 3. Biggest month
  const ms = monthlySpend(model, 'everything');
  const big = [...ms].sort((a, b) => b.total - a.total)[0];
  if (big && ms.length > 2 && big.rows.length) {
    const others = ms.filter((m) => m !== big);
    const avgOther = others.reduce((s, m) => s + m.total, 0) / others.length;
    if (big.total > avgOther * 1.6) {
      const top = big.rows[0];
      out.push({ id: 'bigmonth', ym: big.ym, icon: top.cat.icon, color: top.cat.color, kicker: 'Biggest month', title: `${monthLabel(big.ym, 'month')}: ${fmt$(big.total, 0)} out`, value: $(big.total),
        text: `${top.cat.name} was ${Math.round(top.cents / big.total * 100)}% of it. A typical month is closer to ${fmt$(avgOther, 0)}.` });
    }
  }

  // 4. Balance trend since the low point
  const daily = dailyBalance(model);
  if (daily.length > 30 && !daily.relative) { // no "balance" story when the files had no balances
    const last = daily[daily.length - 1];
    let low = daily[0];
    for (const d of daily) if (d.bal < low.bal) low = d;
    let high = daily[0];
    for (const d of daily) if (d.bal > high.bal) high = d;
    if (low.date !== last.date && last.bal > low.bal) {
      out.push({ id: 'trend', icon: 'trendUp', color: 'green', kicker: 'Balance', title: `Up ${fmt$(last.bal - low.bal, 0)}`, value: $(last.bal - low.bal),
        text: `Since your low of ${fmt$(low.bal, 0)} on ${shortDate(low.date)}. Your high was ${fmt$(high.bal, 0)} on ${shortDate(high.date)}.` });
    } else if (high.date !== last.date) {
      out.push({ id: 'trend', icon: 'trendDown', color: 'red', kicker: 'Balance', title: `Down ${fmt$(high.bal - last.bal, 0)}`, value: $(high.bal - last.bal),
        text: `From your high of ${fmt$(high.bal, 0)} on ${shortDate(high.date)}.` });
    }
  }

  // 5. Latest month vs average, for the category that moved most
  const latest = fullMonths[fullMonths.length - 1];
  if (latest && fullMonths.length >= 3) {
    const prev = fullMonths.slice(0, -1);
    const cur = new Map(spendByCategory(monthTxns(model, latest), 'everyday').map((r) => [r.cat.id, r]));
    // Each earlier month's totals once, not once per category.
    const prevTotals = prev.map((ym) => new Map(spendByCategory(monthTxns(model, ym), 'everyday').map((x) => [x.cat.id, x.cents])));
    let best = null;
    for (const [id, r] of cur) {
      const avg = prevTotals.reduce((s, m) => s + (m.get(id) || 0), 0) / prev.length;
      const delta = r.cents - avg;
      if (avg > 2000 && (!best || Math.abs(delta) > Math.abs(best.delta))) best = { r, avg, delta };
    }
    if (best && Math.abs(best.delta) > 2500) {
      const up = best.delta > 0;
      out.push({ id: 'mover', catId: best.r.cat.id, ym: latest, icon: best.r.cat.icon, color: best.r.cat.color, kicker: `${monthLabel(latest, 'month')} · ${best.r.cat.name}`, title: `${fmt$(best.r.cents, 0)}, ${up ? 'up' : 'down'} ${Math.round(Math.abs(best.delta) / best.avg * 100)}%`, value: $(best.r.cents),
        text: `Your average before that was ${fmt$(best.avg, 0)} a month.` });
    }
  }

  // 6. Plan countdown / status
  if (model.plan?.start) {
    const t = planTargets(model.plan);
    const days = daysBetween(today, model.plan.start);
    if (days > 0) {
      out.push({ id: 'plan', icon: 'rings', color: 'green', kicker: model.plan.employer ? `${model.plan.employer} starts` : 'Plan starts', title: days === 1 ? 'Tomorrow' : `In ${days} days`, value: days,
        text: `From ${shortDate(model.plan.start)}, ${fmt$(t.save * 100, 0)} goes to savings each month and ${fmt$(t.spend * 100, 0)} is yours to spend.` });
    }
  }

  // 7. Eating out vs the plan's eating-out budget
  if (model.plan && fullMonths.length) {
    const ids = model.plan.eatingOut;
    const avg = fullMonths.reduce((s, ym) => s + monthTxns(model, ym).filter((x) => !x.netted && ids.includes(x.cat.id)).reduce((a, x) => a - x.c, 0), 0) / fullMonths.length;
    const budget = planTargets(model.plan).eatingOut * 100;
    if (budget > 0) {
      out.push({ id: 'eating', icon: 'fork', color: 'orange', kicker: 'Eating out', title: `${fmt$(avg, 0)} a month`, value: $(avg),
        text: avg <= budget ? `Inside the ${fmt$(budget, 0)} eating-out budget, with ${fmt$(budget - avg, 0)} to spare.` : `${fmt$(avg - budget, 0)} above the ${fmt$(budget, 0)} eating-out budget.` });
    }
  }
  return out;
}

/** In the account's currency (format.js knows which). */
function fmt$(cents, digits = 2) { return money(cents / 100, { cents: digits > 0 }); }
function shortDate(d) { const x = parseISO(d); return x.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); }
