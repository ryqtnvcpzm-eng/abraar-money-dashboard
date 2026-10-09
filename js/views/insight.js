// Insight detail: tapping an Overview insight opens the story behind it —
// a chart with the month in question highlighted, three key numbers, and the data to drill into.
import { app } from '../state.js';
import { money, monthLabel, dateLabel, esc, fromCents, plural, daysInMonth } from '../format.js';
import { monthlySpend, spendByCategory, monthTxns, topMerchants, dailyBalance, planTargets, currentBalance } from '../ledger.js';
import { recurring, upcoming, pace as paceOf, unusual as unusualOf, weekdays, smallBuys, cashflow, fees as feesOf, amazon as amazonOf, dataEnd, AMAZON_RE } from '../analysis.js';
import { icon, catIcon, openSheet, haptic, toast, closeAllSheets } from '../ui.js';
import { columnChart, balanceChart } from '../charts.js';
import { txnRow, openTxn, openCategory } from './sheets.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const $ = (c) => fromCents(c);
const m0 = (dollars) => money(dollars, { cents: false });

export function openInsight(card) {
  if (card.id === 'plan') { closeAllSheets(); app.selectTab('plan'); return; }
  const builders = { habit, everyday, bigmonth, trend, mover, eating, pace, recurring: repeats, pricehike, upcoming: comingUp, unusual, duplicate, weekend, small, savings, runway, fees, amazon: amazonPage };
  const build = builders[card.id];
  if (!build) return;
  const sheet = openSheet({ title: card.kicker, size: 'full', body: '' });
  const charts = [];
  const actions = new Map();
  const ctx = {
    chart(id, fn) { charts.push([id, fn]); return `<div class="chart-wrap ins-chart" id="${id}"></div>`; },
    action(id, fn) { actions.set(id, fn); return id; },
  };
  sheet.setBody(`
    <div class="ins-hero">
      <div class="kicker" style="--c:var(--${esc(card.color)})">${icon(card.icon)}${esc(card.kicker)}</div>
      <h1>${esc(card.title)}</h1>
      <p>${esc(card.text)}</p>
    </div>
    ${build(card, ctx)}`);
  // Draw charts now, before the sheet starts sliding in (it's already in the page, so it has its width);
  // their own animations wait until it has settled.
  charts.forEach(([id, fn]) => { const el = sheet.el.querySelector(`#${id}`); if (el) fn(el); });
  sheet.el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-txn]');
    if (t) { haptic(); openTxn(t.dataset.txn); return; }
    const c = e.target.closest('[data-cat]');
    if (c) { haptic(); openCategory(c.dataset.cat, { ym: c.dataset.ym || 'all', mode: c.dataset.mode || 'everything' }); return; }
    const a = e.target.closest('[data-action]');
    if (a && actions.has(a.dataset.action)) { haptic(); actions.get(a.dataset.action)(sheet, a); return; }
    const mer = e.target.closest('[data-merchant]');
    if (mer) { haptic(); openCategory(null, { ym: 'all', mode: 'everything', merchant: mer.dataset.merchant }); return; }
  });
}

// ---------- shared pieces ----------
const stats = (items) => `<div class="stat-grid">${items.map(([k, v, sub = '']) => `
  <div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`).join('')}</div>`;
const chartCard = (title, chart, caption = '') => `<div class="card ins-card"><div class="card-title">${esc(title)}</div>${chart}${caption ? `<p class="note" style="margin:10px 0 0">${esc(caption)}</p>` : ''}</div>`;
const button = (id, label) => `<div class="btn-row"><button class="btn secondary" data-action="${id}">${esc(label)}</button></div>`;
const monthBars = (values) => values.map(({ ym, v }) => ({ key: ym, label: monthLabel(ym, 'short'), title: monthLabel(ym), v }));
const fullMonths = () => app.model.months.filter((ym) => app.model.statements.some((s) => s.start <= `${ym}-01` && s.end >= `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`));
const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const catRows = (rows, { per = 1, ym = 'all', mode = 'everything', merchant = null } = {}) => {
  const total = rows.reduce((s, r) => s + r.cents, 0) || 1;
  return `<div class="list">${rows.map((r) => `
    <button class="row with-icon tap" ${merchant ? `data-merchant="${esc(merchant)}"` : `data-cat="${esc(r.cat.id)}" data-ym="${ym}" data-mode="${mode}"`}>
      ${catIcon(r.cat)}
      <span class="main"><span class="title">${esc(r.cat.name)}</span><span class="subtitle">${Math.round((r.cents / total) * 100)}%</span>
        <span class="pctbar"><i style="--c:var(--${r.cat.color});width:${Math.max(2, (r.cents / rows[0].cents) * 100)}%"></i></span></span>
      <span class="value">${money($(r.cents / per))}</span>${icon('chev-r', 'chev')}
    </button>`).join('')}</div>`;
};

