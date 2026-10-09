// Plan: budget from the new job's start date. Activity rings (Saved, Spent, Eating out) and budget vs actual.
import { app } from '../state.js';
import { money, monthLabel, dateLabel, esc, daysInMonth, iso, monthOf, daysBetween } from '../format.js';
import { planMonths, planMonth, planTargets, planFromTemplate } from '../ledger.js';
import { icon, pageFrame, wireLargeTitle, haptic, openSheet, toast, alertSheet } from '../ui.js';
import { ringsSVG, animateRings } from '../charts.js';

const RING = {
  saved: ['var(--ring-exercise)', '#92e82a', '#c2ff5a'],
  spent: ['var(--ring-move)', '#fa114f', '#ff5c8a'],
  eating: ['var(--ring-stand)', '#1eeaef', '#7af8ff'],
};

export function renderPlan(page) {
  const m = app.model;
  const plan = m.plan;
  if (!plan) {
    page.innerHTML = pageFrame({ title: 'Plan', body: `<div class="card"><div class="empty">
      <div class="ic">${icon('rings')}</div><h3>Set up your budget</h3>
      <p>Tell Money your take-home pay and how much you want to save. It tracks every month from your start date.</p>
      <button class="btn" data-act="edit" style="max-width:260px">Set Up Plan</button></div></div>` });
    wireLargeTitle(page);
    page.onclick = (e) => { if (e.target.closest('[data-act="edit"]')) { haptic(); openPlanEditor(); } };
    return;
  }

  const t = planTargets(plan);
  const months = planMonths(m).filter((ym) => ym <= monthOf(iso(new Date())) || m.months.includes(ym));
  const withData = months.filter((ym) => m.months.includes(ym));
  const preview = withData.length === 0;
  // Before the plan starts, preview it against the latest full month of real data.
  const previewYm = [...m.months].reverse().find((ym) => m.statements.some((s) => s.end >= `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`)) || m.months[m.months.length - 1];
  const options = preview ? (previewYm ? [previewYm] : []) : withData;
  if (!app.ui.planMonth || !options.includes(app.ui.planMonth)) app.ui.planMonth = options[options.length - 1];
  const ym = app.ui.planMonth;
  const idx = options.indexOf(ym);
  const startsIn = daysBetween(iso(new Date()), plan.start);

  const right = `<button class="glass-btn wide tint" data-act="edit">Edit</button>`;
  const sub = `${plan.employer ? `${esc(plan.employer)} · ` : ''}${startsIn > 0 ? `starts ${dateLabel(plan.start, 'long')}` : `since ${dateLabel(plan.start, 'long')}`}`;

  if (!ym) {
    page.innerHTML = pageFrame({ title: 'Plan', sub, right, body: summaryPills(plan, t) + `<div class="card"><div class="empty"><h3>No data yet</h3><p>Add a statement to see your rings.</p></div></div>` });
    wire(page);
    return;
  }

  const pm = planMonth(m, ym);
  const pct = (a, b) => (b > 0 ? Math.max(0, a / b) : 0);
  const rings = [
    { label: 'Saved', p: pct(pm.saved, t.save), c1: RING.saved[1], c2: RING.saved[2] },
    { label: 'Spent', p: pct(pm.spent, t.spend), c1: RING.spent[1], c2: RING.spent[2] },
    { label: 'Eating out', p: pct(pm.eatingOut, t.eatingOut), c1: RING.eating[1], c2: RING.eating[2] },
  ];
  const isCurrent = ym === monthOf(iso(new Date()));
  const lastDay = pm.lastDay ? Number(pm.lastDay.slice(8)) : 0;

  const body = `
    ${preview ? `<div class="banner" style="--c:var(--indigo)"><span class="ic">${icon('sparkle')}</span><span class="txt"><b>Preview with ${esc(monthLabel(ym, 'month'))}</b><span>Your plan starts ${esc(dateLabel(plan.start, 'long'))}. This is how ${esc(monthLabel(ym, 'month'))} would have looked.</span></span></div>` : ''}
    ${options.length > 1 ? `<div class="pager">
      <button class="arrow" data-step="-1" aria-label="Previous month" ${idx <= 0 ? 'disabled' : ''}>${icon('chev-l')}</button>
      <div class="lbl">${esc(monthLabel(ym))}<small>${pm.complete ? 'Complete' : `Through day ${lastDay} of ${daysInMonth(ym)}`}</small></div>
      <button class="arrow" data-step="1" aria-label="Next month" ${idx >= options.length - 1 ? 'disabled' : ''}>${icon('chev-r')}</button></div>` : `<h2 class="t-title3" style="margin:0 4px 12px">${esc(monthLabel(ym))}${!preview && !pm.complete ? ` <span class="muted t-sub">· through day ${lastDay}</span>` : ''}</h2>`}

    <div class="rings-card" id="rings">
      ${ringsSVG(rings)}
      <div class="ring-legend">
        ${ringLine('Saved', pm.saved, t.save, RING.saved[0])}
        ${ringLine('Spent', pm.spent, t.spend, RING.spent[0])}
        ${ringLine('Eating out', pm.eatingOut, t.eatingOut, RING.eating[0])}
      </div>
    </div>
    <p class="note" style="margin:-6px 4px 14px">${verdict(pm, t, isCurrent && !pm.complete)}</p>

    ${summaryPills(plan, t)}

    ${layoutOutdated(plan) ? `<div class="banner" style="--c:var(--blue)"><span class="ic">${icon('sparkle')}</span><span class="txt"><b>New budget layout</b><span>${esc(app.rules.planTemplate.lines.slice(0, 3).map((l) => l.name).join(' · '))} and ${app.rules.planTemplate.lines.length - 3} more, with savings first.</span></span><button class="btn small" data-act="apply-layout">Use It</button></div>` : ''}
    <div class="section-head"><h2>Budget</h2><span class="more ${pm.spent > t.spend ? 'neg' : ''}">${money(pm.spent, { cents: false })} of ${money(t.spend, { cents: false })}</span></div>
    <div class="list">
      ${(() => {
        // Pay yourself first: investing & savings sits above every spending line.
        const r = t.save > 0 ? Math.max(0, pm.saved) / t.save : 0;
        return `<div class="row budget-row" style="display:block">
          <div class="row-top"><span class="title" style="font-weight:600">Investing &amp; Savings</span><span class="value">${money(Math.max(0, pm.saved), { cents: false })} <span class="muted">/ ${money(t.save, { cents: false })}</span></span></div>
          <div class="bar" role="progressbar" aria-label="Investing and savings" aria-valuemin="0" aria-valuemax="${t.save}" aria-valuenow="${Math.round(Math.max(0, pm.saved))}"><i style="--c:var(--green);width:${Math.min(100, r * 100)}%"></i></div>
          <div class="left" style="margin-top:6px">${pm.saved >= t.save ? '<span class="pos">Goal met</span>' : `${money(t.save - Math.max(0, pm.saved), { cents: false })} to go`}</div>
        </div>`;
      })()}
      ${pm.lines.map((l) => {
        const r = l.amount > 0 ? l.actual / l.amount : (l.actual > 0 ? 2 : 0);
        const color = r > 1 ? 'red' : r > 0.85 ? 'orange' : 'green';
        const left = l.amount - l.actual;
        return `<div class="row budget-row" style="display:block">
          <div class="row-top"><span class="title">${esc(l.name)}</span><span class="value">${money(l.actual, { cents: false })} <span class="muted">/ ${money(l.amount, { cents: false })}</span></span></div>
          <div class="bar" role="progressbar" aria-label="${esc(l.name)}" aria-valuemin="0" aria-valuemax="${l.amount}" aria-valuenow="${Math.round(l.actual)}"><i style="--c:var(--${color});width:${Math.min(100, r * 100)}%"></i></div>
          <div class="left" style="margin-top:6px">${left >= 0 ? `${money(left, { cents: false })} left` : `<span class="neg">${money(-left, { cents: false })} over</span>`}</div>
        </div>`;
      }).join('')}
    </div>
    <p class="list-foot">Money in counts paycheques, money received and interest. Moves between your own accounts are left out.</p>

    ${!preview && withData.length > 1 ? `<div class="section-head"><h2>History</h2></div><div class="list">${withData.slice().reverse().map((x) => {
      const p = planMonth(m, x);
      const ok = p.saved >= t.save;
      return `<button class="row tap" data-month="${x}"><span class="main"><span class="title">${esc(monthLabel(x))}</span><span class="subtitle">Spent ${money(p.spent, { cents: false })}</span></span>
        <span class="chip ${ok ? 'ok' : p.complete ? 'warn' : ''}">Saved ${money(p.saved, { cents: false })}</span></button>`;
    }).join('')}</div>` : ''}`;

  page.innerHTML = pageFrame({ title: 'Plan', sub, right, body });
  wire(page, options, idx);
  animateRings(page.querySelector('#rings'));
}

