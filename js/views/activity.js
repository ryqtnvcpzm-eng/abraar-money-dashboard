// Activity: every transaction, searchable, grouped by day.
import { app } from '../state.js';
import { money, dateLabel, esc, fromCents, monthLabel } from '../format.js';
import { icon, pageFrame, wireLargeTitle, haptic } from '../ui.js';
import { txnRow, openTxn } from './sheets.js';

const FILTERS = [['all', 'All'], ['out', 'Money Out'], ['in', 'Money In'], ['oneoff', 'One-offs'], ['reversed', 'Reversed']];
const PAGE = 60; // days rendered per chunk

export function renderActivity(page) {
  const right = `<button class="glass-btn wide tint" data-act="add" aria-label="Add statement">${icon('plus')}<span>Add</span></button>`;
  const body = `
    <div class="search" role="search">${icon('search')}
      <input type="search" id="act-q" placeholder="Search" value="${esc(app.ui.search)}" aria-label="Search transactions" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
      <button class="clear" data-act="clear" aria-label="Clear search" ${app.ui.search ? '' : 'hidden'}>${icon('close')}</button>
    </div>
    <div class="filters" role="group" aria-label="Filter">${FILTERS.map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${app.ui.filter === k}">${l}</button>`).join('')}</div>
    <div id="act-list"></div>`;
  page.innerHTML = pageFrame({ title: 'Activity', right, body });
  wireLargeTitle(page);

  const listEl = page.querySelector('#act-list');
  const q = page.querySelector('#act-q');
  const clear = page.querySelector('[data-act="clear"]');
  let shown = PAGE;
  let observer;

  const draw = () => {
    const items = filtered();
    const days = new Map();
    for (let i = items.length - 1; i >= 0; i--) {
      const t = items[i];
      if (!days.has(t.date)) days.set(t.date, []);
      days.get(t.date).push(t);
    }
    const entries = [...days.entries()];
    if (!entries.length) {
      listEl.innerHTML = app.model.txns.length
        ? `<div class="empty"><div class="ic">${icon('search')}</div><h3>No Results</h3><p>Nothing matches “${esc(app.ui.search)}”.</p></div>`
        : `<div class="card"><div class="empty"><div class="ic">${icon('activity')}</div><h3>No transactions yet</h3><p>Add a statement from your bank to fill this in.</p><button class="btn" data-act="add" style="max-width:260px">Add Statement</button></div></div>`;
      return;
    }
    let lastMonth = null;
    const html = entries.slice(0, shown).map(([d, list]) => {
      const net = list.filter((t) => !t.netted).reduce((s, t) => s + t.c, 0);
      const mh = d.slice(0, 7) !== lastMonth ? (lastMonth = d.slice(0, 7), `<h2 class="t-title3" style="margin:26px 4px 0">${esc(monthLabel(lastMonth))}</h2>`) : '';
      return `${mh}<div class="day"><div class="list-head"><span>${esc(dateLabel(d))}</span><span>${net ? money(fromCents(net), { sign: true }) : ''}</span></div>
        <div class="list">${list.map((t) => txnRow(t)).join('')}</div></div>`;
    }).join('');
    const count = items.length;
    listEl.innerHTML = `${app.ui.search || app.ui.filter !== 'all' ? `<p class="note" style="margin:0 4px">${count.toLocaleString('en-CA')} ${count === 1 ? 'result' : 'results'} · ${money(fromCents(items.filter((t) => !t.netted).reduce((s, t) => s + t.c, 0)), { sign: true })} net</p>` : ''}${html}${entries.length > shown ? '<div id="act-more" style="height:40px"></div>' : ''}`;
    observer?.disconnect();
    const more = listEl.querySelector('#act-more');
    if (more) {
      observer = new IntersectionObserver((es) => { if (es[0].isIntersecting) { shown += PAGE; draw(); } }, { root: page.querySelector('.scroller'), rootMargin: '600px' });
      observer.observe(more);
    }
  };

  let deb;
  q.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { app.ui.search = q.value.trim(); clear.hidden = !app.ui.search; shown = PAGE; draw(); }, 120);
  });
  page.onclick = async (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) {
      haptic();
      app.ui.filter = f.dataset.filter;
      page.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', b === f));
      shown = PAGE; draw(); return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'clear') { q.value = ''; app.ui.search = ''; clear.hidden = true; draw(); q.focus(); return; }
    if (act === 'add') { haptic(); (await import('./importer.js')).openImporter(); return; }
    const r = e.target.closest('[data-txn]');
    if (r) { haptic(); openTxn(r.dataset.txn, { onChange: draw }); }
  };
  draw();
}

function filtered() {
  const words = app.ui.search.toLowerCase().split(/\s+/).filter(Boolean);
  const f = app.ui.filter;
  return app.model.txns.filter((t) => {
    if (f === 'out' && t.c >= 0) return false;
    if (f === 'in' && t.c <= 0) return false;
    if (f === 'oneoff' && !t.oneOff) return false;
    if (f === 'reversed' && !t.netted) return false;
    if (!words.length) return true;
    const hay = `${t.name} ${t.merchant} ${t.cat.name} ${Math.abs(t.amount).toFixed(2)} ${monthLabel(t.month)} ${dateLabel(t.date)}`.toLowerCase();
    return words.every((w) => hay.includes(w.replace(/^\$/, '')));
  });
}