// ---------- Most visited merchant ----------
function habit(card, ctx) {
  const m = app.model;
  const visits = m.txns.filter((t) => t.name === card.merchant && !t.netted && t.c < 0);
  const cat = visits[0]?.cat || m.cats.get('other');
  const perMonth = m.months.map((ym) => {
    const list = visits.filter((t) => t.month === ym);
    return { ym, v: list.length, spend: -list.reduce((s, t) => s + t.c, 0) };
  });
  const total = -visits.reduce((s, t) => s + t.c, 0);
  const latest = [...perMonth].reverse().find((p) => p.v > 0)?.ym;
  const byDay = WEEKDAYS.map(() => 0);
  for (const t of visits) byDay[new Date(`${t.date}T12:00:00`).getDay()]++;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const topDay = byDay.indexOf(Math.max(...byDay));
  const avgVisits = avgOf(perMonth.map((p) => p.v));
  return `
    ${chartCard('Visits per month', ctx.chart('ic-visits', (el) => columnChart(el, monthBars(perMonth), {
      color: cat.color, highlight: latest, ref: { v: avgVisits, label: 'Average' }, format: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
      readout: (v) => plural(Math.round(v), 'visit'), refFormat: (v) => `${v.toFixed(1)} a month`,
    })))}
    ${stats([['Visits', String(visits.length), `${plural(m.months.length, 'month')}`], ['Spent', m0($(total)), 'in total'], ['Per visit', money($(total / Math.max(1, visits.length))), 'on average']])}
    ${chartCard('When you go', ctx.chart('ic-days', (el) => columnChart(el, order.map((d) => ({ key: d, label: WEEKDAYS[d], title: WEEKDAYS_LONG[d], v: byDay[d] })), {
      color: cat.color, highlight: topDay, format: (v) => String(Math.round(v)), readout: (v) => plural(Math.round(v), 'visit'), height: 150,
    })), `Most often on ${WEEKDAYS_LONG[topDay]}.`)}
    ${chartCard('Spent per month', ctx.chart('ic-spend', (el) => columnChart(el, monthBars(perMonth.map((p) => ({ ym: p.ym, v: $(p.spend) }))), {
      color: cat.color, highlight: latest, ref: { v: $(total) / Math.max(1, m.months.length), label: 'Average' },
    })))}
    <div class="list-head"><span>Recent visits</span></div>
    <div class="list">${visits.slice(-8).reverse().map((t) => txnRow(t, { showDate: true })).join('')}</div>
    ${button(ctx.action('all', (s) => openCategory(null, { ym: 'all', mode: 'everything', merchant: card.merchant })), `Show All ${visits.length} Visits`)}`;
}

// ---------- Everyday spending vs plan ----------
function everyday(card, ctx) {
  const m = app.model;
  const full = fullMonths();
  const series = monthlySpend(m, 'everyday').filter((s) => full.includes(s.ym));
  const vals = series.map((s) => $(s.total));
  const avg = avgOf(vals);
  const plan = m.plan ? planTargets(m.plan) : null;
  const hi = series.reduce((a, b) => (b.total > a.total ? b : a), series[0]);
  const lo = series.reduce((a, b) => (b.total < a.total ? b : a), series[0]);
  const all = spendByCategory(m.txns.filter((t) => full.includes(t.month)), 'everyday');
  return `
    ${chartCard('Everyday spending by month', ctx.chart('ic-ev', (el) => columnChart(el, monthBars(series.map((s) => ({ ym: s.ym, v: $(s.total) }))), {
      color: 'blue', highlight: series[series.length - 1]?.ym, ref: plan ? { v: plan.spend, label: 'Plan' } : { v: avg, label: 'Average' },
    })), plan ? `The line is the ${m0(plan.spend)} you plan to spend each month from ${dateLabel(m.plan.start, 'short')}.` : 'Leaves out tuition, travel, transfers to people and one-offs.')}
    ${stats([['Average', m0(avg), 'per month'], ['Highest', m0($(hi.total)), monthLabel(hi.ym, 'month')], ['Lowest', m0($(lo.total)), monthLabel(lo.ym, 'month')]])}
    <div class="list-head"><span>An average month</span></div>
    ${catRows(all, { per: Math.max(1, full.length), mode: 'everyday' })}
    ${button(ctx.action('open', (s) => { s.close(); app.ui.mode = 'everyday'; app.ui.month = 'all'; app.stale.add('spending'); app.selectTab('spending'); }), 'Open in Spending')}`;
}