function ringLine(k, v, target, color) {
  return `<div><div class="k" style="--c:${color}">${k}</div><div class="v">${money(Math.max(0, v), { cents: false })}<small>/${money(target, { cents: false })}</small></div></div>`;
}

function summaryPills(plan, t) {
  return `<div class="plan-pills">
    <div class="card"><div class="k">Take-home</div><div class="v">${money(plan.takeHome, { cents: false })}</div></div>
    <div class="card"><div class="k">Save ${plan.savePct}%</div><div class="v">${money(t.save, { cents: false })}</div></div>
    <div class="card"><div class="k">Spend</div><div class="v">${money(t.spend, { cents: false })}</div></div>
  </div>`;
}

function verdict(pm, t, inProgress) {
  const left = t.spend - pm.spent;
  if (inProgress) return left >= 0 ? `${money(left, { cents: false })} left to spend this month.` : `${money(-left, { cents: false })} over the spending plan so far.`;
  if (pm.saved < 0) return `Spending was ${money(-pm.saved, { cents: false })} more than the money that came in.`;
  if (pm.saved >= t.save) return `Savings goal closed — ${money(pm.saved - t.save, { cents: false })} ahead of plan.`;
  if (pm.income === 0) return 'No paycheque landed in this month, so the Saved ring stays empty.';
  return `${money(t.save - pm.saved, { cents: false })} short of the savings goal.`;
}

