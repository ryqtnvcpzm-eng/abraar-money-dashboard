// Shared sheets: transaction detail (with re-categorize + "apply to all" rule), category/merchant drill-down, category picker.
import { app } from '../state.js';
import { money, monthLabel, dateLabel, esc, fromCents, plural } from '../format.js';
import { filterMode, isSpend } from '../ledger.js';
import { userRuleFor } from '../categorize.js';
import { icon, catIcon, openSheet, haptic, toast, alertSheet } from '../ui.js';
import { miniColumns } from '../charts.js';

export function txnRow(t, { showDate = false } = {}) {
  const inn = t.c > 0;
  return `<button class="row with-icon tap txn ${t.netted ? 'netted' : ''}" data-txn="${esc(t.id)}">
    ${catIcon(t.cat)}
    <span class="main"><span class="title">${esc(t.name)}</span>
      <span class="subtitle">${showDate ? `${dateLabel(t.date, 'short')} · ` : ''}${t.netted ? 'Reversed' : esc(t.cat.name)}${t.oneOff ? ' · One-off' : ''}</span></span>
    <span class="value ${inn ? 'in' : ''}">${inn ? '+' : ''}${money(Math.abs(t.amount))}</span>
  </button>`;
}

// ---------------------------------------------------------------------------
// Transaction detail
// ---------------------------------------------------------------------------
export function openTxn(id, { onChange } = {}) {
  const sheet = openSheet({ title: 'Transaction', size: 'auto', body: '' });
  const draw = () => {
    const t = app.model.byId.get(id);
    if (!t) { sheet.close(); return; }
    const pair = t.pair ? app.model.byId.get(t.pair) : null;
    const inn = t.c > 0;
    sheet.setBody(`
      <div class="sheet-hero">
        ${catIcon(t.cat, 'lg')}
        <div class="name">${esc(t.name)}</div>
        <div class="amt num ${inn ? 'pos' : ''}">${inn ? '+' : '−'}${money(Math.abs(t.amount))}</div>
        <div class="when">${dateLabel(t.date, 'day')}, ${t.date.slice(0, 4)}</div>
      </div>
      <div class="list">
        <button class="row with-icon tap" data-act="category">
          ${catIcon(t.cat, 'sm')}
          <span class="main"><span class="title">Category</span></span>
          <span class="detail">${esc(t.cat.name)}</span>${icon('chev-r', 'chev')}
        </button>
        ${isSpend(t) ? `<label class="row with-icon">
          <span class="cat-icon sm" style="--c:var(--indigo)">${icon('sparkle')}</span>
          <span class="main"><span class="title">One-off</span><span class="subtitle">Leave out of Everyday spending</span></span>
          <span class="switch"><input type="checkbox" data-act="oneoff" ${t.oneOff ? 'checked' : ''} aria-label="One-off"><span></span></span>
        </label>` : ''}
      </div>
      ${t.netted ? `<p class="list-foot">${icon('arrows', '')} Cancelled out by ${pair ? `${esc(pair.name)} on ${dateLabel(pair.date, 'short')}` : 'a matching entry'} — left out of all totals.</p>` : ''}
      <div class="list-head"><span>Details</span></div>
      <div class="list">
        <div class="row"><span class="main"><span class="subtitle">On statement</span><span class="title" style="white-space:normal">${esc(t.merchant || '—')}</span></span></div>
        <div class="row"><span class="main"><span class="title">Statement</span></span><span class="detail">${esc(monthLabel(t.statement))}</span></div>
        ${t.balance != null ? `<div class="row"><span class="main"><span class="title">Balance after</span></span><span class="detail num">${money(t.balance)}</span></div>` : ''}
        ${t.locked ? `<button class="row tap action" data-act="unlock"><span class="main"><span class="title">Use automatic category</span></span></button>` : ''}
      </div>`);
  };
  draw();
  sheet.el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'category') {
      haptic();
      const t = app.model.byId.get(id);
      const picked = await pickCategory(t.category, t.c > 0);
      if (!picked || picked === t.category) return;
      await changeCategory(t, picked);
      draw(); onChange?.();
    }
    if (act === 'unlock') {
      const raw = app.vault.transactions.find((x) => x.id === id);
      raw.locked = false;
      await app.commit();
      draw(); onChange?.();
    }
  });
  sheet.el.addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'oneoff') return;
    haptic();
    const raw = app.vault.transactions.find((x) => x.id === id);
    raw.oneOff = e.target.checked || undefined;
    await app.commit({ silent: true });
    draw(); onChange?.();
  });
}