// ---------- Biggest month ----------
function bigmonth(card, ctx) {
  const m = app.model;
  const series = monthlySpend(m, 'everything');
  const others = series.filter((s) => s.ym !== card.ym);
  const typical = avgOf(others.map((s) => $(s.total)));
  const rows = spendByCategory(monthTxns(m, card.ym), 'everything');
  const total = rows.reduce((s, r) => s + r.cents, 0);
  return `
    ${chartCard('Money out by month', ctx.chart('ic-big', (el) => columnChart(el, monthBars(series.map((s) => ({ ym: s.ym, v: $(s.total) }))), {
      color: rows[0]?.cat.color || 'orange', highlight: card.ym, ref: { v: typical, label: 'Typical' },
    })))}
    ${stats([[monthLabel(card.ym, 'month'), m0($(total)), 'spent'], ['Typical month', m0(typical), 'the others'], [rows[0]?.cat.name || '—', `${Math.round(((rows[0]?.cents || 0) / (total || 1)) * 100)}%`, 'of that month']])}
    <div class="list-head"><span>Where it went</span></div>
    ${catRows(rows, { ym: card.ym })}
    ${button(ctx.action('open', (s) => { s.close(); app.ui.mode = 'everything'; app.ui.month = card.ym; app.stale.add('spending'); app.selectTab('spending'); }), `Open ${monthLabel(card.ym, 'month')} in Spending`)}`;
}

// ---------- Balance trend ----------
function trend(card, ctx) {
  const m = app.model;
  const daily = dailyBalance(m).map((d) => ({ date: d.date, bal: $(d.bal) }));
  const last = daily[daily.length - 1];
  const low = daily.reduce((a, b) => (b.bal < a.bal ? b : a), daily[0]);
  const high = daily.reduce((a, b) => (b.bal > a.bal ? b : a), daily[0]);
  const months = m.statements.map((s, i) => ({ s, prev: m.statements[i - 1] }));
  return `
    <div class="card ins-card"><div class="card-title">Daily balance</div>
      <div class="chart-readout"><span class="k" id="ib-k">${esc(dateLabel(last.date, 'long'))}</span><b class="v" id="ib-v">${money(last.bal)}</b></div>
      ${ctx.chart('ic-bal', (el) => balanceChart(el, daily, {
        height: 200,
        onScrub: (p) => {
          const pt = p || last;
          document.getElementById('ib-k').textContent = dateLabel(pt.date, 'long');
          document.getElementById('ib-v').textContent = money(pt.bal);
        },
      }))}
      <p class="note" style="margin:8px 0 0">Touch and drag to see any day.</p></div>
    ${stats([['Now', m0(last.bal), dateLabel(last.date, 'short')], ['Low', m0(low.bal), dateLabel(low.date, 'short')], ['High', m0(high.bal), dateLabel(high.date, 'short')]])}
    ${(() => {
      // Only months whose statement printed a closing balance (CSV downloads without balances have none).
      const rows = months.filter(({ s }) => s.closing != null).reverse();
      if (!rows.length) return '<p class="list-foot">Your files don’t include balances, so this shows money in minus money out over time.</p>';
      return `<div class="list-head"><span>Month-end balance</span></div>
    <div class="list">${rows.map(({ s, prev }) => {
      const base = prev?.closing ?? s.opening;
      const d = base != null ? s.closing - base : null;
      return `<div class="row"><span class="main"><span class="title">${esc(monthLabel(s.id))}</span></span>
        <span><span class="value">${money(s.closing)}</span>${d != null ? `<span class="value-sub ${d >= 0 ? 'pos' : 'neg'}">${money(d, { sign: true })}</span>` : ''}</span></div>`;
    }).join('')}</div>`;
    })()}`;
}

