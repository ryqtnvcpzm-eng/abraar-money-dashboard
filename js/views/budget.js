// Budget: from your take-home pay and savings goal (and a start date). Step through every month:
// activity rings (Saved, Spent, Eating out), budget vs actual per line, and a month-by-month history.
import { app } from '../state.js';
import { money, monthLabel, dateLabel, esc, daysInMonth, iso, monthOf, daysBetween } from '../format.js';
import { planMonths, planMonth, planTargets, planFromTemplate, spendByCategory } from '../ledger.js';
import { icon, catIcon, haptic, openSheet, toast, alertSheet, segmented, layoutSegmented } from '../ui.js';
import { ringsSVG, animateRings, columnChart } from '../charts.js';
import { txnRow, openTxn, openCategory } from './sheets.js';

const RING = {
  saved: ['var(--ring-exercise)', '#92e82a', '#c2ff5a'],
  spent: ['var(--ring-move)', '#fa114f', '#ff5c8a'],
  eating: ['var(--ring-stand)', '#1eeaef', '#7af8ff'],
};
const m0 = (v) => money(v, { cents: false });
const signed0 = (v) => money(v, { cents: false, sign: true });

/** Every month we can show: months with statement data, plus plan months up to today. */
function monthOptions(m) {
  const now = monthOf(iso(new Date()));
  return [...new Set([...m.months, ...planMonths(m).filter((ym) => ym <= now)])].sort();
}
const isFull = (m, ym) => m.statements.some((s) => s.start <= `${ym}-01` && s.end >= `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`);

let redrawBudget = null;

/** The budget: rings, every line against its budget, and month by month. Opens over the app. */
export function openBudget({ ym = null } = {}) {
  const st = { options: [], idx: 0 };
  if (ym) app.ui.planMonth = ym;
  const sheet = openSheet({
    title: 'Budget', size: 'full',
    left: app.model.plan ? '<button class="text-btn" data-act="edit" style="font-weight:400">Edit</button>' : '',
    body: '',
    onClose: () => { redrawBudget = null; },
  });
  const draw = () => {
    if (!sheet.el.isConnected) return;
    sheet.setBody(budgetBody(st));
    layoutSegmented(sheet.el);
    animateRings(sheet.el.querySelector('#rings'));
    const pm = st.history;
    if (pm) drawMetric(sheet.el.querySelector('#plan-chart'), pm, app.ui.planMonth, planTargets(app.model.plan), app.ui.planMetric || 'spent');
  };
  redrawBudget = draw;
  draw();
  const go = (ym) => { app.ui.planMonth = ym; draw(); };
  sheet.el.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="edit"]') || e.target.closest('[data-act="setup"]')) { haptic(); openPlanEditor(); return; }
    if (e.target.closest('[data-act="apply-layout"]')) { haptic(); applyLayout(); return; }
    if (e.target.closest('[data-act="months"]')) { haptic(); pickMonth(st.options, draw); return; }
    const s = e.target.closest('[data-step]');
    if (s && !s.disabled) { haptic(); go(st.options[st.idx + Number(s.dataset.step)]); return; }
    const seg = e.target.closest('[data-seg="planMetric"] button');
    if (seg) { haptic(); app.ui.planMetric = seg.dataset.v; draw(); return; }
    const line = e.target.closest('[data-line]');
    if (line) { haptic(); openLine(line.dataset.line); return; }
    const mo = e.target.closest('[data-month]');
    if (mo) { haptic(); go(mo.dataset.month); sheet.body.scrollTo({ top: 0, behavior: 'smooth' }); }
  });
}

