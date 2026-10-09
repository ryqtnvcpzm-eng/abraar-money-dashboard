// Spending, Apple Card style: Week / Month / Year, a big total with the change from the period before,
// bars stacked by category (tap one to see just that day or month), the budget left, categories, places.
import { app } from '../state.js';
import { money, monthLabel, esc, fromCents, plural, daysBetween, addDays, iso, dateLabel, daysInMonth } from '../format.js';
import { planMonth, planTargets } from '../ledger.js';
import { periodFor, shiftPeriod, periodLabel, periodName, buckets, rangeSpend, rangeMerchants, dataSpan } from '../period.js';
import { icon, catIcon, pageFrame, wireLargeTitle, haptic, segmented, layoutSegmented, openSheet } from '../ui.js';
import { categoryBars } from '../charts.js';
import { openCategory } from './sheets.js';

const KINDS = [['week', 'W'], ['month', 'M'], ['year', 'Y']];
const UNIT = { week: 'week', month: 'month', year: 'year' };
const today = () => iso(new Date());
const m0 = (c) => money(fromCents(c), { cents: false });

export function renderSpending(page) {
  const m = app.model;
  const span = dataSpan(m);
  const right = `<button class="glass-btn wide pill-btn" data-act="mode" aria-label="What to count: ${app.ui.mode === 'everyday' ? 'Everyday' : 'Everything'}">${app.ui.mode === 'everyday' ? 'Everyday' : 'Everything'}${icon('chev-d')}</button>`;
  if (!span) {
    page.innerHTML = pageFrame({ title: 'Spending', body: `<div class="card"><div class="empty"><div class="ic">${icon('spending')}</div><h3>No spending yet</h3><p>Add a statement or connect your bank to see where your money goes.</p></div></div>` });
    wireLargeTitle(page);
    return;
  }
  const kind = (app.ui.spKind ||= 'month');
  const mode = app.ui.mode;
  const first = periodFor(kind, span[0]);
  const last = periodFor(kind, span[1]);
  let p = periodFor(kind, app.ui.spAnchor || span[1]);
  if (p.from < first.from) p = first;
  if (p.from > last.from) p = last;
  app.ui.spAnchor = p.from;
  const canPrev = p.from > first.from;
  const canNext = p.from < last.from;

  const cur = rangeSpend(m, p.from, p.to, mode);
  const prevP = shiftPeriod(p, -1);
  const ongoing = p.to > span[1];
  // A period still going is compared with the same stretch of the one before (8 days of October with
  // the first 8 days of September), never with all of it.
  const cutoff = !ongoing ? prevP.to : kind === 'year' ? `${prevP.key}${span[1].slice(4)}` : addDays(prevP.from, daysBetween(p.from, span[1]));
  const prevTo = cutoff < prevP.to ? cutoff : prevP.to;
  const prev = prevP.from >= span[0] ? rangeSpend(m, prevP.from, prevTo, mode) : null;
  const bars = buckets(m, p, mode);
  const sel = bars.find((b) => b.key === app.ui.spSel) || null;
  if (!sel) app.ui.spSel = null;
  const focus = sel ? { from: sel.from, to: sel.to, total: sel.total, rows: sel.rows } : { from: p.from, to: p.to, ...cur };
  const prevRows = !sel && prev ? new Map(prev.rows.map((r) => [r.cat.id, r.cents])) : null;
  const order = stackOrder(cur.rows);
  // Average per day (week, month) or per month (year), over the part of the period there's data for.
  const end = p.to < span[1] ? p.to : span[1];
  const start = p.from > span[0] ? p.from : span[0];
  const units = kind === 'year' ? Math.max(1, Number(end.slice(5, 7)) - Number(start.slice(5, 7)) + 1) : Math.max(1, daysBetween(start, end) + 1);
  const avg = cur.total / units;
  const delta = prev && prev.total ? cur.total - prev.total : null;
  const than = kind === 'year' ? `${ongoing ? 'by this point in ' : ''}${prevP.key}` : `${ongoing ? 'by this point ' : ''}last ${UNIT[kind]}`;
  const merchants = rangeMerchants(m, focus.from, focus.to, mode, 6);
  const total = focus.total || 1;

  const body = `
    ${segmented('spKind', KINDS.map(([k, l]) => [k, l]), kind, 'period-seg')}
    <section class="period-head" id="sp-head">
      <button class="arrow" data-step="-1" aria-label="Previous ${UNIT[kind]}" ${canPrev ? '' : 'disabled'}>${icon('chev-l')}</button>
      <button class="period-mid" data-act="periods" aria-label="Choose a ${UNIT[kind]}">
        <span class="period-k">${esc(sel ? sel.title : periodLabel(p, today()))}</span>
        <span class="period-big num">${money(fromCents(focus.total))}</span>
        <span class="period-sub">${sel ? `${esc(periodName(p))} · tap the bar again to see all`
          : delta == null ? (ongoing ? `Through ${esc(dateLabel(span[1], 'short'))}` : esc(periodName(p)))
          : `<span class="${delta > 0 ? 'neg' : 'pos'}">${delta > 0 ? '▲' : '▼'} ${m0(Math.abs(delta))}</span> ${delta > 0 ? 'more' : 'less'} than ${than}`}</span>
      </button>
      <button class="arrow" data-step="1" aria-label="Next ${UNIT[kind]}" ${canNext ? '' : 'disabled'}>${icon('chev-r')}</button>
    </section>
    <div class="card chart-card" id="sp-card">
      <div class="chart-wrap" id="sp-chart"></div>
      <div class="chart-foot"><span>${kind === 'year' ? 'Monthly' : 'Daily'} average <b class="num">${m0(avg)}</b></span>${order.length ? `<span class="mini-legend">${order.slice(0, 4).map((id) => `<i style="--c:var(--${m.cats.get(id).color})"></i>`).join('')}</span>` : ''}</div>
    </div>
    ${budgetCard(m, p, kind, span)}
    <div class="section-head"><h2>Categories</h2>${sel ? '<button class="more link" data-act="clear-sel">Show All</button>' : ''}</div>
    <div class="list">
      ${focus.rows.length ? focus.rows.map((r) => {
        const before = prevRows?.get(r.cat.id) || 0;
        const d = prevRows && before > 0 ? (r.cents - before) / before : null;
        return `<button class="row with-icon tap cat-row" data-cat="${esc(r.cat.id)}">
          ${catIcon(r.cat)}
          <span class="main"><span class="title">${esc(r.cat.name)}</span>
            <span class="pctbar"><i style="--c:var(--${r.cat.color});width:${Math.max(2, (r.cents / focus.rows[0].cents) * 100)}%"></i></span></span>
          <span><span class="value">${money(fromCents(r.cents))}</span><span class="value-sub">${Math.round((r.cents / total) * 100)}%${d != null && Math.abs(d) >= 0.05 ? ` · <span class="${d > 0 ? 'neg' : 'pos'}">${d > 0 ? '▲' : '▼'}${Math.min(999, Math.round(Math.abs(d) * 100))}%</span>` : ''}</span></span>
          ${icon('chev-r', 'chev')}
        </button>`;
      }).join('') : `<div class="empty">Nothing spent ${sel ? 'that day' : `this ${UNIT[kind]}`}.</div>`}
    </div>
    ${prevRows ? `<p class="list-foot">Changes compare with ${than}.</p>` : ''}
    ${merchants.length ? `
    <div class="section-head"><h2>Places</h2><button class="more link" data-act="all-places">See All</button></div>
    <div class="list">${merchants.map((x) => `
      <button class="row with-icon tap" data-merchant="${esc(x.name)}">${catIcon(x.cat)}
        <span class="main"><span class="title">${esc(x.name)}</span><span class="subtitle">${plural(x.count, 'visit')}</span></span>
        <span class="value">${money(fromCents(x.cents))}</span>${icon('chev-r', 'chev')}
      </button>`).join('')}</div>` : ''}
    <p class="list-foot">${mode === 'everyday' ? 'Everyday leaves out tuition, travel, immigration, money sent to people and anything you mark as a one-off.' : 'Everything that left the account except moves between your own accounts. Reversals are netted out.'}</p>`;

  page.innerHTML = pageFrame({ title: 'Spending', right, body });
  wireLargeTitle(page);
  layoutSegmented(page);
  categoryBars(page.querySelector('#sp-chart'), bars, {
    order, selected: sel?.key ?? null, avg,
    every: kind === 'month' ? 7 : 1,
    onSelect: (key) => { app.ui.spSel = key; renderSpending(page); },
  });

  const go = (n) => {
    const next = shiftPeriod(p, n);
    if (next.from < first.from || next.from > last.from) return;
    haptic();
    app.ui.spAnchor = next.from; app.ui.spSel = null;
    renderSpending(page);
  };
  // Swipe the chart or the header to change period, like the Health and Fitness charts.
  for (const el of [page.querySelector('#sp-card'), page.querySelector('#sp-head')]) {
    let x0 = null, y0 = null;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 40) go(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  page.onclick = async (e) => {
    const step = e.target.closest('[data-step]');
    if (step && !step.disabled) { go(Number(step.dataset.step)); return; }
    const seg = e.target.closest('[data-seg="spKind"] button');
    if (seg) {
      haptic();
      app.ui.spKind = seg.dataset.v;
      app.ui.spSel = null;
      // Keep looking at the same time: the new period contains the start of the old one (or the latest data).
      app.ui.spAnchor = p.to >= span[1] ? span[1] : p.from;
      renderSpending(page);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'mode') { haptic(); pickMode(page); return; }
    if (act === 'clear-sel') { haptic(); app.ui.spSel = null; renderSpending(page); return; }
    if (act === 'periods') { haptic(); pickPeriod(page, kind, first, last, mode); return; }
    if (act === 'all-places') { haptic(); allPlaces(focus, sel ? sel.title : periodName(p), mode); return; }
    if (act === 'budget') { haptic(); (await import('./budget.js')).openBudget(); return; }
    if (act === 'plan') { haptic(); (await import('./budget.js')).openPlanEditor(); return; }
    const cat = e.target.closest('[data-cat]');
    if (cat) { haptic(); openCategory(cat.dataset.cat, { mode, from: focus.from, to: focus.to, label: sel ? sel.title : periodName(p) }); return; }
    const mer = e.target.closest('[data-merchant]');
    if (mer) { haptic(); openCategory(null, { mode, merchant: mer.dataset.merchant, from: focus.from, to: focus.to, label: sel ? sel.title : periodName(p) }); }
  };
}

/** The month's budget at a glance: what's left, and what that means per day. */
function budgetCard(m, p, kind, span) {
  if (kind !== 'month') return '';
  if (!m.plan) {
    return `<button class="card budget-cta" data-act="plan"><span class="cat-icon sm" style="--c:var(--green)">${icon('rings')}</span>
      <span class="main"><span class="title">Set a monthly budget</span><span class="subtitle">See what’s left to spend each day</span></span>${icon('chev-r', 'chev')}</button>`;
  }
  const pm = planMonth(m, p.key);
  const t = planTargets(m.plan);
  if (!pm.hasData) return '';
  const left = t.spend - pm.spent;
  const live = p.to > span[1];
  const day = live ? Number(span[1].slice(8, 10)) : daysInMonth(p.key);
  const daysLeft = daysInMonth(p.key) - day;
  const ratio = t.spend ? pm.spent / t.spend : 0;
  const pace = t.spend * (day / daysInMonth(p.key));
  const color = ratio > 1 ? 'red' : pm.spent > pace * 1.1 && live ? 'orange' : 'green';
  return `<button class="card budget-card" data-act="budget">
    <div class="bc-top"><span class="bc-k">${live ? 'Left to spend' : left >= 0 ? 'Under budget' : 'Over budget'}</span><span class="bc-v num ${left < 0 ? 'neg' : ''}">${m0(Math.abs(left) * 100)}</span>${icon('chev-r', 'chev')}</div>
    <span class="bar"><i style="--c:var(--${color});width:${Math.min(100, ratio * 100)}%"></i>${live ? `<b class="today" style="left:${Math.min(100, (day / daysInMonth(p.key)) * 100)}%"></b>` : ''}</span>
    <div class="bc-sub">${live && left > 0 && daysLeft > 0 ? `About <b>${m0((left / daysLeft) * 100)}</b> a day for the ${daysLeft} days left. ` : ''}${m0(pm.spent * 100)} of ${m0(t.spend * 100)} spent${live ? '' : ` in ${esc(monthLabel(p.key, 'month'))}`}.</div>
  </button>`;
}

/** Up to six categories with distinct colors get their own segment; the rest are gray. */
function stackOrder(rows) {
  const used = new Set(['gray']);
  const order = [];
  for (const r of rows) {
    if (order.length >= 6 || used.has(r.cat.color)) continue;
    used.add(r.cat.color);
    order.push(r.cat.id);
  }
  return order;
}

function pickMode(page) {
  const sheet = openSheet({
    title: 'Show',
    body: `<div class="list" style="margin-top:4px">${[
      ['everyday', 'Everyday', 'Day-to-day spending. Leaves out tuition, travel, immigration, money sent to people and one-offs.'],
      ['everything', 'Everything', 'All money out, except moves between your own accounts.'],
    ].map(([v, t, s]) => `<button class="row tap" data-pick="${v}"><span class="main"><span class="title">${t}</span><span class="subtitle" style="white-space:normal">${s}</span></span>
      ${app.ui.mode === v ? `<span style="color:var(--tint)">${icon('check')}</span>` : '<span style="width:17px"></span>'}</button>`).join('')}</div>`,
  });
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    haptic();
    app.ui.mode = b.dataset.pick;
    sheet.close();
    app.stale.add('overview');
    renderSpending(page);
  });
}