// ---------- A category that moved ----------
function mover(card, ctx) {
  const m = app.model;
  const cat = m.cats.get(card.catId);
  const per = m.months.map((ym) => ({ ym, v: $(spendByCategory(monthTxns(m, ym), 'everyday').find((r) => r.cat.id === card.catId)?.cents || 0) }));
  const before = per.filter((p) => p.ym < card.ym && fullMonths().includes(p.ym));
  const avg = avgOf(before.map((p) => p.v));
  const now = per.find((p) => p.ym === card.ym)?.v || 0;
  const list = monthTxns(m, card.ym).filter((t) => t.cat.id === card.catId && !t.oneOff).reverse();
  const change = avg ? Math.round(((now - avg) / avg) * 100) : 0;
  return `
    ${chartCard(`${cat.name} by month`, ctx.chart('ic-mv', (el) => columnChart(el, monthBars(per), { color: cat.color, highlight: card.ym, ref: { v: avg, label: 'Average' } })))}
    ${stats([[monthLabel(card.ym, 'month'), m0(now)], ['Average before', m0(avg)], ['Change', `${change >= 0 ? '+' : '−'}${Math.abs(change)}%`]])}
    <div class="list-head"><span>${esc(monthLabel(card.ym))}</span></div>
    <div class="list">${list.map((t) => txnRow(t, { showDate: true })).join('') || '<div class="empty">Nothing here.</div>'}</div>
    ${button(ctx.action('all', () => openCategory(card.catId, { ym: 'all', mode: 'everyday' })), `Show All ${cat.name}`)}`;
}

// ---------- Eating out vs budget ----------
function eating(card, ctx) {
  const m = app.model;
  const ids = m.plan.eatingOut;
  const full = fullMonths();
  const per = full.map((ym) => ({ ym, v: $(-monthTxns(m, ym).filter((t) => !t.netted && ids.includes(t.cat.id)).reduce((s, t) => s + t.c, 0)) }));
  const budget = planTargets(m.plan).eatingOut;
  const under = per.filter((p) => p.v <= budget).length;
  const best = per.reduce((a, b) => (b.v < a.v ? b : a), per[0]);
  const places = topMerchants(m.txns.filter((t) => ids.includes(t.cat.id)), 'everything', 8);
  return `
    ${chartCard('Eating out by month', ctx.chart('ic-eat', (el) => columnChart(el, monthBars(per), { color: 'orange', highlight: per[per.length - 1]?.ym, ref: { v: budget, label: 'Budget' } })),
      `Restaurants plus coffee and snacks, against your ${m0(budget)} budget.`)}
    ${stats([['Average', m0(avgOf(per.map((p) => p.v))), 'per month'], ['Under budget', `${under} of ${per.length}`, 'months'], ['Lightest', m0(best?.v || 0), best ? monthLabel(best.ym, 'month') : '']])}
    <div class="list-head"><span>Favourite spots</span></div>
    <div class="list">${places.map((p) => `
      <button class="row with-icon tap" data-merchant="${esc(p.name)}">${catIcon(p.cat)}
        <span class="main"><span class="title">${esc(p.name)}</span><span class="subtitle">${esc(p.cat.name)}</span></span>
        <span><span class="value">${money($(p.cents))}</span><span class="value-sub">×${p.count}</span></span>${icon('chev-r', 'chev')}
      </button>`).join('')}</div>`;
}

// ---------- shared pieces for the deeper insights ----------
const row = ({ cat, title, sub = '', value = '', valueSub = '', attrs = '', tap = true, subClass = '' }) => `
  <${tap ? 'button' : 'div'} class="row with-icon ${tap ? 'tap' : ''}" ${attrs}>${catIcon(cat)}
    <span class="main"><span class="title">${esc(title)}</span>${sub ? `<span class="subtitle ${subClass}">${sub}</span>` : ''}</span>
    <span><span class="value">${esc(value)}</span>${valueSub ? `<span class="value-sub">${esc(valueSub)}</span>` : ''}</span>${tap ? icon('chev-r', 'chev') : ''}
  </${tap ? 'button' : 'div'}>`;
const perWord = { weekly: 'week', biweekly: '2 weeks', monthly: 'month', quarterly: '3 months', yearly: 'year' };
const placeRows = (places, per = 1) => `<div class="list">${places.map((p) => row({ cat: p.cat, title: p.name, sub: esc(p.cat.name), value: money($(p.cents / per)), valueSub: `×${Math.round(p.count / per) || p.count}`, attrs: `data-merchant="${esc(p.name)}"` })).join('')}</div>`;