function budgetBody(st) {
  const m = app.model;
  const plan = m.plan;
  st.history = null;
  if (!plan) {
    return `<div class="sheet-hero" style="padding-top:18px"><span class="cat-icon lg" style="--c:var(--green)">${icon('rings')}</span>
      <div class="name">Set up your budget</div>
      <p class="when" style="max-width:340px;margin:8px auto 0">Tell Money your take-home pay and how much you want to save. It splits the rest into a monthly budget and tracks every month: rings, what’s left to spend each day, and how each line is doing.</p></div>
      <div class="btn-row"><button class="btn" data-act="setup">Set Up Budget</button></div>`;
  }
  const t = planTargets(plan);
  const startYm = monthOf(plan.start);
  const today = iso(new Date());
  const started = today >= plan.start;
  const options = monthOptions(m);
  st.options = options;
  if (!app.ui.planMonth || !options.includes(app.ui.planMonth)) {
    // Default: this month once the plan has started, otherwise the latest complete month.
    app.ui.planMonth = started ? options.filter((ym) => ym <= monthOf(today)).pop() : [...options].reverse().find((ym) => isFull(m, ym)) || options[options.length - 1];
  }
  const ym = app.ui.planMonth;
  const idx = options.indexOf(ym);
  st.idx = idx;
  const startsIn = daysBetween(today, plan.start);
  const sub = `<p class="list-foot" style="margin:0 4px 12px;text-align:center">${plan.employer ? `${esc(plan.employer)} · ` : ''}${startsIn > 0 ? `starts ${dateLabel(plan.start, 'long')}` : `since ${dateLabel(plan.start, 'long')}`}</p>`;
  if (!ym) return sub + summaryPills(plan, t) + `<div class="card"><div class="empty"><h3>No data yet</h3><p>${app.account && !app.demo ? 'Connect Gmail or add a statement' : 'Add a statement'} to see your rings.</p></div></div>`;

  const pm = planMonth(m, ym);
  const before = ym < startYm;
  const inProgress = !pm.complete && ym === monthOf(today);
  const lastDay = pm.lastDay ? Number(pm.lastDay.slice(8)) : 0;
  const status = !pm.hasData ? 'No transactions yet' : pm.complete ? (before ? 'Before your plan' : 'Complete') : `Through day ${lastDay} of ${daysInMonth(ym)}`;
  const pct = (a, b) => (b > 0 ? Math.max(0, a / b) : 0);
  const rings = [
    { label: 'Saved', p: pct(pm.saved, t.save), c1: RING.saved[1], c2: RING.saved[2] },
    { label: 'Spent', p: pct(pm.spent, t.spend), c1: RING.spent[1], c2: RING.spent[2] },
    { label: 'Eating out', p: pct(pm.eatingOut, t.eatingOut), c1: RING.eating[1], c2: RING.eating[2] },
  ];
  const history = options.map((x) => planMonth(m, x)).filter((p) => p.hasData || p.ym === ym);
  st.history = history;
  const metric = app.ui.planMetric || 'spent';

  return `${sub}
    <div class="pager">
      <button class="arrow" data-step="-1" aria-label="Previous month" ${idx <= 0 ? 'disabled' : ''}>${icon('chev-l')}</button>
      <button class="lbl" data-act="months" aria-label="Choose month: ${esc(monthLabel(ym))}">${esc(monthLabel(ym))}<small>${esc(status)}</small></button>
      <button class="arrow" data-step="1" aria-label="Next month" ${idx >= options.length - 1 ? 'disabled' : ''}>${icon('chev-r')}</button>
    </div>
    ${before ? `<div class="banner" style="--c:var(--indigo)"><span class="ic">${icon('sparkle')}</span><span class="txt"><b>Before your plan</b><span>Your plan starts ${esc(dateLabel(plan.start, 'long'))}. This shows how ${esc(monthLabel(ym, 'month'))} compares to it.</span></span></div>` : ''}

    <div class="rings-card" id="rings">
      ${ringsSVG(rings)}
      <div class="ring-legend">
        ${ringLine('Saved', pm.saved, t.save, RING.saved[0])}
        ${ringLine('Spent', pm.spent, t.spend, RING.spent[0])}
        ${ringLine('Eating out', pm.eatingOut, t.eatingOut, RING.eating[0])}
      </div>
    </div>
    <p class="note" style="margin:-6px 4px 14px">${verdict(pm, t, inProgress)}</p>

    <div class="stat-grid">
      <div class="tile"><div class="k">Money in</div><div class="v">${m0(pm.income)}</div><div class="s">${before ? 'transfers & more' : 'pay & more'}</div></div>
      <div class="tile"><div class="k">Spent</div><div class="v ${pm.spent > t.spend ? 'neg' : ''}">${m0(pm.spent)}</div><div class="s">of ${m0(t.spend)}</div></div>
      ${!pm.complete && pm.income <= 0
        ? `<div class="tile"><div class="k">Saved</div><div class="v">—</div><div class="s">once pay comes in</div></div>`
        : `<div class="tile"><div class="k">Saved</div><div class="v ${pm.saved >= t.save ? 'pos' : pm.saved < 0 ? 'neg' : ''}">${signed0(pm.saved)}</div><div class="s">${!pm.complete ? 'so far · ' : ''}goal ${m0(t.save)}</div></div>`}
    </div>

    ${layoutOutdated(plan) ? `<div class="banner" style="--c:var(--blue)"><span class="ic">${icon('sparkle')}</span><span class="txt"><b>New budget layout</b><span>${esc(app.rules.planTemplate.lines.slice(0, 3).map((l) => l.name).join(' · '))} and ${app.rules.planTemplate.lines.length - 3} more, with savings first.</span></span><button class="btn small" data-act="apply-layout">Use It</button></div>` : ''}
    <div class="section-head"><h2>Lines</h2><span class="more ${pm.spent > t.spend ? 'neg' : ''}">${m0(pm.spent)} of ${m0(t.spend)}</span></div>
    <div class="list">
      ${budgetRow({ id: '_save', name: 'Investing & Savings', amount: t.save, actual: Math.max(0, pm.saved), savings: true })}
      ${pm.lines.map((l) => budgetRow(l)).join('')}
    </div>
    <p class="list-foot">Tap a line to see it month by month. Savings = money in − spent. Moves between your own accounts are left out.</p>

    <div class="section-head"><h2>Month by Month</h2></div>
    <div class="card">
      ${segmented('planMetric', [['spent', 'Spent'], ['saved', 'Saved'], ['eating', 'Eating out']], metric)}
      <div class="chart-wrap ins-chart" id="plan-chart" style="margin:0"></div>
    </div>
    <div class="list month-table">
      <div class="row mt-head"><span class="main">Month</span><span class="mt-c">Spent<small>/ ${m0(t.spend)}</small></span><span class="mt-c">Saved<small>/ ${m0(t.save)}</small></span></div>
      ${history.slice().reverse().map((p) => `
        <button class="row tap ${p.ym === ym ? 'mt-sel' : ''}" data-month="${p.ym}">
          <span class="main"><span class="title">${esc(monthLabel(p.ym, 'month'))} <span class="muted">${p.ym.slice(0, 4)}</span></span>
            <span class="subtitle">${p.ym < startYm ? 'Before plan' : p.complete ? 'Complete' : 'In progress'}</span></span>
          <span class="mt-c num ${p.spent > t.spend ? 'neg' : ''}">${m0(p.spent)}</span>
          <span class="mt-c num ${p.saved >= t.save ? 'pos' : p.saved < 0 ? 'neg' : ''}">${signed0(p.saved)}</span>
        </button>`).join('')}
      ${history.length > 1 ? (() => {
        const n = history.length;
        const avgSpent = history.reduce((s, p) => s + p.spent, 0) / n;
        const totSaved = history.reduce((s, p) => s + p.saved, 0);
        return `<div class="row mt-foot"><span class="main"><span class="title">Average / total</span><span class="subtitle">${n} months</span></span>
          <span class="mt-c num">${m0(avgSpent)}<small>avg</small></span><span class="mt-c num ${totSaved < 0 ? 'neg' : 'pos'}">${signed0(totSaved)}<small>total</small></span></div>`;
      })() : ''}
    </div>

    ${summaryPills(plan, t)}
    <div class="btn-row"><button class="btn secondary" data-act="edit">Edit Budget</button></div>`;
}

