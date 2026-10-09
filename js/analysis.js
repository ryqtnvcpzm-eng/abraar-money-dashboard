// Deeper reading of the ledger: what repeats, what's unusual, where the month is heading.
// Pure functions over the model (no DOM), each worked out once per model and shared by the
// Overview cards and the detail pages behind them. All money in cents.
import { addDays, daysBetween, daysInMonth, monthOf, parseISO, iso } from './format.js';

const DAY = 864e5;
// Whole days since 1970 for an ISO date, cached: comparing dates by the thousand stays cheap.
const dayCache = new Map();
const dayNum = (d) => {
  let n = dayCache.get(d);
  if (n === undefined) { n = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY; if (dayCache.size > 20000) dayCache.clear(); dayCache.set(d, n); }
  return n;
};
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const memo = (model, key, fn) => { model.memo ||= {}; if (!(key in model.memo)) model.memo[key] = fn(); return model.memo[key]; };

/** Calendar months a statement covers from the 1st to the last day. */
export function fullMonths(model) {
  return memo(model, 'full', () => model.months.filter((ym) => model.statements.some((s) => s.start <= `${ym}-01` && s.end >= `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`)));
}
/** The last day there is data for (the end of the latest statement). */
export function dataEnd(model) {
  return memo(model, 'end', () => {
    const t = model.txns.length ? model.txns[model.txns.length - 1].date : null;
    const s = model.statements.length ? model.statements[model.statements.length - 1].end : null;
    return [t, s].filter(Boolean).sort().pop() || null;
  });
}
const spent = (t) => !t.netted && t.c < 0 && t.cat.type === 'spend';
// Charges that come with the place you live: never a "habit", never "small stuff".
export const BILLS = new Set(['housing', 'bills', 'internet', 'fees', 'transfers', 'education', 'government']);

// ---------------------------------------------------------------------------
// Recurring charges: subscriptions, bills, rent
// ---------------------------------------------------------------------------
const CADENCES = [
  { id: 'weekly', label: 'Weekly', days: 7, lo: 6, hi: 8 },
  { id: 'biweekly', label: 'Every 2 weeks', days: 14, lo: 12, hi: 16 },
  { id: 'monthly', label: 'Monthly', days: 30.44, lo: 26, hi: 35 },
  { id: 'quarterly', label: 'Every 3 months', days: 91.3, lo: 82, hi: 100 },
  { id: 'yearly', label: 'Yearly', days: 365.25, lo: 340, hi: 390 },
];
// Bills whose amount moves with use (hydro, phone overage) still repeat on schedule.
const VARIABLE = new Set(['bills', 'internet', 'housing', 'fees', 'education']);
// Kinds of spending that are subscriptions, as opposed to bills.
const SUBSCRIPTION = new Set(['entertainment', 'fitness', 'electronics']);
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * tol);