// ---------- This month so far ----------
function pace(card, ctx) {
  const m = app.model;
  const p = paceOf(m, localToday());
  if (!p) return '';
  const full = p.series.slice(0, -1);
  // Each category: this month by day N vs the usual by day N.
  const cats = new Map();
  for (const t of m.txns) {
    if (t.netted || t.cat.type !== 'spend' || !t.cat.everyday || t.oneOff || Number(t.date.slice(8, 10)) > p.day) continue;
    const inFull = full.some((f) => f.ym === t.month);
    if (t.month !== p.ym && !inFull) continue;
    const e = cats.get(t.cat.id) || { cat: t.cat, now: 0, before: 0 };
    if (t.month === p.ym) e.now -= t.c; else e.before -= t.c / full.length;
    cats.set(t.cat.id, e);
  }
  const moved = [...cats.values()].map((e) => ({ ...e, d: e.now - e.before })).filter((e) => Math.abs(e.d) >= 500).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 6);
  const daysLeft = p.days - p.day;
  return `
    ${chartCard(`Spent by day ${p.day}`, ctx.chart('ic-pace', (el) => columnChart(el, p.series.map((x) => ({ key: x.ym, label: monthLabel(x.ym, 'short'), title: `${monthLabel(x.ym)}, by day ${p.day}`, v: $(x.soFar) })), {
      color: card.color, highlight: p.ym, ref: { v: $(p.usualSoFar), label: 'Usual' },
    })), `Everyday spending in the first ${p.day} days of each month.`)}
    ${stats([['So far', m0($(p.soFar)), `day ${p.day} of ${p.days}`], ['Usual by now', m0($(p.usualSoFar)), `${p.months} months`], ['Projected', m0($(p.projected)), `${daysLeft} days to go`]])}
    ${moved.length ? `<div class="list-head"><span>Compared with the usual by day ${p.day}</span></div>
    <div class="list">${moved.map((e) => row({ cat: e.cat, title: e.cat.name, sub: `${m0($(e.now))} vs ${m0($(e.before))} usually`, value: `${e.d > 0 ? '+' : '−'}${m0($(Math.abs(e.d)))}`, attrs: `data-cat="${esc(e.cat.id)}" data-ym="${p.ym}" data-mode="everyday"` })).join('')}</div>` : ''}
    <p class="list-foot">The projection adds what a typical month spends after day ${p.day} to what’s gone so far. Leaves out tuition, travel, transfers and one-offs.</p>`;
}

// ---------- Bills & subscriptions ----------
function repeats(card, ctx) {
  const m = app.model;
  const end = dataEnd(m);
  const all = recurring(m);
  const active = all.filter((r) => r.active);
  const stopped = all.filter((r) => !r.active && r.last >= `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`);
  const monthly = active.reduce((s, r) => s + r.monthly, 0);
  const groups = [['Subscriptions', active.filter((r) => r.kind === 'subscription')], ['Bills', active.filter((r) => r.kind === 'bill')], ['Other regulars', active.filter((r) => r.kind === 'other')]];
  const line = (r) => row({
    cat: r.cat, title: r.name,
    sub: `${esc(r.cadence.label)} · next ${esc(dateLabel(r.next, 'short'))}`,
    value: money($(r.amount)), valueSub: r.change ? `${r.change.pct > 0 ? 'up' : 'down'} ${Math.abs(Math.round(r.change.pct * 100))}%` : r.cadence.id === 'monthly' ? '' : `${money($(r.monthly))}/mo`, attrs: `data-merchant="${esc(r.name)}"`,
  });
  return `
    ${stats([['Per month', m0($(monthly))], ['Per year', m0($(monthly * 12))], ['Charges', String(active.length), 'on repeat']])}
    ${groups.filter(([, l]) => l.length).map(([h, l]) => `<div class="list-head"><span>${h}</span><span class="num">${m0($(l.reduce((s, r) => s + r.monthly, 0)))}/mo</span></div><div class="list">${l.map(line).join('')}</div>`).join('')}
    ${stopped.length ? `<div class="list-head"><span>Stopped</span></div>
      <div class="list">${stopped.map((r) => row({ cat: r.cat, title: r.name, sub: `Last charged ${esc(dateLabel(r.last, 'short'))}`, value: money($(r.amount)), attrs: `data-merchant="${esc(r.name)}"` })).join('')}</div>
      <p class="list-foot">These used to repeat and haven’t charged lately. If you cancelled them, nice.</p>` : ''}
    <p class="list-foot">Found by looking for the same place charging on a schedule. Cancel anything you don’t use; a ${m0(10)} subscription is ${m0(120)} a year.</p>`;
}