function budgetRow(l) {
  const r = l.amount > 0 ? l.actual / l.amount : (l.actual > 0 ? 2 : 0);
  const color = l.savings ? 'green' : r > 1 ? 'red' : r > 0.85 ? 'orange' : 'green';
  const left = l.amount - l.actual;
  const foot = l.savings
    ? (l.actual >= l.amount ? '<span class="pos">Goal met</span>' : `${m0(left)} to go`)
    : (left >= 0 ? `${m0(left)} left` : `<span class="neg">${m0(-left)} over</span>`);
  return `<button class="row tap budget-row" data-line="${esc(l.id)}">
    <span class="row-top"><span class="title" ${l.savings ? 'style="font-weight:600"' : ''}>${esc(l.name)}</span><span class="value">${m0(l.actual)} <span class="muted">/ ${m0(l.amount)}</span></span></span>
    <span class="bar" role="progressbar" aria-label="${esc(l.name)}" aria-valuemin="0" aria-valuemax="${l.amount}" aria-valuenow="${Math.round(l.actual)}"><i style="--c:var(--${color});width:${Math.min(100, r * 100)}%"></i></span>
    <span class="left">${foot}</span>
  </button>`;
}

function drawMetric(el, history, ym, t, metric) {
  if (!el) return;
  const cfg = {
    spent: { v: (p) => p.spent, ref: { v: t.spend, label: 'Budget' }, color: (p) => (p.spent > t.spend ? 'red' : 'green') },
    saved: { v: (p) => p.saved, ref: { v: t.save, label: 'Goal' }, color: (p) => (p.saved < 0 ? 'red' : 'green') },
    eating: { v: (p) => p.eatingOut, ref: { v: t.eatingOut, label: 'Budget' }, color: (p) => (p.eatingOut > t.eatingOut ? 'red' : 'green') },
  }[metric];
  columnChart(el, history.map((p) => ({ key: p.ym, label: monthLabel(p.ym, 'short'), title: monthLabel(p.ym), v: cfg.v(p), color: cfg.color(p) })),
    { highlight: ym, ref: cfg.ref, readout: (v) => money(v, { cents: false, sign: metric === 'saved' }), refFormat: m0 });
}

