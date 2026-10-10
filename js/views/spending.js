// Spending: how much went out this month (or year), whether that's more or less than usual, and where it went.
// One big number, a plain-English comparison, one easy chart, then categories and places.
import { app } from '../state.js';
import { money, monthLabel, esc, fromCents, plural, daysBetween, addDays, iso, dateLabel, daysInMonth, MONTHS_LONG } from '../format.js';
import { planMonth, planTargets, spendByCategory } from '../ledger.js';
import { periodFor, shiftPeriod, rangeSpend, rangeMerchants, dataSpan, cumulative } from '../period.js';
import { icon, catIcon, pageFrame, wireLargeTitle, haptic, segmented, layoutSegmented, openSheet } from '../ui.js';
import { cumulativeChart, columnChart } from '../charts.js';
import { openCategory } from './sheets.js';

const m0 = (c) => money(fromCents(c), { cents: false });
const CATS_SHOWN = 6;

export function renderSpending(page) {
  const m = app.model;
  const span = dataSpan(m);
  if (!span) {
    page.innerHTML = pageFrame({ title: 'Spending', body: `<div class="card"><div class="empty"><div class="ic">${icon('spending')}</div><h3>No spending yet</h3><p>Add a statement or connect your bank to see where your money goes.</p></div></div>` });
    wireLargeTitle(page);
    return;
  }
  const kind = app.ui.spKind === 'year' ? 'year' : 'month';
  app.ui.spKind = kind;
  const mode = app.ui.mode;
  const first = periodFor(kind, span[0]);
  const last = periodFor(kind, span[1]);
  let p = periodFor(kind, app.ui.spAnchor || span[1]);
  if (p.from < first.from) p = first;
  if (p.from > last.from) p = last;
  app.ui.spAnchor = p.from;
  const canPrev = p.from > first.from;
  const canNext = p.from < last.from;
  const ongoing = p.to > span[1];
  const end = ongoing ? span[1] : p.to;

  // This period, and the one before up to the same point (8 days of October against the first 8 of September).
  const inRange = (from, to) => m.txns.filter((t) => t.date >= from && t.date <= to);
  const rows = spendByCategory(inRange(p.from, p.to), mode);
  const total = rows.reduce((s, r) => s + r.cents, 0);
  const prevP = shiftPeriod(p, -1);
  const hasPrev = prevP.to >= span[0];
  const prevTo = !ongoing ? prevP.to : kind === 'year' ? `${prevP.key}${span[1].slice(4)}` : addDays(prevP.from, daysBetween(p.from, span[1]));
  const prevRows = hasPrev ? spendByCategory(inRange(prevP.from, prevTo < prevP.to ? prevTo : prevP.to), mode) : [];
  const prevTotal = prevRows.reduce((s, r) => s + r.cents, 0);
  const prevBy = new Map(prevRows.map((r) => [r.cat.id, r.cents]));
  const prevName = kind === 'year' ? prevP.key : MONTHS_LONG[Number(prevP.key.slice(5, 7)) - 1];
  const delta = hasPrev && prevTotal > 0 ? total - prevTotal : null;
  const name = kind === 'year' ? p.key : monthLabel(p.key);
  const today = iso(new Date());
  const isNow = periodFor(kind, today).key === p.key;

  const compare = delta == null ? ''
    : Math.abs(delta) < Math.max(500, prevTotal * 0.03) ? `<span class="sp-pill same">About the same as ${esc(prevName)}${ongoing ? ' by now' : ''}</span>`
    : `<span class="sp-pill ${delta > 0 ? 'up' : 'down'}">${icon(delta > 0 ? 'trendUp' : 'trendDown')}${m0(Math.abs(delta))} ${delta > 0 ? 'more' : 'less'} than ${esc(prevName)}${ongoing ? ' by now' : ''}</span>`;

  const body = `
    ${segmented('spKind', [['month', 'Month'], ['year', 'Year']], kind, 'period-seg')}
    <div class="sp-nav">
      <button class="arrow" data-step="-1" aria-label="Previous ${kind}" ${canPrev ? '' : 'disabled'}>${icon('chev-l')}</button>
      <button class="sp-when" data-act="periods" aria-label="Choose a ${kind}: ${esc(name)}"><span>${esc(name)}</span>${icon('chev-d')}</button>
      <button class="arrow" data-step="1" aria-label="Next ${kind}" ${canNext ? '' : 'disabled'}>${icon('chev-r')}</button>
    </div>
    <section class="card sp-hero" id="sp-card">
      <div class="sp-k">${isNow || ongoing ? 'Spent so far' : 'Spent'}${ongoing ? ` · through ${esc(dateLabel(span[1], 'short'))}` : ''}</div>
      <div class="sp-total num">${money(fromCents(total))}</div>
      ${compare}
      <div class="chart-wrap sp-chart" id="sp-chart"></div>
      <button class="sp-filter" data-act="mode">${icon(mode === 'everyday' ? 'cart' : 'bag')}<span>${mode === 'everyday' ? 'Everyday spending' : 'All spending'}</span><b>Change</b></button>
    </section>
    ${budgetCard(m, p, kind, span)}
    ${rows.length ? `
    <div class="section-head"><h2>Where it went</h2></div>
    <div class="card sp-cats">
      <div class="sp-mix" role="img" aria-label="${esc(rows.map((r) => `${r.cat.name} ${Math.round((r.cents / total) * 100)}%`).join(', '))}">
        ${rows.slice(0, 7).map((r) => `<i style="--c:var(--${r.cat.color});flex-grow:${r.cents}"></i>`).join('')}${rows.length > 7 ? `<i style="--c:var(--gray);flex-grow:${rows.slice(7).reduce((s, r) => s + r.cents, 0)}"></i>` : ''}
      </div>
      <div class="sp-rows">${rows.map((r, i) => catRow(r, total, prevBy, prevName, hasPrev, i >= CATS_SHOWN && !app.ui.spAllCats)).join('')}</div>
      ${rows.length > CATS_SHOWN ? `<button class="sp-more" data-act="more-cats">${app.ui.spAllCats ? 'Show Less' : `Show All ${rows.length} Categories`}</button>` : ''}
    </div>` : `<div class="card"><div class="empty">Nothing spent in ${esc(name)}.</div></div>`}
    ${placesBlock(m, p, mode)}
    <p class="list-foot">${mode === 'everyday' ? 'Everyday leaves out tuition, travel, immigration, money sent to people and anything you mark as a one-off. Tap “Change” above to include everything.' : 'All money that left the account, except moves between your own accounts. Refunds and reversals are netted out.'}</p>`;

  page.innerHTML = pageFrame({ title: 'Spending', body });
  wireLargeTitle(page);
  layoutSegmented(page);

  const chartEl = page.querySelector('#sp-chart');
  if (kind === 'month') {
    const plan = m.plan ? planTargets(m.plan) : null;
    cumulativeChart(chartEl, {
      cur: cumulative(m, p.from, p.to, mode, end),
      prev: hasPrev ? cumulative(m, prevP.from, prevP.to, mode) : [],
      budget: plan && p.key >= m.plan.start.slice(0, 7) ? plan.spend * 100 : null,
      curLabel: MONTHS_LONG[Number(p.key.slice(5, 7)) - 1], prevLabel: prevName,
      dayLabel: (i) => dateLabel(addDays(p.from, i), 'short'),
      color: 'blue',
    });
  } else {
    // A year: one bar per month; tap one to open that month.
    const months = Array.from({ length: 12 }, (_, i) => `${p.key}-${String(i + 1).padStart(2, '0')}`);
    const vals = months.map((ym) => (ym <= span[1].slice(0, 7) && ym >= span[0].slice(0, 7) ? rangeSpend(m, `${ym}-01`, `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`, mode).total : 0));
    const filled = vals.filter((v, i) => months[i] <= span[1].slice(0, 7) && months[i] >= span[0].slice(0, 7));
    const avg = filled.length ? filled.reduce((a, b) => a + b, 0) / filled.length : 0;
    columnChart(chartEl, months.map((ym, i) => ({ key: ym, label: monthLabel(ym, 'short').slice(0, 1), title: monthLabel(ym), v: fromCents(vals[i]) })), {
      color: 'blue', highlight: span[1].slice(0, 7) <= months[11] ? span[1].slice(0, 7) : null, ref: avg ? { v: fromCents(avg), label: 'Average' } : null, height: 180,
    });
    chartEl.insertAdjacentHTML('beforeend', '<p class="sp-hint">Tap a month to open it.</p>');
    chartEl.querySelectorAll('.cc-bar').forEach((b) => b.addEventListener('click', () => {
      const ym = months[+b.dataset.i];
      if (ym > span[1].slice(0, 7) || ym < span[0].slice(0, 7)) return;
      haptic();
      app.ui.spKind = 'month'; app.ui.spAnchor = `${ym}-01`;
      renderSpending(page);
    }));
  }

  const go = (n) => {
    const next = shiftPeriod(p, n);
    if (next.from < first.from || next.from > last.from) return;
    haptic();
    app.ui.spAnchor = next.from;
    renderSpending(page);
  };
  // Swipe left or right on the card to change month, like the Health and Fitness charts.
  const card = page.querySelector('#sp-card');
  let x0 = null, y0 = null;
  card.addEventListener('touchstart', (e) => { if (e.target.closest('svg')) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  card.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) go(dx < 0 ? 1 : -1);
  }, { passive: true });

  page.onclick = async (e) => {
    const step = e.target.closest('[data-step]');
    if (step && !step.disabled) { go(Number(step.dataset.step)); return; }
    const seg = e.target.closest('[data-seg="spKind"] button');
    if (seg) {
      haptic();
      const to = seg.dataset.v;
      // Year → Month opens the month you were looking at (or the latest); Month → Year keeps that year.
      if (to === 'month' && kind === 'year') app.ui.spAnchor = app.ui.spAnchor && app.ui.spAnchor.slice(0, 4) === p.key ? app.ui.spAnchor : (p.key === span[1].slice(0, 4) ? span[1] : `${p.key}-12-01`);
      app.ui.spKind = to;
      renderSpending(page);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'mode') { haptic(); pickMode(page); return; }
    if (act === 'more-cats') { haptic(); app.ui.spAllCats = !app.ui.spAllCats; renderSpending(page); return; }
    if (act === 'periods') { haptic(); pickPeriod(page, kind, first, last, mode); return; }
    if (act === 'all-places') { haptic(); allPlaces(p, name, mode); return; }
    if (act === 'budget') { haptic(); (await import('./budget.js')).openBudget({ ym: p.key }); return; }
    if (act === 'plan') { haptic(); (await import('./budget.js')).openPlanEditor(); return; }
    const cat = e.target.closest('[data-cat]');
    if (cat) { haptic(); openCategory(cat.dataset.cat, { mode, from: p.from, to: p.to, label: name }); return; }
    const mer = e.target.closest('[data-merchant]');
    if (mer) { haptic(); openCategory(null, { mode, merchant: mer.dataset.merchant, from: p.from, to: p.to, label: name }); }
  };
}