// ---------- A price went up ----------
function pricehike(card, ctx) {
  const m = app.model;
  const r = recurring(m).find((x) => x.name === card.merchant && x.change);
  if (!r) return '';
  const charges = r.ids.map((id) => m.byId.get(id)).filter(Boolean);
  const others = recurring(m).filter((x) => x.active && x.change && x.change.pct > 0.02 && x !== r);
  const perYear = (r.change.to - r.change.from) * (365.25 / r.cadence.days);
  return `
    ${chartCard('Each charge', ctx.chart('ic-hike', (el) => columnChart(el, charges.map((t) => ({ key: t.id, label: monthLabel(t.month, 'short'), title: dateLabel(t.date, 'long'), v: -t.amount, color: -t.c >= r.change.to - 1 ? 'red' : r.cat.color })), {
      color: r.cat.color, highlight: charges[charges.length - 1]?.id, format: (v) => moneyShortish(v), readout: (v) => money(v),
    })))}
    ${stats([['Before', money($(r.change.from))], ['Now', money($(r.change.to)), `since ${dateLabel(r.change.date, 'short')}`], ['Extra a year', m0($(perYear))]])}
    ${others.length ? `<div class="list-head"><span>Other price rises</span></div><div class="list">${others.map((x) => row({ cat: x.cat, title: x.name, sub: `${money($(x.change.from))} → ${money($(x.change.to))} on ${esc(dateLabel(x.change.date, 'short'))}`, value: `+${Math.round(x.change.pct * 100)}%`, attrs: `data-merchant="${esc(x.name)}"` })).join('')}</div>` : ''}
    ${button(ctx.action('all', () => openCategory(null, { ym: 'all', mode: 'everything', merchant: r.name })), `Show All ${r.name}`)}`;
}
const moneyShortish = (v) => (v >= 100 ? m0(v) : money(v).replace(/\.00$/, ''));

// ---------- Coming up ----------
function comingUp(card, ctx) {
  const m = app.model;
  const list = upcoming(m, localToday(), 31);
  const within = (d) => list.filter((r) => r.inDays <= d).reduce((s, r) => s + r.typical, 0);
  const bal = currentBalance(m);
  return `
    ${stats([['Next 7 days', m0($(within(7)))], ['Next 14 days', m0($(within(14)))], ['Next 31 days', m0($(within(31)))]])}
    <div class="list">${list.map((r) => row({ cat: r.cat, title: r.name, sub: `${esc(r.inDays === 0 ? 'Today' : r.inDays === 1 ? 'Tomorrow' : dateLabel(r.due))} · ${esc(r.cadence.label)}`, value: money($(r.typical)), valueSub: r.amount !== r.typical ? `last ${money($(r.amount))}` : '', attrs: `data-merchant="${esc(r.name)}"` })).join('') || '<div class="empty">Nothing due.</div>'}</div>
    <p class="list-foot">Expected from when each one charged before${bal && !bal.relative ? `. Your balance was ${esc(money($(bal.cents)))} on ${esc(dateLabel(bal.date, 'short'))}` : ''}. Amounts that vary show the typical charge.</p>`;
}
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------- Unusual charge ----------
function unusual(card, ctx) {
  const m = app.model;
  const list = unusualOf(m);
  const u = list.find((x) => x.t.id === card.txn) || list[0];
  if (!u) return '';
  const t = u.t;
  const history = m.txns.filter((x) => x.name === t.name && !x.netted && x.c < 0);
  return `
    <div class="list">${txnRow(t, { showDate: true })}</div>
    ${stats([['This charge', m0(-t.amount)], [u.kind === 'merchant' ? 'Usual there' : `Usual ${t.cat.name}`, money($(u.usual))], ['That’s', `${u.times >= 10 ? '10+' : u.times.toFixed(1)}×`, 'the usual']])}
    ${history.length > 1 ? chartCard(`Every visit to ${t.name}`, ctx.chart('ic-odd', (el) => columnChart(el, history.slice(-24).map((x) => ({ key: x.id, label: dateLabel(x.date, 'short').split(' ')[0], title: dateLabel(x.date, 'long'), v: -x.amount, color: x.id === t.id ? 'orange' : 'gray' })), {
      color: 'gray', highlight: t.id, readout: (v) => money(v),
    }))) : ''}
    ${list.length > 1 ? `<div class="list-head"><span>Also unusual lately</span></div><div class="list">${list.filter((x) => x !== u).slice(0, 6).map((x) => txnRow(x.t, { showDate: true })).join('')}</div>` : ''}
    <p class="list-foot">Planned it? Mark it as a one-off and it stays out of Everyday spending and these checks.</p>
    ${t.oneOff ? '' : button(ctx.action('oneoff', async (s) => {
      const raw = app.vault.transactions.find((x) => x.id === (t.partOf || t.id));
      raw.oneOff = true;
      await app.commit({ silent: true });
      toast('Marked as one-off');
      s.close();
    }), 'Mark as One-off')}`;
}