function ringLine(k, v, target, color) {
  return `<div><div class="k" style="--c:${color}">${k}</div><div class="v">${m0(Math.max(0, v))}<small>/${m0(target)}</small></div></div>`;
}

function summaryPills(plan, t) {
  return `<div class="plan-pills">
    <div class="card"><div class="k">Take-home</div><div class="v">${m0(plan.takeHome)}</div></div>
    <div class="card"><div class="k">Save ${plan.savePct}%</div><div class="v">${m0(t.save)}</div></div>
    <div class="card"><div class="k">Spend</div><div class="v">${m0(t.spend)}</div></div>
  </div>`;
}

function verdict(pm, t, inProgress) {
  const left = t.spend - pm.spent;
  if (!pm.hasData) return 'Nothing recorded for this month yet.';
  if (inProgress) return left >= 0 ? `${m0(left)} left to spend this month.` : `${m0(-left)} over the spending plan so far.`;
  if (pm.saved < 0) return `Spending was ${m0(-pm.saved)} more than the money that came in.`;
  if (pm.saved >= t.save) return `Savings goal met, ${m0(pm.saved - t.save)} ahead of plan.`;
  if (pm.income === 0) return 'No money came in this month, so the Saved ring stays empty.';
  return `${m0(t.save - pm.saved)} short of the savings goal.`;
}

function pickMonth(options, redraw) {
  const t = planTargets(app.model.plan);
  const sheet = openSheet({
    title: 'Month',
    body: `<div class="list" style="margin-top:4px">${options.slice().reverse().map((o) => {
      const p = planMonth(app.model, o);
      return `<button class="row tap" data-pick="${o}"><span class="main"><span class="title">${esc(monthLabel(o))}</span>
        <span class="subtitle">Spent ${m0(p.spent)} · Saved ${signed0(p.saved)}</span></span>
        ${o === app.ui.planMonth ? `<span style="color:var(--tint)">${icon('check')}</span>` : `<span class="chip ${p.spent > t.spend ? 'bad' : 'ok'}">${p.spent > t.spend ? 'Over' : 'Under'}</span>`}</button>`;
    }).join('')}</div>`,
  });
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    haptic(); app.ui.planMonth = b.dataset.pick; sheet.close(); redraw();
  });
}

