// Summary (like the Health app): balance with a scrubbable chart, this month at a glance with the budget rings,
// highlights from your data, bills coming up, and your statements and bank.
import { app } from '../state.js';
import { money, dateLabel, esc, fromCents, addDays, plural, monthLabel, iso, daysInMonth, monthOf } from '../format.js';
import { dailyBalance, flow, insights, currentBalance, planMonth, planTargets } from '../ledger.js';
import { upcoming, pace, dataEnd, fullMonths } from '../analysis.js';
import { rangeSpend } from '../period.js';
import { uncategorized } from './teach.js';
import { icon, pageFrame, wireLargeTitle, haptic, openSheet } from '../ui.js';
import { balanceChart, ringsSVG, animateRings } from '../charts.js';

const RANGES = [['1M', 30], ['3M', 91], ['6M', 182], ['YTD', 'ytd'], ['ALL', 'all']];

export function renderOverview(page) {
  const m = app.model;
  const daily = dailyBalance(m).map((d) => ({ date: d.date, bal: fromCents(d.bal) }));
  const bal = currentBalance(m);
  const who = (app.account || (app.demo ? 'sample' : 'me')).replace(/[^a-z0-9]/gi, '').slice(0, 1).toUpperCase() || 'M';
  const right = `
    <button class="glass-btn" data-act="add" aria-label="Add statement">${icon('plus')}</button>
    <button class="avatar-btn" data-act="settings" aria-label="Settings">${esc(who)}${app.isDirty() ? '<span class="badge-dot"></span>' : ''}</button>`;
  const sub = esc(new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }));

  if (!bal) {
    page.innerHTML = pageFrame({ title: 'Summary', sub, right, body: emptyState() });
    wire(page);
    return;
  }

  const bad = m.statements.filter((s) => s.reconciled === false).length;
  const unchecked = m.statements.filter((s) => s.reconciled == null).length;
  const body = `
    ${banners()}
    <section class="hero" aria-label="Balance">
      <div class="eyebrow">${bal.relative ? 'Net since you started' : esc([m.vault.account?.bank, m.vault.account?.name].filter(Boolean).join(' ') || 'Balance')}</div>
      <div class="big" id="ov-bal">${money(fromCents(bal.cents))}</div>
      <div class="change" id="ov-change"></div>
      <div class="chart-wrap" id="ov-chart"></div>
      <div class="ranges" role="group" aria-label="Chart range">
        ${RANGES.map(([k]) => `<button type="button" data-range="${k}" aria-pressed="${app.ui.range === k}">${k}</button>`).join('')}
      </div>
    </section>
    <div class="card flush" style="margin-top:18px"><div class="stat-row" id="ov-stats"></div></div>
    ${thisMonth(m)}
    <div id="ov-insights"></div>
    ${comingUp(m)}
    <div class="section-head"><h2>Accounts</h2></div>
    <div class="list">
      ${!app.demo && app.account ? `<button class="row with-icon tap" data-act="bank">
        <span class="cat-icon sm" style="--c:var(--${app.vault.bank?.problem ? 'orange' : 'blue'})">${icon('arrows')}</span>
        <span class="main"><span class="title">${app.vault.bank?.accessToken ? esc(app.vault.bank.institution || 'Bank Sync') : 'Connect Your Bank'}</span>
        <span class="subtitle">${app.vault.bank?.accessToken ? (app.vault.bank.problem ? 'Needs you to sign in again' : app.vault.bank.lastSync ? `Synced ${esc(new Date(app.vault.bank.lastSync).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : 'Connected') : 'New transactions come in on their own'}</span></span>
        ${icon('chev-r', 'chev')}
      </button>` : ''}
      ${!app.demo && (app.vault.mail?.refresh || app.vault.mail?.pending?.length) ? `<button class="row with-icon tap" data-act="mail">
        <span class="cat-icon sm" style="--c:var(--${app.vault.mail.problem ? 'orange' : 'indigo'})">${icon('envelope')}</span>
        <span class="main"><span class="title">Bank Emails</span>
        <span class="subtitle">${app.vault.mail.problem ? 'Needs you to sign in to Gmail again' : app.vault.mail.pending?.length ? `${plural(app.vault.mail.pending.length, 'transaction')} to check` : app.vault.mail.lastCheck ? `Checked ${esc(new Date(app.vault.mail.lastCheck).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : 'Gmail connected'}</span></span>
        ${app.vault.mail.pending?.length ? `<span class="badge-count">${app.vault.mail.pending.length}</span>` : ''}${icon('chev-r', 'chev')}
      </button>` : ''}
      <button class="row with-icon tap" data-act="statements">
        <span class="cat-icon sm" style="--c:var(--${bad ? 'orange' : 'green'})">${icon(bad ? 'warn' : 'seal')}</span>
        <span class="main"><span class="title">${plural(m.statements.length, 'statement')}</span>
        <span class="subtitle">${bad ? `${bad} need attention` : unchecked === m.statements.length ? 'No balances in these files to check against' : unchecked ? `Reconciled · ${unchecked} without balances to check` : 'All reconciled to the bank’s balances'}</span></span>
        ${icon('chev-r', 'chev')}
      </button>
      <button class="row with-icon tap" data-act="add">
        <span class="cat-icon sm" style="--c:var(--blue)">${icon('doc')}</span>
        <span class="main"><span class="title">Add Statement</span><span class="subtitle">PDF, CSV or OFX from any bank</span></span>
        ${icon('chev-r', 'chev')}
      </button>
    </div>
    <p class="list-foot">${bal.relative ? `Your files don’t include a balance, so this shows money in minus money out since ${dateLabel(daily[0].date, 'long')}.` : `Balance as of ${dateLabel(bal.date, 'long')}.`} Data is decrypted only on this device.</p>`;

  page.innerHTML = pageFrame({ title: 'Summary', sub, right, body });
  wire(page);
  animateRings(page.querySelector('#ov-rings'));

  // chart + stats for the selected range
  const chartEl = page.querySelector('#ov-chart');
  const balEl = page.querySelector('#ov-bal');
  const changeEl = page.querySelector('#ov-change');
  const draw = () => {
    const series = slice(daily, app.ui.range);
    const first = series[0], last = series[series.length - 1];
    const setHeader = (p) => {
      if (p) {
        balEl.textContent = money(p.bal);
        changeEl.innerHTML = `<span class="when">${dateLabel(p.date, 'long')}</span>`;
      } else {
        balEl.textContent = money(last.bal);
        // Change from the balance *before* the first day, so it matches Money in / out / Net below.
        const startBal = first.bal - m.txns.reduce((sum, t) => (t.date === first.date ? sum + t.c : sum), 0) / 100;
        const d = last.bal - startBal;
        const pctv = startBal ? (d / Math.abs(startBal)) * 100 : 0;
        changeEl.innerHTML = `<span class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '▲' : '▼'} ${money(Math.abs(d))} (${Math.abs(pctv).toFixed(1)}%)</span><span class="when">${rangeLabel(app.ui.range, first.date)}</span>`;
      }
    };
    setHeader(null);
    balanceChart(chartEl, series, { onScrub: setHeader });
    const f = flow(m, first.date, last.date);
    page.querySelector('#ov-stats').innerHTML = [
      ['Money in', f.inn, 'green'], ['Money out', f.out, 'red'], ['Net', f.net, f.net >= 0 ? 'green' : 'red'],
    ].map(([k, v, c], i) => `<div class="stat"><div class="k"><span class="dot" style="--c:var(--${c})"></span>${k}</div><div class="v ${i === 2 ? (v >= 0 ? 'pos' : 'neg') : ''}">${i === 2 ? money(fromCents(v), { sign: true, cents: false }) : money(fromCents(v), { cents: false })}</div></div>`).join('');
  };
  draw();
  page.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    haptic();
    app.ui.range = b.dataset.range;
    page.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    draw();
  }));

  // Highlights, like the Health app: the most important few, then Show All.
  const cards = insights(m);
  const ins = page.querySelector('#ov-insights');
  if (cards.length) {
    ins.innerHTML = `<div class="section-head"><h2>Highlights</h2>${cards.length > 3 ? '<button class="more link" data-act="all-insights">Show All</button>' : ''}</div>
      <div class="insight-list">${cards.slice(0, 3).map((c, i) => insightCard(c, i)).join('')}</div>
      ${cards.length > 3 ? `<button class="list show-all" data-act="all-insights"><span class="row tap"><span class="main"><span class="title" style="color:var(--tint)">Show All ${cards.length} Highlights</span></span>${icon('chev-r', 'chev')}</span></button>` : ''}`;
    ins.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ins]');
      if (!b) return;
      haptic();
      (await import('./insight.js')).openInsight(cards[+b.dataset.ins]);
    });
  }
}