/** One category: icon, name, how many purchases and how it compares, then the amount. */
function catRow(r, total, prevBy, prevName, hasPrev, hidden) {
  const before = prevBy.get(r.cat.id) || 0;
  const d = r.cents - before;
  const notable = hasPrev && Math.abs(d) >= Math.max(1000, before * 0.15);
  const change = !hasPrev ? '' : !before ? ` · <span class="up">new vs ${esc(prevName)}</span>` : notable ? ` · <span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${m0(Math.abs(d))} vs ${esc(prevName)}</span>` : '';
  return `<button class="sp-row" data-cat="${esc(r.cat.id)}" ${hidden ? 'hidden' : ''}>
    ${catIcon(r.cat)}
    <span class="main"><span class="title">${esc(r.cat.name)}</span><span class="subtitle">${plural(r.count, 'payment')}${change}</span></span>
    <span class="amt"><span class="value">${money(fromCents(r.cents))}</span><span class="pct">${Math.max(1, Math.round((r.cents / total) * 100))}%</span></span>
  </button>`;
}

function placesBlock(m, p, mode) {
  const places = rangeMerchants(m, p.from, p.to, mode, 5);
  if (!places.length) return '';
  return `<div class="section-head"><h2>Top Places</h2><button class="more link" data-act="all-places">See All</button></div>
    <div class="list">${places.map((x) => `
      <button class="row with-icon tap" data-merchant="${esc(x.name)}">${catIcon(x.cat)}
        <span class="main"><span class="title">${esc(x.name)}</span><span class="subtitle">${plural(x.count, 'visit')}</span></span>
        <span class="value">${money(fromCents(x.cents))}</span>${icon('chev-r', 'chev')}
      </button>`).join('')}</div>`;
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
    <div class="bc-sub">${live && left > 0 && daysLeft > 0 ? `About <b>${m0((left / daysLeft) * 100)}</b> a day for the ${daysLeft} days left. ` : ''}${m0(pm.spent * 100)} of ${m0(t.spend * 100)} budget spent.</div>
  </button>`;
}

function pickMode(page) {
  const sheet = openSheet({
    title: 'What to Count',
    body: `<div class="list" style="margin-top:4px">${[
      ['everyday', 'Everyday spending', 'Day-to-day life. Leaves out tuition, travel, immigration, money sent to people and one-offs.'],
      ['everything', 'All spending', 'Everything that left the account, except moves between your own accounts.'],
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
    title: kind === 'year' ? 'Year' : 'Month',
    body: `<div class="list" style="margin-top:4px">${list.map((p) => `
      <button class="row tap" data-pick="${p.from}">
        <span class="main"><span class="title">${esc(kind === 'year' ? p.key : monthLabel(p.key))}</span></span>
        <span class="detail num">${money(fromCents(rangeSpend(app.model, p.from, p.to, mode).total), { cents: false })}</span>
        ${p.from === app.ui.spAnchor ? `<span style="color:var(--tint)">${icon('check')}</span>` : '<span style="width:17px"></span>'}
      </button>`).join('')}</div>`,
  });
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    haptic();
    app.ui.spAnchor = b.dataset.pick;
    sheet.close();
    renderSpending(page);
  });
}

function allPlaces(p, label, mode) {
  const list = rangeMerchants(app.model, p.from, p.to, mode, 500);
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
    openCategory(null, { mode, merchant: b.dataset.merchant, from: p.from, to: p.to, label });
  });
}