// ---------- Possible double charge ----------
function duplicate(card, ctx) {
  const m = app.model;
  const [a, b] = card.ids.map((id) => m.byId.get(id));
  if (!a || !b) return '';
  return `
    <div class="list">${txnRow(a, { showDate: true })}${txnRow(b, { showDate: true })}</div>
    <p class="list-foot">Same place, same amount, ${a.date === b.date ? 'same day' : 'a day apart'}. If you only bought it once, ask ${esc(a.name)} or your bank to reverse the second charge. A pending charge that was re-posted sometimes looks like this too.</p>
    ${button(ctx.action('fine', async (s) => {
      app.vault.dismissed = [...(app.vault.dismissed || []), card.key].slice(-200);
      await app.commit({ silent: true });
      toast('Got it');
      s.close();
    }), 'Both Were Real')}`;
}

// ---------- Weekends ----------
function weekend(card, ctx) {
  const m = app.model;
  const w = weekdays(m);
  if (!w) return '';
  const order = [1, 2, 3, 4, 5, 6, 0];
  const top = w.avg.indexOf(Math.max(...w.avg));
  const full = new Set(fullMonths());
  const wkTxns = m.txns.filter((t) => full.has(t.month) && [0, 6].includes(new Date(`${t.date}T12:00:00`).getDay()) && !['housing', 'bills', 'internet', 'fees', 'transfers', 'education', 'government', 'cash'].includes(t.cat.id));
  const rows = spendByCategory(wkTxns, 'everyday');
  const extra = (w.weekend - w.weekday) * 104;
  return `
    ${chartCard('Average spent per day', ctx.chart('ic-dow', (el) => columnChart(el, order.map((d) => ({ key: d, label: WEEKDAYS[d], title: WEEKDAYS_LONG[d], v: $(w.avg[d]), color: d === 0 || d === 6 ? 'indigo' : 'gray' })), {
      color: 'gray', highlight: top, height: 160,
    })), `${WEEKDAYS_LONG[top]} cost the most. Bills, rent and transfers aren’t counted.`)}
    ${stats([['Weekend day', m0($(w.weekend))], ['Weekday', m0($(w.weekday))], [extra >= 0 ? 'Extra a year' : 'Saved a year', m0($(Math.abs(extra)))]])}
    <div class="list-head"><span>Weekends go on</span></div>
    ${catRows(rows, { per: w.months, mode: 'everyday' })}
    <p class="list-foot">Per month, over ${plural(w.months, 'full month')}.</p>`;
}

// ---------- Small buys ----------
function small(card, ctx) {
  const m = app.model;
  const sm = smallBuys(m);
  if (!sm) return '';
  return `
    ${stats([['Per month', m0($(sm.perMonth))], ['Purchases', String(Math.round(sm.countPerMonth)), 'a month'], ['Per year', m0($(sm.perMonth * 12))]])}
    <div class="list-head"><span>Under ${esc(m0($(sm.limit)))}, by category</span><span>per month</span></div>
    <div class="list">${sm.cats.map((c) => row({ cat: c.cat, title: c.cat.name, sub: `${Math.round(c.count / sm.months)} a month · ${Math.round((c.cents / sm.perMonth / sm.months) * 100)}%`, value: m0($(c.cents / sm.months)), attrs: `data-cat="${esc(c.cat.id)}" data-mode="everyday"` })).join('')}</div>
    <div class="list-head"><span>Where they happen</span></div>
    ${placeRows(sm.places.slice(0, 8), sm.months)}
    <p class="list-foot">That’s ${Math.round(sm.share * 100)}% of your everyday spending, a few dollars at a time.</p>`;
}

// ---------- Money in vs out ----------
function savings(card, ctx) {
  const cf = cashflow(app.model);
  if (!cf) return '';
  const best = cf.months.reduce((a, b) => (b.net > a.net ? b : a), cf.months[0]);
  return `
    ${chartCard('Left over each month', ctx.chart('ic-net', (el) => columnChart(el, cf.months.map((x) => ({ key: x.ym, label: monthLabel(x.ym, 'short'), title: monthLabel(x.ym), v: $(x.net), color: x.net >= 0 ? 'green' : 'red' })), {
      color: 'green', highlight: cf.months[cf.months.length - 1].ym, ref: { v: $(cf.net), label: 'Average' },
    })), 'Money in minus money out. Moves between your own accounts aren’t counted.')}
    ${stats([['In', m0($(cf.inn)), 'a month'], ['Out', m0($(cf.out)), 'a month'], ['Best month', m0($(best.net)), monthLabel(best.ym, 'month')]])}
    <div class="list">${[...cf.months].reverse().map((x) => `<div class="row"><span class="main"><span class="title">${esc(monthLabel(x.ym))}</span><span class="subtitle">${m0($(x.inn))} in · ${m0($(x.out))} out</span></span>
      <span class="value ${x.net >= 0 ? 'pos' : 'neg'}">${money($(x.net), { sign: true, cents: false })}</span></div>`).join('')}</div>`;
}

