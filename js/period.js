// Periods for the Spending tab (Apple Card style): a week, a month or a year, split into bars
// (days, days, months), each bar stacked by category. Pure functions over the model.
import { addDays, daysInMonth, monthOf, parseISO, iso, monthLabel, dateLabel, MONTHS } from './format.js';
import { filterMode } from './ledger.js';

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** The week (Sunday to Saturday), month or year that contains `date`. */
export function periodFor(kind, date) {
  if (kind === 'week') {
    const from = addDays(date, -parseISO(date).getDay());
    return { kind, from, to: addDays(from, 6), key: from };
  }
  if (kind === 'year') { const y = date.slice(0, 4); return { kind, from: `${y}-01-01`, to: `${y}-12-31`, key: y }; }
  const ym = monthOf(date);
  return { kind: 'month', from: `${ym}-01`, to: `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`, key: ym };
}

/** The period n steps before (−) or after (+) this one. */
export function shiftPeriod(p, n) {
  if (p.kind === 'week') return periodFor('week', addDays(p.from, 7 * n));
  if (p.kind === 'year') return periodFor('year', `${Number(p.key) + n}-01-01`);
  const d = parseISO(p.from);
  return periodFor('month', iso(new Date(d.getFullYear(), d.getMonth() + n, 1)));
}

/** "This Month", "Last Week", "October 2026", "Oct 4 – 10"… today: ISO date. */
export function periodLabel(p, today) {
  const cur = periodFor(p.kind, today);
  const prev = shiftPeriod(cur, -1);
  const noun = { week: 'Week', month: 'Month', year: 'Year' }[p.kind];
  if (p.key === cur.key) return `This ${noun}`;
  if (p.key === prev.key) return `Last ${noun}`;
  return periodName(p);
}
export function periodName(p) {
  if (p.kind === 'year') return p.key;
  if (p.kind === 'month') return monthLabel(p.key);
  const a = parseISO(p.from), b = parseISO(p.to);
  return a.getMonth() === b.getMonth() ? `${MONTHS[a.getMonth()]} ${a.getDate()} – ${b.getDate()}` : `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}`;
}

/** Spending per day and category (cents, positive = spent), worked out once per model and mode. */
function daily(model, mode) {
  model.memo ||= {};
  const key = `daily|${mode}`;
  if (model.memo[key]) return model.memo[key];
  const f = filterMode(mode);
  const days = new Map(); // date -> Map(catId -> cents)
  for (const t of model.txns) {
    if (t.netted || !f(t)) continue;
    let d = days.get(t.date);
    if (!d) days.set(t.date, (d = new Map()));
    d.set(t.cat.id, (d.get(t.cat.id) || 0) - t.c);
  }
  model.memo[key] = days;
  return days;
}

function sumDays(model, mode, from, to) {
  const out = new Map();
  for (const [date, cats] of daily(model, mode)) {
    if (date < from || date > to) continue;
    for (const [id, c] of cats) out.set(id, (out.get(id) || 0) + c);
  }
  return out;
}
const rowsOf = (model, map) => [...map].filter(([, c]) => c > 0).map(([id, cents]) => ({ cat: model.cats.get(id), cents })).filter((r) => r.cat).sort((a, b) => b.cents - a.cents);

/** Bars for a period: [{ key, from, to, label, title, total, rows: [{cat, cents}] }]. */
export function buckets(model, p, mode) {
  const out = [];
  const add = (key, from, to, label, title) => {
    const rows = rowsOf(model, sumDays(model, mode, from, to));
    out.push({ key, from, to, label, title, total: rows.reduce((s, r) => s + r.cents, 0), rows });
  };
  if (p.kind === 'year') {
    for (let m = 1; m <= 12; m++) {
      const ym = `${p.key}-${String(m).padStart(2, '0')}`;
      add(ym, `${ym}-01`, `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`, MONTHS[m - 1].slice(0, 1), monthLabel(ym));
    }
  } else {
    for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
      const day = parseISO(d);
      add(d, d, d, p.kind === 'week' ? DOW[day.getDay()] : String(day.getDate()), dateLabel(d, 'day'));
    }
  }
  return out;
}

/** Totals for a date range: { total, rows } (refunds reduce their category, like the rest of Money). */
export function rangeSpend(model, from, to, mode) {
  const rows = rowsOf(model, sumDays(model, mode, from, to));
  return { total: rows.reduce((s, r) => s + r.cents, 0), rows };
}

/** Places, most spent first, in a date range. */
export function rangeMerchants(model, from, to, mode, limit = 8) {
  const f = filterMode(mode);
  const map = new Map();
  const seen = new Set();
  for (const t of model.txns) {
    if (t.netted || !f(t) || t.date < from || t.date > to) continue;
    const e = map.get(t.name) || { name: t.name, cat: t.cat, cents: 0, count: 0 };
    e.cents -= t.c;
    if (t.c < 0 && !(t.partOf && seen.has(t.partOf))) { e.count++; if (t.partOf) seen.add(t.partOf); }
    map.set(t.name, e);
  }
  return [...map.values()].filter((e) => e.cents > 0).sort((a, b) => b.cents - a.cents).slice(0, limit);
}

/** Periods there's data for, oldest first, as [first, last] dates. */
export function dataSpan(model) {
  if (!model.txns.length) return null;
  return [model.txns[0].date, model.txns[model.txns.length - 1].date];
}

/** Money out per day (cents), for the Activity calendar. */
export function dayTotals(model, mode = 'everything') {
  const out = new Map();
  for (const [date, cats] of daily(model, mode)) {
    let sum = 0;
    for (const c of cats.values()) sum += c;
    if (sum > 0) out.set(date, sum);
  }
  return out;
}