const insightCard = (c, i) => `<button type="button" class="insight" data-ins="${i}" style="--c:var(--${esc(c.color)})" aria-label="${esc(`${c.kicker}: ${c.title}. ${c.text}`)}">
  <span class="kicker">${icon(c.icon)}<span>${esc(c.kicker)}</span>${icon('chev-r', 'chev')}</span><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></button>`;

const RING = { saved: ['#92e82a', '#c2ff5a'], spent: ['#fa114f', '#ff5c8a'], eating: ['#1eeaef', '#7af8ff'] };

/** This month at a glance: budget rings and what's left a day, or how it compares with usual. */
function thisMonth(m) {
  const end = dataEnd(m);
  if (!end) return '';
  const ym = monthOf(end);
  const day = Number(end.slice(8, 10));
  const days = daysInMonth(ym);
  const live = day < days;
  const m0 = (v) => money(v, { cents: false });
  if (m.plan) {
    const t = planTargets(m.plan);
    const pm = planMonth(m, ym);
    const pct = (a, b) => (b > 0 ? Math.max(0, a / b) : 0);
    const left = t.spend - pm.spent;
    const perDay = live && left > 0 ? left / (days - day) : null;
    return `<div class="section-head"><h2>${esc(monthLabel(ym, 'month'))}</h2><button class="more link" data-act="budget" data-ym="${ym}">Budget</button></div>
      <button class="card month-card" data-act="budget" data-ym="${ym}">
        <span class="mc-rings" id="ov-rings">${ringsSVG([
          { label: 'Saved', p: pct(pm.saved, t.save), c1: RING.saved[0], c2: RING.saved[1] },
          { label: 'Spent', p: pct(pm.spent, t.spend), c1: RING.spent[0], c2: RING.spent[1] },
          { label: 'Eating out', p: pct(pm.eatingOut, t.eatingOut), c1: RING.eating[0], c2: RING.eating[1] },
        ], 104, 'ovr')}</span>
        <span class="mc-lines">
          <span class="mc-l" style="--c:#fa114f"><b>Spent</b><span class="num">${m0(pm.spent)}<small>/${m0(t.spend)}</small></span></span>
          <span class="mc-l" style="--c:#92e82a"><b>Saved</b><span class="num">${m0(Math.max(0, pm.saved))}<small>/${m0(t.save)}</small></span></span>
          <span class="mc-l" style="--c:#1eeaef"><b>Eating out</b><span class="num">${m0(pm.eatingOut)}<small>/${m0(t.eatingOut)}</small></span></span>
        </span>
        <span class="mc-foot">${perDay != null ? `<b>${m0(perDay)}</b> a day left for the next ${days - day} days` : left >= 0 ? `${m0(left)} under budget${live ? ' so far' : ''}` : `${m0(-left)} over budget${live ? ' so far' : ''}`}</span>
      </button>`;
  }
  const p = pace(m, end);
  if (!p) return monthRecap(m, ym);
  const ratio = p.usualSoFar ? p.soFar / p.usualSoFar : 1;
  return `<div class="section-head"><h2>${esc(monthLabel(ym, 'month'))}</h2><button class="more link" data-act="budget">Set Budget</button></div>
    <button class="card month-card simple" data-act="spending">
      <span class="mc-k">Everyday spending so far</span>
      <span class="mc-v num">${money(p.soFar / 100, { cents: false })}</span>
      <span class="mc-bars">
        <span class="mc-bar"><i style="--c:var(--${ratio > 1.1 ? 'orange' : 'blue'});width:${Math.min(100, (p.soFar / Math.max(p.soFar, p.usualSoFar, 1)) * 100)}%"></i><em>${esc(monthLabel(ym, 'month'))}</em></span>
        <span class="mc-bar"><i style="--c:var(--gray);width:${Math.min(100, (p.usualSoFar / Math.max(p.soFar, p.usualSoFar, 1)) * 100)}%"></i><em>Usual by day ${p.day}</em></span>
      </span>
      <span class="mc-foot">${ratio > 1.1 ? `${money((p.soFar - p.usualSoFar) / 100, { cents: false })} more than usual by now.` : ratio < 0.9 ? `${money((p.usualSoFar - p.soFar) / 100, { cents: false })} less than usual by now.` : 'About the same as usual by now.'} On pace for ${money(p.projected / 100, { cents: false })}.</span>
    </button>`;
}

