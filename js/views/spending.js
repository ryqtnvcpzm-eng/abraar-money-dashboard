// Spending: month picker, Everyday/Everything, categories, monthly stacked chart, top merchants.
import { app } from '../state.js';
import { money, monthLabel, esc, fromCents, plural } from '../format.js';
import { spendByCategory, monthTxns, monthlySpend, topMerchants } from '../ledger.js';
import { icon, catIcon, pageFrame, wireLargeTitle, haptic, segmented, layoutSegmented, openSheet } from '../ui.js';
import { stackedColumns } from '../charts.js';
import { openCategory } from './sheets.js';

export function renderSpending(page) {
  const m = app.model;
  if (!m.months.length) {
    page.innerHTML = pageFrame({ title: 'Spending', body: `<div class="card"><div class="empty"><div class="ic">${icon('spending')}</div><h3>No spending yet</h3><p>Add a statement to see where your money goes.</p></div></div>` });
    wireLargeTitle(page);
    return;
  }
  const options = ['all', ...m.months];
  if (!app.ui.month || !options.includes(app.ui.month)) app.ui.month = m.months[m.months.length - 1];
  const ym = app.ui.month;
  const mode = app.ui.mode;
  const idx = options.indexOf(ym);

  const txns = monthTxns(m, ym);
  const rows = spendByCategory(txns, mode);
  const total = rows.reduce((s, r) => s + r.cents, 0);
  const series = monthlySpend(m, mode);
  const avg = series.length ? series.reduce((s, x) => s + x.total, 0) / series.length : 0;
  const order = stackOrder(series);
  const merchants = topMerchants(txns, mode, 8);
  const label = ym === 'all' ? 'All Months' : monthLabel(ym);
  const sublabel = ym === 'all' ? `${monthLabel(m.months[0], 'shortYear')} – ${monthLabel(m.months[m.months.length - 1], 'shortYear')}` : `${plural(txns.filter((t) => t.c < 0).length, 'payment')}`;

  let cmp = '';
  if (ym === 'all') cmp = `Per month<b>${money(fromCents(avg), { cents: false })}</b>`;
  else {
    const d = total - avg;
    cmp = `vs average<b class="${d > 0 ? 'neg' : 'pos'}">${d > 0 ? '+' : '−'}${money(Math.abs(fromCents(d)), { cents: false })}</b>`;
  }

  const stack = [];
  let other = 0;
  for (const r of rows) { if (order.includes(r.cat.id)) stack.push(r); else other += r.cents; }
  stack.sort((a, b) => order.indexOf(a.cat.id) - order.indexOf(b.cat.id));

  const body = `
    <div class="pager">
      <button class="arrow" data-step="-1" aria-label="Previous" ${idx <= 0 ? 'disabled' : ''}>${icon('chev-l')}</button>
      <button class="lbl" data-act="months" aria-label="Choose month: ${esc(label)}">${esc(label)}<small>${esc(sublabel)}</small></button>
      <button class="arrow" data-step="1" aria-label="Next" ${idx >= options.length - 1 ? 'disabled' : ''}>${icon('chev-r')}</button>
    </div>
    ${segmented('mode', [['everyday', 'Everyday'], ['everything', 'Everything']], mode)}
    <div class="card">
      <div class="spent-head">
        <div><div class="k">${mode === 'everyday' ? 'Everyday spending' : 'All spending'}</div><div class="big">${money(fromCents(total))}</div></div>
        <div class="cmp">${cmp}</div>
      </div>
      <div class="stackbar" role="img" aria-label="${esc(rows.map((r) => `${r.cat.name} ${money(fromCents(r.cents))}`).join(', '))}">
        ${stack.map((r, i) => `<i style="--c:var(--${r.cat.color});width:${(r.cents / total) * 100}%;animation-delay:${i * 40}ms"></i>`).join('')}
        ${other > 0 ? `<i style="--c:var(--gray);width:${(other / total) * 100}%"></i>` : ''}
      </div>
      <p class="note" style="margin:8px 0 0">${mode === 'everyday' ? 'Leaves out tuition, travel, immigration, money sent to people and anything you mark as a one-off.' : 'Everything that left the account except moves between your own accounts. Reversals are netted out.'}</p>
    </div>
    <div class="list">
      ${rows.length ? rows.map((r) => `
        <button class="row with-icon tap" data-cat="${esc(r.cat.id)}">
          ${catIcon(r.cat)}
          <span class="main"><span class="title">${esc(r.cat.name)}</span>
            <span class="subtitle">${plural(r.count, 'payment')} · ${Math.round((r.cents / total) * 100)}%</span>
            <span class="pctbar"><i style="--c:var(--${r.cat.color});width:${Math.max(2, (r.cents / rows[0].cents) * 100)}%"></i></span></span>
          <span class="value">${money(fromCents(r.cents))}</span>${icon('chev-r', 'chev')}
        </button>`).join('') : '<div class="empty">Nothing spent here.</div>'}
    </div>

    <div class="section-head"><h2>By Month</h2></div>
    <div class="card">
      <div class="chart-wrap" id="sp-chart" style="cursor:pointer;touch-action:auto"></div>
      <div class="legend">${order.map((id) => { const c = m.cats.get(id); return `<span><i style="--c:var(--${c.color})"></i>${esc(c.name)}</span>`; }).join('')}<span><i style="--c:var(--gray)"></i>Other</span></div>
      <p class="note" style="margin:10px 0 0">Tap a month to open it.</p>
    </div>

    <div class="section-head"><h2>Top Merchants</h2></div>
    <div class="list">
      ${merchants.length ? merchants.map((x, i) => `
        <button class="row tap" data-merchant="${esc(x.name)}">
          <span class="rank">${i + 1}</span>${catIcon(x.cat, 'sm')}
          <span class="main"><span class="title">${esc(x.name)}</span><span class="subtitle">${esc(x.cat.name)}</span></span>
          <span><span class="value">${money(fromCents(x.cents))}</span><span class="value-sub">×${x.count} ${x.count === 1 ? 'visit' : 'visits'}</span></span>
        </button>`).join('') : '<div class="empty">No merchants yet.</div>'}
    </div>`;

  page.innerHTML = pageFrame({ title: 'Spending', body });
  wireLargeTitle(page);
  layoutSegmented(page);
  stackedColumns(page.querySelector('#sp-chart'), series, {
    order, cats: m.cats, selected: ym,
    onSelect: (v) => { app.ui.month = app.ui.month === v ? 'all' : v; renderSpending(page); },
  });

  page.onclick = (e) => {
    const step = e.target.closest('[data-step]');
    if (step && !step.disabled) { haptic(); app.ui.month = options[idx + Number(step.dataset.step)]; renderSpending(page); return; }
    const seg = e.target.closest('[data-seg="mode"] button');
    if (seg) { haptic(); app.ui.mode = seg.dataset.v; renderSpending(page); return; }
    const cat = e.target.closest('[data-cat]');
    if (cat) { haptic(); openCategory(cat.dataset.cat, { ym, mode }); return; }
    const mer = e.target.closest('[data-merchant]');
    if (mer) { haptic(); openCategory(null, { ym, mode, merchant: mer.dataset.merchant }); return; }
    if (e.target.closest('[data-act="months"]')) { haptic(); pickMonth(options, series, page); }
  };
}