function wire(page, options = [], idx = 0) {
  wireLargeTitle(page);
  page.onclick = (e) => {
    if (e.target.closest('[data-act="edit"]')) { haptic(); openPlanEditor(); return; }
    if (e.target.closest('[data-act="apply-layout"]')) { haptic(); applyLayout(); return; }
    const s = e.target.closest('[data-step]');
    if (s && !s.disabled) { haptic(); app.ui.planMonth = options[idx + Number(s.dataset.step)]; renderPlan(page); return; }
    const mo = e.target.closest('[data-month]');
    if (mo) { haptic(); app.ui.planMonth = mo.dataset.month; renderPlan(page); page.querySelector('.scroller').scrollTo({ top: 0, behavior: 'smooth' }); }
  };
}

// ---------------------------------------------------------------------------
// Plan editor
// ---------------------------------------------------------------------------
export function openPlanEditor() {
  const existing = app.vault.plan;
  let draft = existing ? structuredClone(existing) : null;
  const sheet = openSheet({
    title: existing ? 'Edit Plan' : 'Set Up Plan', size: 'full',
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
        <div class="row"><span class="main"><span class="title">Saved each month</span></span><span class="detail num pos">${money(save, { cents: false })}</span></div>
        <div class="row"><span class="main"><span class="title">Left to spend</span></span><span class="detail num">${money(spend, { cents: false })}</span></div>
      </div>
      ${d.lines?.length ? `
      <div class="list-head"><span>Spending budget</span><span class="${sum === spend ? '' : 'neg'}">${money(sum, { cents: false })} of ${money(spend, { cents: false })}</span></div>
      <div class="list">${d.lines.map((l, i) => `
        <label class="row"><span class="main"><span class="title">${esc(l.name)}</span><span class="subtitle">${esc(l.categories.map((c) => (c === '*' ? 'everything else' : app.model.cats.get(c)?.name || c)).join(', '))}</span></span>
          <input class="inline num" inputmode="decimal" data-line="${i}" value="${l.amount}" aria-label="${esc(l.name)} budget"></label>`).join('')}
      </div>
      <div class="btn-row"><button class="btn secondary" data-act="resplit">Use the suggested budget for ${money(spend, { cents: false })}</button></div>`
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
  draw();
  sheet.el.addEventListener('input', (e) => {
    if (e.target.id === 'pe-pct') { v('#pe-pct-l').textContent = `${e.target.value}%`; }
  });
  sheet.el.addEventListener('change', (e) => {
    if (['pe-take', 'pe-pct'].includes(e.target.id) || e.target.dataset.line != null) { read(); draw(); }
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
      toast('Plan saved');
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
  toast('Budget updated. Save to GitHub to sync.');
}