// ---------- Safety net ----------
function runway(card, ctx) {
  const m = app.model;
  const cf = cashflow(m);
  const bal = currentBalance(m);
  if (!cf || !bal) return '';
  return `
    ${chartCard('Money out each month', ctx.chart('ic-out', (el) => columnChart(el, cf.months.map((x) => ({ key: x.ym, label: monthLabel(x.ym, 'short'), title: monthLabel(x.ym), v: $(x.out) })), {
      color: 'teal', highlight: cf.months[cf.months.length - 1].ym, ref: { v: $(cf.out), label: 'Average' },
    })))}
    ${stats([['Balance', m0($(bal.cents)), dateLabel(bal.date, 'short')], ['Out a month', m0($(cf.out)), 'average'], ['Lasts', card.title]])}
    <p class="list-foot">If nothing came in, this is how long your balance would cover your usual spending. Three to six months is a common cushion.</p>`;
}

// ---------- Bank fees ----------
function fees(card, ctx) {
  const m = app.model;
  const f = feesOf(m);
  if (!f) return '';
  const months = m.months.slice(-12);
  return `
    ${chartCard('Fees by month', ctx.chart('ic-fees', (el) => columnChart(el, months.map((ym) => ({ key: ym, label: monthLabel(ym, 'short'), title: monthLabel(ym), v: $(f.perMonth.get(ym) || 0) })), {
      color: 'gray', highlight: months[months.length - 1], readout: (v) => money(v), format: (v) => moneyShortish(v),
    })))}
    <div class="list-head"><span>What they were</span></div>
    ${placeRows(f.names)}
    <p class="list-foot">Overdraft and monthly account fees are often waived if you ask, or avoided with a minimum balance or a no-fee account.</p>`;
}

// ---------- Amazon ----------
function amazonPage(card, ctx) {
  const m = app.model;
  const a = amazonOf(m);
  if (!a) return '';
  const raw = app.vault.transactions.filter((t) => t.items?.length && AMAZON_RE.test(t.name)).slice(-30).reverse();
  return `
    ${chartCard('Amazon by month', ctx.chart('ic-amz', (el) => columnChart(el, monthBars(a.byMonth.map((x) => ({ ym: x.ym, v: $(x.v) }))), { color: 'orange', highlight: a.byMonth[a.byMonth.length - 1]?.ym, ref: { v: $(a.perMonth), label: 'Average' } })))}
    ${stats([['Per month', m0($(a.perMonth))], ['Orders', String(a.orders), plural(a.months, 'month')], ['Sorted', `${a.sorted} of ${a.orders}`, 'item by item']])}
    <div class="list-head"><span>What it was</span></div>
    ${catRows(a.cats, { merchant: 'Amazon' })}
    ${raw.length ? `<div class="list-head"><span>Recent items</span></div>
    <div class="list">${raw.flatMap((t) => t.items.map((it) => row({ cat: m.cats.get(it.category) || m.cats.get('shopping'), title: it.title, sub: `${esc(dateLabel(t.date, 'short'))} · ${esc((m.cats.get(it.category) || m.cats.get('shopping')).name)}`, value: money(it.amount), attrs: `data-txn="${esc(t.id)}"` }))).slice(0, 25).join('')}</div>` : ''}
    <div class="card" style="margin-top:22px">
      <div class="card-title">${a.sorted ? 'Keep it up to date' : 'See what each order was'}</div>
      <p class="note" style="margin:0 0 12px">A bank statement only says “Amazon”. Your Amazon order history says what you bought, so Money can file a phone under Electronics and coffee under Groceries, and split an order that had both.</p>
      <p class="note" style="margin:0 0 12px">On Amazon, open <b>Account → Request Your Data</b>, choose <b>Your Orders</b>, then add the zip it emails you. It’s read on this device; only item names, prices and dates are kept, encrypted. Addresses and payment details are ignored.</p>
      <button class="btn" data-action="${ctx.action('import', async () => (await import('./amazon-import.js')).openAmazonImport())}">Add Amazon Orders</button>
    </div>
    ${a.unsorted.length ? `<div class="list-head"><span>Not sorted yet</span><span>${a.unsorted.length}</span></div>
      <div class="list">${a.unsorted.slice(-12).reverse().map((t) => txnRow(t, { showDate: true })).join('')}</div>
      <p class="list-foot">Tap one to pick what it was, or split it between categories.</p>` : ''}`;
}