/** A finished month (statements cover whole months): everyday spending against the usual month. */
function monthRecap(m, ym) {
  const full = fullMonths(m);
  if (!full.includes(ym)) return '';
  const total = (x) => rangeSpend(m, `${x}-01`, `${x}-${String(daysInMonth(x)).padStart(2, '0')}`, 'everyday').total;
  const before = full.filter((x) => x < ym).slice(-6);
  const cur = total(ym);
  const usual = before.length ? before.reduce((s, x) => s + total(x), 0) / before.length : null;
  const top = Math.max(cur, usual || 0, 1);
  const d = usual != null ? cur - usual : null;
  const m0 = (c) => money(c / 100, { cents: false });
  return `<div class="section-head"><h2>${esc(monthLabel(ym, 'month'))}</h2><button class="more link" data-act="budget">Set Budget</button></div>
    <button class="card month-card simple" data-act="spending" data-ym="${ym}">
      <span class="mc-k">Everyday spending</span>
      <span class="mc-v num">${m0(cur)}</span>
      ${usual != null ? `<span class="mc-bars">
        <span class="mc-bar"><i style="--c:var(--${d > usual * 0.1 ? 'orange' : 'blue'});width:${(cur / top) * 100}%"></i><em>${esc(monthLabel(ym, 'month'))}</em></span>
        <span class="mc-bar"><i style="--c:var(--gray);width:${(usual / top) * 100}%"></i><em>Usual month</em></span>
      </span>
      <span class="mc-foot">${Math.abs(d) < usual * 0.05 ? 'About the same as a usual month.' : `${m0(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than your usual ${m0(usual)}.`} Set a budget to see what’s left each day.</span>` : '<span class="mc-foot">Set a budget to see what’s left to spend each day.</span>'}
    </button>`;
}