// ---------------------------------------------------------------------------
// One budget line, month by month
// ---------------------------------------------------------------------------
function openLine(id) {
  const m = app.model;
  const plan = m.plan;
  const t = planTargets(plan);
  const options = monthOptions(m);
  const ym = app.ui.planMonth;
  const months = options.map((x) => planMonth(m, x)).filter((p) => p.hasData || p.ym === ym);
  const savings = id === '_save';
  const line = savings ? { id, name: 'Investing & Savings', amount: t.save, categories: [] } : plan.lines.find((l) => l.id === id);
  if (!line) return;
  const val = (p) => (savings ? p.saved : p.lines.find((l) => l.id === id)?.actual || 0);
  const vals = months.map(val);
  const n = Math.max(1, months.length);
  const avg = vals.reduce((a, b) => a + b, 0) / n;
  const okCount = vals.filter((v) => (savings ? v >= line.amount : v <= line.amount)).length;
  const cur = months.find((p) => p.ym === ym);
  const curV = cur ? val(cur) : 0;

  // What's inside this line for the selected month
  const catchAll = line.categories.includes('*');
  const assigned = new Set(plan.lines.flatMap((l) => l.categories));
  const inLine = (txn) => txn.cat.type === 'spend' && (line.categories.includes(txn.cat.id) || (catchAll && !assigned.has(txn.cat.id)));
  const from = cur?.from || `${ym}-01`;
  const monthTx = m.txns.filter((x) => x.month === ym && x.date >= from && !x.netted && (savings ? false : inLine(x)));
  const cats = savings ? [] : spendByCategory(monthTx, 'everything');
  const total = cats.reduce((s, r) => s + r.cents, 0) || 1;

  const sheet = openSheet({
    title: line.name, size: 'full',
    body: `
      <div class="ins-hero">
        <div class="kicker" style="--c:var(--${savings ? 'green' : 'blue'})">${icon(savings ? 'rings' : 'spending')}${esc(monthLabel(ym))}</div>
        <h1>${savings ? signed0(curV) : m0(curV)} <span class="muted" style="font-weight:600;font-size:20px">of ${m0(line.amount)}</span></h1>
        <p>${savings
          ? (curV >= line.amount ? `Goal met with ${m0(curV - line.amount)} to spare.` : `${m0(line.amount - curV)} short of the goal.`)
          : (curV <= line.amount ? `${m0(line.amount - curV)} left in this line.` : `${m0(curV - line.amount)} over this line.`)}
          ${catchAll ? ' Other catches every category that has no line of its own.' : ''}</p>
      </div>
      <div class="card ins-card"><div class="card-title">${esc(line.name)} by month</div><div class="chart-wrap ins-chart" id="line-chart" style="margin:0"></div></div>
      <div class="stat-grid">
        <div class="tile"><div class="k">Average</div><div class="v">${savings ? signed0(avg) : m0(avg)}</div><div class="s">per month</div></div>
        <div class="tile"><div class="k">${savings ? 'Goal met' : 'Within budget'}</div><div class="v">${okCount} of ${months.length}</div><div class="s">months</div></div>
        <div class="tile"><div class="k">${savings ? 'Goal' : 'Budget'}</div><div class="v">${m0(line.amount)}</div><div class="s">per month</div></div>
      </div>
      <div class="list-head"><span>Every month</span></div>
      <div class="list">${months.slice().reverse().map((p) => {
        const v = val(p);
        const d = savings ? v - line.amount : line.amount - v;
        return `<div class="row ${p.ym === ym ? 'mt-sel' : ''}"><span class="main"><span class="title">${esc(monthLabel(p.ym))}</span></span>
          <span><span class="value">${savings ? signed0(v) : m0(v)}</span><span class="value-sub ${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? (savings ? `${m0(d)} ahead` : `${m0(d)} left`) : (savings ? `${m0(-d)} short` : `${m0(-d)} over`)}</span></span></div>`;
      }).join('')}</div>
      ${savings ? `<div class="list-head"><span>${esc(monthLabel(ym))}</span></div><div class="list">
        <div class="row"><span class="main"><span class="title">Money in</span></span><span class="value">${m0(cur?.income || 0)}</span></div>
        <div class="row"><span class="main"><span class="title">Spent</span></span><span class="value">−${m0(cur?.spent || 0)}</span></div>
        <div class="row"><span class="main"><span class="title" style="font-weight:600">Saved</span></span><span class="value" style="font-weight:600">${signed0(curV)}</span></div></div>` : `
      ${cats.length > 1 ? `<div class="list-head"><span>What’s in it · ${esc(monthLabel(ym, 'month'))}</span></div>
      <div class="list">${cats.map((r) => `<button class="row with-icon tap" data-cat="${esc(r.cat.id)}">${catIcon(r.cat)}
        <span class="main"><span class="title">${esc(r.cat.name)}</span><span class="subtitle">${Math.round((r.cents / total) * 100)}%</span></span>
        <span class="value">${money(r.cents / 100)}</span>${icon('chev-r', 'chev')}</button>`).join('')}</div>` : ''}
      <div class="list-head"><span>Transactions · ${esc(monthLabel(ym, 'month'))}</span></div>
      <div class="list">${monthTx.slice().reverse().map((x) => txnRow(x, { showDate: true })).join('') || '<div class="empty" style="padding:24px">Nothing in this line this month.</div>'}</div>`}`,
  });
  (() => columnChart(sheet.el.querySelector('#line-chart'),
    months.map((p, i) => ({ key: p.ym, label: monthLabel(p.ym, 'short'), title: monthLabel(p.ym), v: vals[i],
      color: savings ? (vals[i] < 0 ? 'red' : 'green') : vals[i] > line.amount ? 'red' : 'green' })),
    { highlight: ym, ref: { v: line.amount, label: savings ? 'Goal' : 'Budget' }, readout: (v) => money(v, { cents: false, sign: savings }), refFormat: m0 }));
  sheet.el.addEventListener('click', (e) => {
    const tx = e.target.closest('[data-txn]');
    if (tx) { haptic(); openTxn(tx.dataset.txn); return; }
    const c = e.target.closest('[data-cat]');
    if (c) { haptic(); openCategory(c.dataset.cat, { ym, mode: 'everything' }); }
  });
}

// ---------------------------------------------------------------------------
// Plan editor
// ---------------------------------------------------------------------------
export function openPlanEditor() {
  const existing = app.vault.plan;
  let draft = existing ? structuredClone(existing) : null;
  const sheet = openSheet({
    title: existing ? 'Edit Budget' : 'Set Up Budget', size: 'full',
    left: `<button class="text-btn" data-close style="font-weight:400">Cancel</button>`,
    right: `<button class="text-btn" data-act="save">Save</button>`,
    body: '',
  });
  const v = (sel) => sheet.el.querySelector(sel);
  const draw = () => {
    const d = draft || { employer: '', start: '', takeHome: '', savePct: 65, lines: [] };
    const take = Number(d.takeHome) || 0;
    const save = Math.round(take * d.savePct / 100);
    const spend = Math.round(take - save);
    const sum = (d.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
    sheet.setBody(`
      <div class="list-head"><span>Job</span></div>
      <div class="list">
        <label class="row"><span class="main"><span class="title">Employer</span></span><input class="inline" id="pe-emp" value="${esc(d.employer || '')}" placeholder="Optional" autocomplete="off"></label>
        <label class="row"><span class="main"><span class="title">Start date</span></span><input class="inline" type="date" id="pe-start" value="${esc(d.start || '')}" required></label>
      </div>
      <div class="list-head"><span>Money</span></div>
      <div class="list">
        <label class="row"><span class="main"><span class="title">Take-home pay</span></span><input class="inline num" inputmode="decimal" id="pe-take" value="${d.takeHome || ''}" placeholder="0"></label>
        <div class="row" style="display:block">
          <div class="row-top" style="display:flex;justify-content:space-between"><span class="title">Save</span><span class="value" id="pe-pct-l">${d.savePct}%</span></div>
          <input type="range" id="pe-pct" min="0" max="90" step="1" value="${d.savePct}" style="width:100%;margin:10px 0 2px;accent-color:var(--green)" aria-label="Savings percentage">
        </div>
        <div class="row"><span class="main"><span class="title">Saved each month</span></span><span class="detail num pos" id="pe-save">${money(save, { cents: false })}</span></div>
        <div class="row"><span class="main"><span class="title">Left to spend</span></span><span class="detail num" id="pe-spend">${money(spend, { cents: false })}</span></div>
      </div>
      ${d.lines?.length ? `
      <div class="list-head"><span>Spending budget</span><span id="pe-sum" class="${sum === spend ? '' : 'neg'}">${money(sum, { cents: false })} of ${money(spend, { cents: false })}</span></div>
      <div class="list">${d.lines.map((l, i) => `
        <label class="row"><span class="main"><span class="title">${esc(l.name)}</span><span class="subtitle">${esc(l.categories.map((c) => (c === '*' ? 'everything else' : app.model.cats.get(c)?.name || c)).join(', '))}</span></span>
          <input class="inline num" inputmode="decimal" data-line="${i}" value="${l.amount}" aria-label="${esc(l.name)} budget"></label>`).join('')}
      </div>
      <div class="btn-row"><button class="btn secondary" data-act="resplit" id="pe-resplit">Use the suggested budget for ${money(spend, { cents: false })}</button></div>`
      : `<p class="list-foot">After you enter your take-home pay, Money suggests a split of the spending budget that you can adjust.</p>`}
      <p class="list-foot">Your plan is stored inside the encrypted vault, never in the public code.</p>`);
  };
  const read = () => {
    const d = draft || { employer: '', start: '', takeHome: 0, savePct: 65, lines: [] };
    d.employer = v('#pe-emp').value.trim();
    d.start = v('#pe-start').value;
    d.takeHome = Number(String(v('#pe-take').value).replace(/[^\d.]/g, '')) || 0;
    d.savePct = Number(v('#pe-pct').value);
    sheet.el.querySelectorAll('[data-line]').forEach((inp) => { d.lines[+inp.dataset.line].amount = Number(String(inp.value).replace(/[^\d.]/g, '')) || 0; });
    if (!d.lines.length && d.takeHome > 0) {
      const p = planFromTemplate(app.rules, d);
      d.lines = p.lines; d.eatingOut = p.eatingOut;
    }
    d.eatingOut ||= [...app.rules.planTemplate.eatingOut];
    draft = d;
  };
  /** Update the worked-out numbers in place, so the field you're in keeps focus (and the slider keeps moving). */
  const refresh = () => {
    const d = draft;
    const save = Math.round((Number(d.takeHome) || 0) * d.savePct / 100);
    const spend = Math.round((Number(d.takeHome) || 0) - save);
    const sum = (d.lines || []).reduce((t, l) => t + (Number(l.amount) || 0), 0);
    v('#pe-pct-l').textContent = `${d.savePct}%`;
    v('#pe-save').textContent = money(save, { cents: false });
    v('#pe-spend').textContent = money(spend, { cents: false });
    const sumEl = v('#pe-sum');
    if (sumEl) { sumEl.textContent = `${money(sum, { cents: false })} of ${money(spend, { cents: false })}`; sumEl.className = sum === spend ? '' : 'neg'; }
    const rs = v('#pe-resplit');
    if (rs) rs.textContent = `Use the suggested budget for ${money(spend, { cents: false })}`;
  };
  const update = () => {
    const before = draft?.lines?.length || 0;
    read();
    if ((draft.lines?.length || 0) !== before) {
      // The budget lines just appeared: redraw, then put focus back where it was.
      const at = document.activeElement;
      const sel = at?.id ? `#${at.id}` : at?.dataset?.line != null ? `[data-line="${at.dataset.line}"]` : null;
      draw();
      if (sel) v(sel)?.focus();
    } else refresh();
  };
  draw();
  sheet.el.addEventListener('input', (e) => {
    if (e.target.id === 'pe-pct' || e.target.dataset.line != null) update();
  });
  sheet.el.addEventListener('change', (e) => {
    if (['pe-take', 'pe-pct'].includes(e.target.id) || e.target.dataset.line != null) update();
  });
  sheet.el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'resplit') {
      read();
      const p = planFromTemplate(app.rules, draft);
      draft.lines = p.lines;
      haptic(); draw();
    }
    if (act === 'save') {
      read();
      if (!draft.start || !draft.takeHome) { toast('Add a start date and take-home pay', { icon: 'warn', color: 'orange' }); return; }
      haptic();
      app.vault.plan = draft;
      app.ui.planMonth = null;
      sheet.close();
      await app.commit({ silent: true });
      toast('Budget saved');
      redrawBudget?.();
    }
  });
}

/** The saved plan uses older budget lines than data/rules.json suggests. */
function layoutOutdated(plan) {
  const want = app.rules.planTemplate.lines.map((l) => l.id).join(',');
  return plan.lines.map((l) => l.id).join(',') !== want;
}

async function applyLayout() {
  const old = app.vault.plan;
  const next = planFromTemplate(app.rules, { employer: old.employer, start: old.start, takeHome: old.takeHome, savePct: old.savePct });
  const ok = await alertSheet({
    title: 'Use the new budget layout?',
    message: next.lines.map((l) => `${l.name} ${money(l.amount, { cents: false })}`).join(' · '),
    actions: [{ label: 'Use It', value: true, style: 'primary' }, { label: 'Cancel', value: false, style: 'cancel' }],
  });
  if (!ok) return;
  app.vault.plan = next;
  await app.commit({ silent: true });
  toast('Budget updated');
  redrawBudget?.();
}