async function changeCategory(t, catId) {
  const cat = app.model.cats.get(catId);
  const sign = Math.sign(t.c) || -1;
  const same = app.vault.transactions.filter((x) => x.id !== t.id && x.name === t.name && (Math.sign(x.amount) || -1) === sign);
  const choice = await alertSheet({
    title: same.length ? `Apply to all ${same.length + 1} from “${t.name}”?` : `Always use ${cat.name} for “${t.name}”?`,
    message: same.length
      ? `Changes the other ${plural(same.length, 'transaction')} too, and saves a rule so future statements put ${t.name} in ${cat.name}.`
      : `Saves a rule so future statements put ${t.name} in ${cat.name}.`,
    actions: [
      { label: same.length ? `Apply to All ${same.length + 1}` : 'Always', value: 'all', style: 'primary' },
      { label: 'Only This One', value: 'one', style: 'default' },
      { label: 'Cancel', value: null, style: 'cancel' },
    ],
  });
  if (!choice) return;
  const raw = app.vault.transactions.find((x) => x.id === t.id);
  if (choice === 'all') {
    const rule = userRuleFor({ name: t.name, amount: t.amount }, catId);
    app.vault.userRules = (app.vault.userRules || []).filter((r) => !(r.name.toLowerCase() === t.name.toLowerCase() && (r.sign == null || r.sign === rule.sign)));
    app.vault.userRules.push(rule);
    for (const x of [raw, ...same]) { x.locked = false; x.category = catId; }
    await app.commit({ silent: true });
    toast(`Rule saved for ${t.name}`, { icon: 'tag', color: 'blue' });
  } else {
    raw.category = catId;
    raw.locked = true;
    await app.commit({ silent: true });
    toast('Category changed');
  }
}

export function pickCategory(current, isIncome) {
  return new Promise((resolve) => {
    const cats = app.rules.categories;
    const groups = [
      ['Spending', cats.filter((c) => c.type === 'spend')],
      ['Money In', cats.filter((c) => c.type === 'income')],
      ['Other', cats.filter((c) => c.type === 'transfer')],
    ];
    if (isIncome) groups.unshift(groups.splice(1, 1)[0]);
    let picked = null;
    const sheet = openSheet({
      title: 'Category', size: 'full',
      body: groups.map(([g, list]) => `<div class="list-head"><span>${g}</span></div><div class="list">${list.map((c) => `
        <button class="row with-icon tap" data-pick="${esc(c.id)}">${catIcon(c, 'sm')}
          <span class="main"><span class="title">${esc(c.name)}</span>${c.type === 'spend' && !c.everyday ? '<span class="subtitle">Not counted in Everyday</span>' : ''}</span>
          ${c.id === current ? `<span style="color:var(--tint)">${icon('check')}</span>` : ''}</button>`).join('')}</div>`).join(''),
      onClose: () => resolve(picked),
    });
    sheet.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      haptic();
      picked = b.dataset.pick;
      sheet.close();
    });
  });
}

// ---------------------------------------------------------------------------
// Category or merchant drill-down
// ---------------------------------------------------------------------------
export function openCategory(catId, { ym = 'all', mode = 'everything', merchant = null } = {}) {
  const m = app.model;
  const cat = catId ? m.cats.get(catId) : null;
  const sheet = openSheet({ title: merchant || cat?.name || 'Category', size: 'full', body: '' });
  const draw = () => {
    const f = filterMode(mode);
    const match = (t) => (merchant ? t.name === merchant && f(t) : t.cat.id === catId && f(t));
    const all = app.model.txns.filter(match);
    const inPeriod = all.filter((t) => ym === 'all' || t.month === ym);
    const live = inPeriod.filter((t) => !t.netted);
    const total = -live.reduce((s, t) => s + t.c, 0);
    const n = live.filter((t) => t.c < 0).length;
    const first = all[0] || inPeriod[0];
    const c = cat || first?.cat || app.model.cats.get('other');
    const months = app.model.months.map((mm) => ({ ym: mm, v: fromCents(-all.filter((t) => t.month === mm && !t.netted).reduce((s, t) => s + t.c, 0)) }));
    const groups = new Map();
    for (const t of [...inPeriod].reverse()) {
      const k = ym === 'all' ? t.month : t.date;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    sheet.setBody(`
      <div class="sheet-hero">
        ${catIcon(c, 'lg')}
        <div class="when">${ym === 'all' ? 'All months' : esc(monthLabel(ym))}${mode === 'everyday' ? ' · Everyday' : ''}</div>
        <div class="amt num">${money(fromCents(total))}</div>
        <div class="when">${plural(n, 'payment')}${n ? ` · ${money(fromCents(total / n))} average` : ''}</div>
      </div>
      ${months.length > 1 ? `<div class="card">${miniColumns(months, c.color)}</div>` : ''}
      ${[...groups.entries()].map(([k, list]) => `
        <div class="list-head"><span>${ym === 'all' ? esc(monthLabel(k)) : esc(dateLabel(k))}</span><span class="num">${money(fromCents(-list.filter((t) => !t.netted).reduce((s, t) => s + t.c, 0)))}</span></div>
        <div class="list">${list.map((t) => txnRow(t, { showDate: ym === 'all' })).join('')}</div>`).join('') || '<div class="empty">No transactions.</div>'}`);
  };
  draw();
  sheet.el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-txn]');
    if (!r) return;
    haptic();
    openTxn(r.dataset.txn, { onChange: draw });
  });
}