/** Bills and subscriptions due soon (when the data is recent). */
function comingUp(m) {
  const soon = upcoming(m, iso(new Date()), 14).slice(0, 4);
  if (!soon.length) return '';
  return `<div class="section-head"><h2>Coming Up</h2></div>
    <div class="list">${soon.map((r) => {
      const d = new Date(`${r.due}T12:00:00`);
      return `<button class="row tap" data-merchant="${esc(r.name)}">
        <span class="date-chip"><small>${esc(d.toLocaleDateString('en-CA', { month: 'short' }).replace('.', ''))}</small>${d.getDate()}</span>
        <span class="main"><span class="title">${esc(r.name)}</span><span class="subtitle">${r.inDays === 0 ? 'Today' : r.inDays === 1 ? 'Tomorrow' : `In ${r.inDays} days`} · ${esc(r.cadence.label)}</span></span>
        <span class="value">${money(r.typical / 100)}</span></button>`;
    }).join('')}</div>`;
}

/** Every insight in one scrolling list. */
function openAllInsights() {
  const cards = insights(app.model);
  const sheet = openSheet({ title: 'Highlights', size: 'full', body: `<div class="insight-list">${cards.map((c, i) => insightCard(c, i)).join('')}</div>` });
  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ins]');
    if (!b) return;
    haptic();
    (await import('./insight.js')).openInsight(cards[+b.dataset.ins]);
  });
}