function pickPeriod(page, kind, first, last, mode) {
  const list = [];
  for (let p = last; p.from >= first.from && list.length < 120; p = shiftPeriod(p, -1)) list.push(p);
  const sheet = openSheet({
    title: { week: 'Week', month: 'Month', year: 'Year' }[kind],
    body: `<div class="list" style="margin-top:4px">${list.map((p) => `
      <button class="row tap" data-pick="${p.from}">
        <span class="main"><span class="title">${esc(periodName(p))}</span></span>
        <span class="detail num">${money(fromCents(rangeSpend(app.model, p.from, p.to, mode).total), { cents: false })}</span>
        ${p.from === app.ui.spAnchor ? `<span style="color:var(--tint)">${icon('check')}</span>` : '<span style="width:17px"></span>'}
      </button>`).join('')}</div>`,
  });
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    haptic();
    app.ui.spAnchor = b.dataset.pick; app.ui.spSel = null;
    sheet.close();
    renderSpending(page);
  });
}

function allPlaces(focus, label, mode) {
  const list = rangeMerchants(app.model, focus.from, focus.to, mode, 500);
  const sheet = openSheet({
    title: 'Places', size: 'full',
    body: `<p class="list-foot" style="margin:4px 4px 12px">${esc(label)} · ${plural(list.length, 'place')}</p>
      <div class="list">${list.map((x, i) => `
        <button class="row tap" data-merchant="${esc(x.name)}"><span class="rank">${i + 1}</span>${catIcon(x.cat, 'sm')}
          <span class="main"><span class="title">${esc(x.name)}</span><span class="subtitle">${esc(x.cat.name)} · ${plural(x.count, 'visit')}</span></span>
          <span class="value">${money(fromCents(x.cents))}</span></button>`).join('')}</div>`,
  });
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-merchant]');
    if (!b) return;
    haptic();
    openCategory(null, { mode, merchant: b.dataset.merchant, from: focus.from, to: focus.to, label });
  });
}

