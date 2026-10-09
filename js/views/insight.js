// Insight detail: tapping an Overview insight opens the story behind it —
// a chart with the month in question highlighted, three key numbers, and the data to drill into.
import { app } from '../state.js';
import { money, monthLabel, dateLabel, esc, fromCents, plural, daysInMonth } from '../format.js';
import { monthlySpend, spendByCategory, monthTxns, topMerchants, dailyBalance, planTargets } from '../ledger.js';
import { icon, catIcon, openSheet, haptic } from '../ui.js';
import { columnChart, balanceChart } from '../charts.js';
import { txnRow, openTxn, openCategory } from './sheets.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const $ = (c) => fromCents(c);
const m0 = (dollars) => money(dollars, { cents: false });

export function openInsight(card) {
  if (card.id === 'plan') { app.selectTab('plan'); return; }
  const builders = { habit, everyday, bigmonth, trend, mover, eating };
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
  // Draw charts once the sheet has its width.
  requestAnimationFrame(() => charts.forEach(([id, fn]) => { const el = sheet.el.querySelector(`#${id}`); if (el) fn(el); }));
  sheet.el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-txn]');
    if (t) { haptic(); openTxn(t.dataset.txn); return; }
    const c = e.target.closest('[data-cat]');
    if (c) { haptic(); openCategory(c.dataset.cat, { ym: c.dataset.ym || 'all', mode: c.dataset.mode || 'everything' }); return; }
    const mer = e.target.closest('[data-merchant]');
    if (mer) { haptic(); openCategory(null, { ym: 'all', mode: 'everything', merchant: mer.dataset.merchant }); return; }
    const a = e.target.closest('[data-action]');
    if (a && actions.has(a.dataset.action)) { haptic(); actions.get(a.dataset.action)(sheet); }
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
const catRows = (rows, { per = 1, ym = 'all', mode = 'everything' } = {}) => {
  const total = rows.reduce((s, r) => s + r.cents, 0) || 1;
  return `<div class="list">${rows.map((r) => `
    <button class="row with-icon tap" data-cat="${esc(r.cat.id)}" data-ym="${ym}" data-mode="${mode}">
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