function banners() {
  let out = '';
  if (app.demo) {
    out += `<div class="banner" style="--c:var(--indigo)"><span class="ic">${icon('sparkle')}</span><span class="txt"><b>Sample data</b><span>Made-up numbers to explore the app. Nothing is saved.</span></span><button class="btn small secondary" data-act="exit-demo">Exit</button></div>`;
  } else if (app.isDirty()) {
    out += app.account
      ? `<div class="banner" style="--c:var(--orange)"><span class="ic">${icon('arrows')}</span><span class="txt"><b>Not synced yet</b><span>${app.syncError ? `Saved on this device. ${esc(app.syncError)}` : 'Saved on this device. Syncs automatically when you’re online.'}</span></span><button class="btn small" data-act="save">Sync</button></div>`
      : `<div class="banner" style="--c:var(--orange)"><span class="ic">${icon('upload')}</span><span class="txt"><b>Changes not in your repo yet</b><span>Saved on this device. Save to GitHub to sync.</span></span><button class="btn small" data-act="save">Save</button></div>`;
  }
  const unknown = app.demo ? [] : uncategorized(app.model);
  if (unknown.length) {
    out += `<button class="banner" style="--c:var(--blue);width:100%;text-align:left" data-act="teach"><span class="ic">${icon('tag')}</span><span class="txt"><b>${unknown.length === 1 ? `“${esc(unknown[0].name)}” needs a category` : `${unknown.length} places need a category`}</b><span>One tap each. Money remembers from then on.</span></span>${icon('chev-r', 'chev')}</button>`;
  }
  const bad = app.model.statements.filter((s) => s.reconciled === false);
  if (bad.length) {
    out += `<button class="banner" style="--c:var(--red);width:100%;text-align:left" data-act="statements"><span class="ic">${icon('warn')}</span><span class="txt"><b>${bad.length === 1 ? `${monthLabel(bad[0].id)} doesn’t reconcile` : `${bad.length} statements don’t reconcile`}</b><span>Tap to see what’s off.</span></span>${icon('chev-r', 'chev')}</button>`;
  }
  return out;
}

function emptyState() {
  return `<div class="card"><div class="empty">
    <div class="ic">${icon('doc')}</div>
    <h3>Add your first statement</h3>
    <p>PDF statements from any bank, or CSV, OFX or QIF downloads from online banking. They’re read on this device, checked against the bank’s balances, then encrypted.</p>
    <button class="btn" data-act="add" style="max-width:280px">Add Statements</button>
  </div></div>`;
}

function slice(daily, range) {
  const last = daily[daily.length - 1].date;
  const r = RANGES.find(([k]) => k === range)?.[1] ?? 'all';
  let from = daily[0].date;
  if (r === 'ytd') from = `${last.slice(0, 4)}-01-01`;
  else if (typeof r === 'number') from = addDays(last, -r);
  const s = daily.filter((d) => d.date >= from);
  return s.length >= 2 ? s : daily.slice(-2);
}
function rangeLabel(range, from) {
  return { '1M': 'Past month', '3M': 'Past 3 months', '6M': 'Past 6 months', YTD: 'Year to date' }[range] || `Since ${dateLabel(from, 'short')}`;
}

function wire(page) {
  wireLargeTitle(page);
  page.onclick = async (e) => {
    const mer = e.target.closest('[data-merchant]');
    if (mer) { haptic(); (await import('./sheets.js')).openCategory(null, { ym: 'all', mode: 'everything', merchant: mer.dataset.merchant }); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    haptic();
    if (act === 'add') (await import('./importer.js')).openImporter();
    if (act === 'settings') (await import('./settings.js')).openSettings();
    if (act === 'statements') (await import('./settings.js')).openStatements();
    if (act === 'teach') (await import('./teach.js')).openTeach();
    if (act === 'save') (await import('./settings.js')).saveToRepo();
    if (act === 'exit-demo') app.lock();
    if (act === 'budget') (await import('./budget.js')).openBudget({ ym: e.target.closest('[data-ym]')?.dataset.ym || null });
    if (act === 'bank') (await import('./bank.js')).openBank();
    if (act === 'mail') (await import('./mail.js')).openMail();
    if (act === 'spending') { const ym = e.target.closest('[data-ym]')?.dataset.ym; app.ui.spKind = 'month'; app.ui.spAnchor = ym ? `${ym}-01` : null; app.ui.spSel = null; app.ui.mode = 'everyday'; app.stale.add('spending'); app.selectTab('spending'); }
    if (act === 'all-insights') openAllInsights();
  };
}