/** Up to six categories with distinct colors get their own stack segment; the rest fold into Other. */
function stackOrder(series) {
  const totals = new Map();
  for (const mth of series) for (const r of mth.rows) totals.set(r.cat.id, (totals.get(r.cat.id) || { cat: r.cat, cents: 0 }));
  for (const mth of series) for (const r of mth.rows) totals.get(r.cat.id).cents += r.cents;
  const used = new Set(['gray']);
  const order = [];
  for (const { cat } of [...totals.values()].sort((a, b) => b.cents - a.cents)) {
    if (order.length >= 6 || used.has(cat.color)) continue;
    used.add(cat.color);
    order.push(cat.id);
  }
  return order;
}

function pickMonth(options, series, page) {
  const totals = new Map(series.map((s) => [s.ym, s.total]));
  const sheet = openSheet({
    title: 'Month',
    body: `<div class="list" style="margin-top:4px">${options.slice().reverse().map((o) => `
      <button class="row tap" data-pick="${o}">
        <span class="main"><span class="title">${o === 'all' ? 'All Months' : monthLabel(o)}</span></span>
        <span class="detail num">${o === 'all' ? '' : money(fromCents(totals.get(o) || 0), { cents: false })}</span>
        ${o === app.ui.month ? `<span style="color:var(--tint)">${icon('check')}</span>` : '<span style="width:17px"></span>'}
      </button>`).join('')}</div>`,
  });
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    haptic();
    app.ui.month = b.dataset.pick;
    sheet.close();
    renderSpending(page);
  });
}
