// Overview: balance with a scrubbable chart, money in/out/net, insight cards.
import { app } from '../state.js';
import { money, dateLabel, esc, fromCents, addDays, plural, monthLabel } from '../format.js';
import { dailyBalance, flow, insights, currentBalance } from '../ledger.js';
import { icon, pageFrame, wireLargeTitle, haptic } from '../ui.js';
import { balanceChart } from '../charts.js';

const RANGES = [['1M', 30], ['3M', 91], ['6M', 182], ['YTD', 'ytd'], ['ALL', 'all']];

export function renderOverview(page) {
  const m = app.model;
  const daily = dailyBalance(m).map((d) => ({ date: d.date, bal: fromCents(d.bal) }));
  const bal = currentBalance(m);
  const right = `
    <button class="glass-btn" data-act="add" aria-label="Add statement">${icon('plus')}</button>
    <button class="glass-btn" data-act="settings" aria-label="Settings">${icon('gear')}${app.isDirty() ? '<span class="badge-dot"></span>' : ''}</button>`;

  if (!bal) {
    page.innerHTML = pageFrame({ title: 'Overview', right, body: emptyState() });
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
    <div id="ov-insights"></div>
    <div class="list-head"><span>Statements</span></div>
    <div class="list">
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

  page.innerHTML = pageFrame({ title: 'Overview', right, body });
  wire(page);

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
        const d = last.bal - first.bal;
        const pctv = first.bal ? (d / Math.abs(first.bal)) * 100 : 0;
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

  // insights carousel
  const cards = insights(m);
  const ins = page.querySelector('#ov-insights');
  if (cards.length) {
    ins.innerHTML = `<div class="section-head"><h2>Insights</h2></div>
      <div class="insights" id="ins-row" tabindex="0" aria-label="Insights, swipe for more">
        ${cards.map((c, i) => `<button type="button" class="insight" data-ins="${i}" style="--c:var(--${esc(c.color)})" aria-label="${esc(`${c.kicker}: ${c.title}. ${c.text}`)}">
          <span class="kicker">${icon(c.icon)}<span>${esc(c.kicker)}</span>${icon('chev-r', 'chev')}</span><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></button>`).join('')}
      </div>
      <div class="dots" aria-hidden="true">${cards.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>`;
    const row = ins.querySelector('#ins-row');
    row.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ins]');
      if (!b) return;
      haptic();
      (await import('./insight.js')).openInsight(cards[+b.dataset.ins]);
    });
    const dots = [...ins.querySelectorAll('.dots i')];
    let last = 0;
    row.addEventListener('scroll', () => {
      const w = row.firstElementChild.offsetWidth + 12;
      const i = Math.min(dots.length - 1, Math.round(row.scrollLeft / w));
      if (i !== last) { dots[last].classList.remove('on'); dots[i].classList.add('on'); last = i; }
    }, { passive: true });
  }
}

function banners() {
  let out = '';
  if (app.demo) {
    out += `<div class="banner" style="--c:var(--indigo)"><span class="ic">${icon('sparkle')}</span><span class="txt"><b>Sample data</b><span>Made-up numbers to explore the app. Nothing is saved.</span></span><button class="btn small secondary" data-act="exit-demo">Exit</button></div>`;
  } else if (app.isDirty()) {
    out += app.account
      ? `<div class="banner" style="--c:var(--orange)"><span class="ic">${icon('arrows')}</span><span class="txt"><b>Not synced yet</b><span>Saved on this device. Syncs automatically when you’re online.</span></span><button class="btn small" data-act="save">Sync</button></div>`
      : `<div class="banner" style="--c:var(--orange)"><span class="ic">${icon('upload')}</span><span class="txt"><b>Changes not in your repo yet</b><span>Saved on this device. Save to GitHub to sync.</span></span><button class="btn small" data-act="save">Save</button></div>`;
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
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    haptic();
    if (act === 'add') (await import('./importer.js')).openImporter();
    if (act === 'settings') (await import('./settings.js')).openSettings();
    if (act === 'statements') (await import('./settings.js')).openStatements();
    if (act === 'save') (await import('./settings.js')).saveToRepo();
    if (act === 'exit-demo') app.lock();
  };
}