function cadenceOf(dates) {
  if (dates.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push(dayNum(dates[i]) - dayNum(dates[i - 1]));
  const g = median(gaps);
  const cad = CADENCES.find((c) => g >= c.lo && g <= c.hi);
  if (!cad) return null;
  // Most gaps on schedule; a skipped cycle (a gap of two periods) is fine.
  const ok = gaps.filter((x) => (x >= cad.lo && x <= cad.hi) || (x >= cad.lo * 2 && x <= cad.hi * 2)).length;
  if (ok / gaps.length < 0.75) return null;
  const need = cad.id === 'yearly' ? 2 : cad.id === 'quarterly' ? 3 : 3;
  if (dates.length < need) return null;
  return { ...cad, gap: g };
}

function nextAfter(last, cad) {
  if (cad.id === 'monthly' || cad.id === 'quarterly' || cad.id === 'yearly') {
    const n = cad.id === 'monthly' ? 1 : cad.id === 'quarterly' ? 3 : 12;
    const d = parseISO(last);
    const day = d.getDate();
    const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
    t.setDate(Math.min(day, new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
    return iso(t);
  }
  return addDays(last, cad.days);
}

/** One charge per day per place (two coffees on one day are one visit for this purpose). */
function byDay(list) {
  const m = new Map();
  for (const t of list) { const e = m.get(t.date); if (e) { e.c += t.c; e.txns.push(t); } else m.set(t.date, { date: t.date, c: t.c, txns: [t] }); }
  return [...m.values()];
}

function describe(name, charges, cad, end) {
  const amounts = charges.map((x) => -x.c);
  const last = charges[charges.length - 1];
  const amount = amounts[amounts.length - 1];
  // A price change: the latest amount differs from a stable run before it, and has held since.
  let change = null;
  for (let i = charges.length - 1; i > 0; i--) {
    const before = amounts.slice(Math.max(0, i - 3), i);
    if (!near(amounts[i], amounts[i - 1]) && before.every((a) => near(a, before[before.length - 1])) && amounts.slice(i).every((a) => near(a, amount))) {
      // A bill that moves with use needs the new amount twice before it's a new price, not one big month.
      const held = charges.length - i >= (VARIABLE.has(charges[i].txns[0].cat.id) ? 2 : 1);
      if (held && (before.length >= 2 || i >= 2)) change = { from: amounts[i - 1], to: amounts[i], date: charges[i].date, pct: (amounts[i] - amounts[i - 1]) / amounts[i - 1] };
      break;
    }
  }
  const t0 = last.txns[last.txns.length - 1];
  const typical = median(amounts.slice(-6));
  const active = daysBetween(last.date, end) <= cad.hi * 1.5 + 3;
  return {
    name, cat: t0.cat, cadence: cad, amount, typical, count: charges.length,
    first: charges[0].date, last: last.date, next: nextAfter(last.date, cad), active,
    monthly: Math.round((typical * 30.44) / cad.days),
    ids: charges.map((x) => x.txns[x.txns.length - 1].id),
    change, kind: SUBSCRIPTION.has(t0.cat.id) ? 'subscription' : VARIABLE.has(t0.cat.id) || t0.cat.id === 'transport' ? 'bill' : 'other',
  };
}

/** Everything that repeats on a schedule: [{ name, cat, cadence, amount, monthly, next, active, change, kind, ids }]. */
export function recurring(model) {
  return memo(model, 'recurring', () => {
    const end = dataEnd(model);
    if (!end) return [];
    const byName = new Map();
    for (const t of model.txns) {
      if (!spent(t) || t.partOf || t.cat.id === 'cash') continue;
      if (!byName.has(t.name)) byName.set(t.name, []);
      byName.get(t.name).push(t);
    }
    const out = [];
    for (const [name, list] of byName) {
      if (list.length < 2) continue;
      const days = byDay(list);
      // 1. The place as a whole charges on a schedule (a bill whose amount can move, or a subscription
      //    whose price changed at some point).
      // Money sent to people only counts as regular when it's the same amount each time (rent by e-transfer).
      const cad = list[0].cat.id === 'transfers' ? null : cadenceOf(days.map((d) => d.date));
      if (cad) {
        const amounts = days.map((d) => -d.c);
        let steady = 0;
        for (let i = 1; i < amounts.length; i++) if (near(amounts[i], amounts[i - 1])) steady++;
        const exact = steady / Math.max(1, amounts.length - 1) >= 0.6;
        const mean = sum(amounts) / amounts.length;
        const cv = Math.sqrt(sum(amounts.map((a) => (a - mean) ** 2)) / amounts.length) / (mean || 1);
        if (exact || (VARIABLE.has(list[0].cat.id) && cv < 0.35)) { out.push(describe(name, days, cad, end)); continue; }
      }
      // 2. Several plans at one place ("Apple Services": storage and music): group by amount first.
      const groups = [];
      for (const d of days) {
        const g = groups.find((x) => near(-d.c, x.amount));
        if (g) g.days.push(d); else groups.push({ amount: -d.c, days: [d] });
      }
      for (const g of groups) {
        if (g.days.length < 2) continue;
        const c2 = cadenceOf(g.days.map((d) => d.date));
        // A regular coffee at the same price isn't a subscription; only monthly or slower counts here.
        if (c2 && c2.days >= 28) out.push(describe(name, g.days, c2, end));
      }
    }
    return out.sort((a, b) => b.monthly - a.monthly);
  });
}

/** Regular charges due in the next two weeks, when the data is recent enough to say. */
export function upcoming(model, today, days = 14) {
  const end = dataEnd(model);
  if (!end || daysBetween(end, today) > 40 || daysBetween(end, today) < -1) return [];
  const out = [];
  for (const r of recurring(model)) {
    if (!r.active) continue;
    let next = r.next;
    for (let k = 0; k < 4 && next < today; k++) next = nextAfter(next, r.cadence);
    const inDays = daysBetween(today, next);
    if (inDays >= 0 && inDays <= days) out.push({ ...r, due: next, inDays });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || b.amount - a.amount);
}

// ---------------------------------------------------------------------------
// This month so far
// ---------------------------------------------------------------------------
/** Where the latest (unfinished) month is heading, against the same point in earlier months. */
export function pace(model, today = iso(new Date())) {
  return memo(model, `pace|${today}`, () => {
    const end = dataEnd(model);
    if (!end) return null;
    const ym = monthOf(end);
    // Only while that month is still going: a statement that stopped mid-October says nothing in December.
    if (monthOf(today) !== ym) return null;
    const full = fullMonths(model).filter((m) => m < ym).slice(-6);
    const day = Number(end.slice(8, 10));
    if (full.includes(ym) || full.length < 2 || day < 5 || day >= daysInMonth(ym)) return null;
    const everyday = (t) => spent(t) && t.cat.everyday && !t.oneOff;
    const upTo = new Map();
    const totals = new Map();
    for (const t of model.txns) {
      if (!everyday(t) && !(t.c > 0 && t.cat.type === 'spend' && t.cat.everyday && !t.netted)) continue;
      const m = t.month;
      if (m !== ym && !full.includes(m)) continue;
      // Refunds count against their month, as they do in Spending.
      totals.set(m, (totals.get(m) || 0) - t.c);
      if (Number(t.date.slice(8, 10)) <= day) upTo.set(m, (upTo.get(m) || 0) - t.c);
    }
    const soFar = upTo.get(ym) || 0;
    const usualSoFar = sum(full.map((m) => upTo.get(m) || 0)) / full.length;
    const usualTotal = sum(full.map((m) => totals.get(m) || 0)) / full.length;
    // The rest of a typical month, added to what's already gone.
    const projected = Math.round(soFar + Math.max(0, usualTotal - usualSoFar));
    const series = [...full, ym].map((m) => ({ ym: m, soFar: upTo.get(m) || 0, total: totals.get(m) || 0 }));
    return { ym, day, days: daysInMonth(ym), soFar, usualSoFar, usualTotal, projected, delta: soFar - usualSoFar, months: full.length, series };
  });
}

// ---------------------------------------------------------------------------
// Things worth a second look
// ---------------------------------------------------------------------------
/** Charges far above what you usually pay at that place, or the biggest ever in their category. Latest 90 days. */
export function unusual(model) {
  return memo(model, 'unusual', () => {
    const end = dataEnd(model);
    if (!end) return [];
    const from = addDays(end, -90);
    const byName = new Map();
    const byCat = new Map();
    for (const t of model.txns) {
      if (!spent(t) || t.oneOff) continue;
      if (!byName.has(t.name)) byName.set(t.name, []);
      byName.get(t.name).push(-t.c);
      if (!byCat.has(t.cat.id)) byCat.set(t.cat.id, []);
      byCat.get(t.cat.id).push(-t.c);
    }
    const out = [];
    const usualAt = new Map();
    for (const t of model.txns) {
      if (t.date < from || !spent(t) || t.oneOff || BILLS.has(t.cat.id) || t.cat.id === 'cash' || !t.cat.everyday) continue;
      const amt = -t.c;
      const here = byName.get(t.name);
      if (here.length >= 4) {
        if (!usualAt.has(t.name)) usualAt.set(t.name, median(here));
        const usual = usualAt.get(t.name);
        if (amt >= usual * 2.5 && amt - usual >= 4000) out.push({ t, kind: 'merchant', usual, times: amt / usual, score: Math.log(amt / usual) * Math.log10(amt) });
        continue;
      }
      // First time somewhere: unusual only when it's among the biggest in its category.
      const inCat = byCat.get(t.cat.id);
      if (inCat.length >= 8 && amt >= 10000) {
        const bigger = inCat.filter((a) => a > amt).length;
        const usual = median(inCat);
        if (bigger === 0 && amt >= usual * 4) out.push({ t, kind: 'category', usual, times: amt / usual, score: Math.log(amt / usual) * Math.log10(amt) * 0.8 });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  });
}

/** The same amount at the same place twice within a day: maybe a double charge. Latest 60 days. */
export function duplicates(model, dismissed = []) {
  return memo(model, `dup|${dismissed.length}`, () => {
    const end = dataEnd(model);
    if (!end) return [];
    const from = addDays(end, -60);
    const skip = new Set(dismissed);
    // Same place and amount, in date order.
    const groups = new Map();
    for (const t of model.txns) {
      if (!spent(t) || t.partOf || t.cat.id === 'cash' || t.cat.id === 'transfers') continue;
      const k = `${t.name}\u0001${t.c}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const pairs = [];
    const repeats = new Map();
    for (const list of groups.values()) {
      for (let i = 1; i < list.length; i++) {
        if (dayNum(list[i].date) - dayNum(list[i - 1].date) > 1) continue;
        repeats.set(list[i].name, (repeats.get(list[i].name) || 0) + 1);
        pairs.push([list[i - 1], list[i]]);
      }
    }
    // Places where the same amount twice in a day is normal (transit fares, a coffee for a friend) are left out.
    const out = [];
    for (const [a, b] of pairs) {
      if (b.date < from || b.c > -2000 || repeats.get(a.name) > 1) continue;
      const key = `${a.id}|${b.id}`;
      if (!skip.has(key)) out.push({ a, b, key, cents: -b.c });
    }
    return out.sort((x, y) => (x.b.date < y.b.date ? 1 : -1));
  });
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------
const FUN = (t) => spent(t) && t.cat.everyday && !t.oneOff && !BILLS.has(t.cat.id) && t.cat.id !== 'cash';

/** Spending per day on Saturdays and Sundays vs other days, plus each weekday. */
export function weekdays(model) {
  return memo(model, 'weekdays', () => {
    const full = fullMonths(model);
    if (full.length < 2) return null;
    const inFull = new Set(full);
    const perDow = [0, 0, 0, 0, 0, 0, 0];
    const daysDow = [0, 0, 0, 0, 0, 0, 0];
    const catWeekend = new Map();
    for (const ym of full) {
      const [y, m] = ym.split('-').map(Number);
      for (let d = 1; d <= daysInMonth(ym); d++) daysDow[new Date(y, m - 1, d).getDay()]++;
    }
    for (const t of model.txns) {
      if (!inFull.has(t.month) || !FUN(t)) continue;
      const dow = (dayNum(t.date) + 4) % 7; // 1 Jan 1970 was a Thursday
      perDow[dow] -= t.c;
      if (dow !== 0 && dow !== 6) continue;
      const e = catWeekend.get(t.cat.id) || { cat: t.cat, cents: 0 };
      e.cents -= t.c;
      catWeekend.set(t.cat.id, e);
    }
    const avg = perDow.map((c, i) => (daysDow[i] ? c / daysDow[i] : 0));
    const weekend = (perDow[0] + perDow[6]) / Math.max(1, daysDow[0] + daysDow[6]);
    const weekday = sum(perDow.slice(1, 6)) / Math.max(1, sum(daysDow.slice(1, 6)));
    const top = [...catWeekend.values()].sort((a, b) => b.cents - a.cents)[0] || null;
    return { avg, weekend, weekday, ratio: weekday ? weekend / weekday : 0, top, months: full.length };
  });
}

/** Purchases under a small amount, which add up without feeling like much. */
export function smallBuys(model, limit = 1500) {
  return memo(model, `small|${limit}`, () => {
    const full = fullMonths(model);
    if (full.length < 2) return null;
    const inFull = new Set(full);
    let cents = 0, count = 0, everyday = 0;
    const cats = new Map();
    const places = new Map();
    for (const t of model.txns) {
      if (!inFull.has(t.month) || !spent(t) || !t.cat.everyday || t.oneOff) continue;
      everyday -= t.c;
      if (!FUN(t) || -t.c >= limit) continue;
      cents -= t.c; count++;
      const e = cats.get(t.cat.id) || { cat: t.cat, cents: 0, count: 0 };
      e.cents -= t.c; e.count++; cats.set(t.cat.id, e);
      const p = places.get(t.name) || { name: t.name, cat: t.cat, cents: 0, count: 0 };
      p.cents -= t.c; p.count++; places.set(t.name, p);
    }
    const n = full.length;
    return {
      limit, months: n, perMonth: cents / n, countPerMonth: count / n, share: everyday ? cents / everyday : 0,
      cats: [...cats.values()].sort((a, b) => b.cents - a.cents), places: [...places.values()].sort((a, b) => b.cents - a.cents),
    };
  });
}

/** Money in vs money out per full month (moves between your own accounts left out). */
export function cashflow(model) {
  return memo(model, 'cashflow', () => {
    const full = fullMonths(model);
    if (full.length < 2) return null;
    const by = new Map(full.map((m) => [m, { ym: m, inn: 0, out: 0 }]));
    for (const t of model.txns) {
      const e = by.get(t.month);
      if (!e || t.netted || t.cat.id === 'own' || t.cat.type === 'transfer') continue;
      if (t.c > 0) e.inn += t.c; else e.out -= t.c;
    }
    const months = [...by.values()].map((e) => ({ ...e, net: e.inn - e.out }));
    const inn = sum(months.map((e) => e.inn));
    const out = sum(months.map((e) => e.out));
    return { months, inn: inn / months.length, out: out / months.length, net: (inn - out) / months.length, rate: inn ? (inn - out) / inn : null, positive: months.filter((e) => e.net > 0).length };
  });
}

/** Bank fees (net of any refunded) over the latest twelve months of data. */
export function fees(model) {
  return memo(model, 'fees', () => {
    const end = dataEnd(model);
    if (!end) return null;
    const from = addDays(end, -365);
    const names = new Map();
    let cents = 0;
    const perMonth = new Map();
    for (const t of model.txns) {
      if (t.netted || t.cat.id !== 'fees' || t.date <= from) continue;
      cents -= t.c;
      perMonth.set(t.month, (perMonth.get(t.month) || 0) - t.c);
      const e = names.get(t.name) || { name: t.name, cat: t.cat, cents: 0, count: 0 };
      e.cents -= t.c; if (t.c < 0) e.count++;
      names.set(t.name, e);
    }
    const span = Math.min(365, daysBetween(model.txns[0]?.date || end, end) + 1);
    return { cents, span, perMonth, names: [...names.values()].filter((e) => e.cents > 0).sort((a, b) => b.cents - a.cents) };
  });
}

// ---------------------------------------------------------------------------
// Amazon (and stores like it): what the money actually bought
// ---------------------------------------------------------------------------
export const AMAZON_RE = /^(amazon|amzn|kindle|audible|aws\b|whole foods)/i;

export function amazon(model) {
  return memo(model, 'amazon', () => {
    const list = model.txns.filter((t) => AMAZON_RE.test(t.name) && !t.netted && t.cat.type === 'spend');
    const charges = list.filter((t) => t.c < 0);
    if (charges.length < 3) return null;
    const cats = new Map();
    let cents = 0;
    for (const t of list) {
      cents -= t.c;
      const e = cats.get(t.cat.id) || { cat: t.cat, cents: 0, count: 0 };
      e.cents -= t.c; if (t.c < 0) e.count++;
      cats.set(t.cat.id, e);
    }
    const orders = new Set(charges.map((t) => t.partOf || t.id));
    const sorted = new Set(charges.filter((t) => t.note?.length || t.partOf).map((t) => t.partOf || t.id));
    // Plain "Amazon" charges with nothing to say what they were.
    const unsorted = charges.filter((t) => t.name === 'Amazon' && !t.partOf && !t.note?.length && !t.locked);
    const months = model.months.length;
    const items = [];
    for (const t of model.txns) if (t.note?.length && AMAZON_RE.test(t.name) && !t.netted) for (const title of t.note) items.push({ title, t });
    return {
      cents, perMonth: cents / Math.max(1, months), months, orders: orders.size, sorted: sorted.size, unsorted,
      cats: [...cats.values()].filter((e) => e.cents > 0).sort((a, b) => b.cents - a.cents), items,
      byMonth: model.months.map((ym) => ({ ym, v: -sum(list.filter((t) => t.month === ym).map((t) => t.c)) })),
    };
  });
}

export const _test = { cadenceOf, nextAfter, DAY };
