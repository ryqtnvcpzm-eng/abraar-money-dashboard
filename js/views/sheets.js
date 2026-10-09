// Shared sheets: transaction detail (with re-categorize + "apply to all" rule), category/merchant drill-down, category picker.
import { app } from '../state.js';
import { money, monthLabel, dateLabel, esc, fromCents, toCents, plural, daysBetween } from '../format.js';
import { filterMode, isSpend, splitParts } from '../ledger.js';
import { userRuleFor, isMixedStore } from '../categorize.js';
import { icon, catIcon, openSheet, haptic, toast, alertSheet } from '../ui.js';
import { miniColumns } from '../charts.js';

export function txnRow(t, { showDate = false } = {}) {
  const inn = t.c > 0;
  return `<button class="row with-icon tap txn ${t.netted ? 'netted' : ''}" data-txn="${esc(t.id)}">
    ${catIcon(t.cat)}
    <span class="main"><span class="title">${esc(t.name)}</span>
      <span class="subtitle">${showDate ? `${dateLabel(t.date, 'short')} · ` : ''}${t.netted ? 'Reversed' : esc(t.cat.name)}${t.oneOff ? ' · One-off' : ''}${t.memo ? ` · ${esc(t.memo)}` : t.note?.length && !t.netted ? ` · ${esc(t.note[0])}${t.note.length > 1 ? ` +${t.note.length - 1}` : ''}` : ''}</span></span>
    <span class="value ${inn ? 'in' : ''}">${inn ? '+' : ''}${money(Math.abs(t.amount))}</span>
  </button>`;
}

// ---------------------------------------------------------------------------
// Transaction detail
// ---------------------------------------------------------------------------
// What a purchase at a store that sells everything usually turns out to be.
const WHAT_CHIPS = ['groceries', 'electronics', 'household', 'health', 'shopping', 'entertainment', 'fitness'];
const rawOf = (id) => app.vault.transactions.find((x) => x.id === id);

export function openTxn(id, { onChange } = {}) {
  // A part of a split charge opens the whole charge.
  const first = app.model.byId.get(id);
  if (first?.partOf) id = first.partOf;
  const sheet = openSheet({ title: 'Transaction', size: 'auto', body: '' });
  const draw = () => {
    const t = app.model.byId.get(id);
    if (!t) { sheet.close(); return; }
    const raw = rawOf(id);
    const pair = t.pair ? app.model.byId.get(t.pair) : null;
    const inn = t.c > 0;
    const mixed = isMixedStore(t.name, app.rules) && !t.split && !raw?.items?.length && !t.locked && t.c < 0;
    const amazon = /^amazon$/i.test(t.name);
    const cats = app.model.cats;
    // With a split made by hand, the items are only there to read.
    const itemsLocked = !!raw?.parts;
    const itemRows = (raw?.items || []).map((it, k) => {
      const c = cats.get(it.category) || cats.get('shopping');
      return `<${itemsLocked ? 'div' : 'button'} class="row with-icon ${itemsLocked ? '' : 'tap'}" ${itemsLocked ? '' : `data-item="${k}"`}>${catIcon(c, 'sm')}
        <span class="main"><span class="title" style="white-space:normal">${esc(it.title)}</span><span class="subtitle">${esc(c.name)}${it.qty > 1 ? ` · ×${it.qty}` : ''}</span></span>
        <span class="value">${money(it.amount)}</span></${itemsLocked ? 'div' : 'button'}>`;
    }).join('');
    sheet.setBody(`
      <div class="sheet-hero">
        ${catIcon(t.cat, 'lg')}
        <div class="name">${esc(t.name)}</div>
        <div class="amt num ${inn ? 'pos' : ''}">${inn ? '+' : '−'}${money(Math.abs(t.amount))}</div>
        <div class="when">${dateLabel(t.date, 'day')}, ${t.date.slice(0, 4)}</div>
      </div>
      ${t.split ? `
        <div class="list-head"><span>Split</span><span>${plural(t.split.length, 'part')}</span></div>
        <div class="list">${t.split.map((p, k) => `
          <button class="row with-icon tap" data-part="${k}">${catIcon(p.cat, 'sm')}
            <span class="main"><span class="title">${esc(p.cat.name)}</span>${p.note?.length ? `<span class="subtitle">${esc(p.note.join(', '))}</span>` : ''}</span>
            <span class="value">${money(Math.abs(p.amount))}</span>${icon('chev-r', 'chev')}</button>`).join('')}
        </div>` : ''}
      ${mixed ? `
        <div class="list-head"><span>What was it?</span></div>
        <div class="card" style="padding:12px 0 10px"><div class="teach-chips">
          ${WHAT_CHIPS.filter((c) => cats.has(c)).map((c) => { const k = cats.get(c); return `<button type="button" class="teach-chip" data-what="${esc(c)}" style="--c:var(--${esc(k.color)})">${icon(k.icon)}<span>${esc(k.name)}</span></button>`; }).join('')}
        </div></div>
        <p class="list-foot">${esc(t.name)} sells all kinds of things, so this sorts just this charge.${amazon ? ' Or add your Amazon order history to sort every order item by item.' : ''}</p>` : ''}
      <div class="list" style="${mixed || t.split ? 'margin-top:18px' : ''}">
        ${t.split ? '' : `<button class="row with-icon tap" data-act="category">
          ${catIcon(t.cat, 'sm')}
          <span class="main"><span class="title">Category</span></span>
          <span class="detail">${esc(t.cat.name)}</span>${icon('chev-r', 'chev')}
        </button>`}
        ${isSpend(t) || t.split ? `<label class="row with-icon">
          <span class="cat-icon sm" style="--c:var(--indigo)">${icon('sparkle')}</span>
          <span class="main"><span class="title">One-off</span><span class="subtitle">Leave out of Everyday spending</span></span>
          <span class="switch"><input type="checkbox" data-act="oneoff" ${t.oneOff ? 'checked' : ''} aria-label="One-off"><span></span></span>
        </label>` : ''}
        ${t.c < 0 && !t.netted ? `<button class="row with-icon tap" data-act="split">
          <span class="cat-icon sm" style="--c:var(--teal)">${icon('split')}</span>
          <span class="main"><span class="title">${t.split ? 'Edit Split' : 'Split Across Categories'}</span>${t.split ? '' : '<span class="subtitle">Groceries and a phone case in one order? Divide it</span>'}</span>${icon('chev-r', 'chev')}
        </button>` : ''}
        ${t.split ? `<button class="row with-icon tap" data-act="category">
          <span class="cat-icon sm" style="--c:var(--gray)">${icon('tag')}</span>
          <span class="main"><span class="title">One Category for All</span></span>${icon('chev-r', 'chev')}</button>` : ''}
        ${amazon && t.c < 0 ? `<button class="row with-icon tap" data-act="amazon">
          <span class="cat-icon sm" style="--c:var(--orange)">${icon('box')}</span>
          <span class="main"><span class="title">Amazon Orders</span><span class="subtitle">Sort Amazon charges item by item</span></span>${icon('chev-r', 'chev')}</button>` : ''}
      </div>
      ${t.netted ? `<p class="list-foot">${icon('arrows', '')} Cancelled out by ${pair ? `${esc(pair.name)} on ${dateLabel(pair.date, 'short')}` : 'a matching entry'} — left out of all totals.</p>` : ''}
      ${itemRows ? `<div class="list-head"><span>Items</span><span>${itemsLocked ? 'Split by hand' : 'Tap to change'}</span></div><div class="list">${itemRows}</div>` : ''}
      <div class="list-head"><span>Details</span></div>
      <div class="list">
        <label class="row"><span class="main"><span class="title">Note</span></span>
          <input class="inline" id="txn-memo" value="${esc(raw?.memo || '')}" placeholder="Add a note" maxlength="140" autocomplete="off" enterkeyhint="done" aria-label="Note"></label>
        <div class="row"><span class="main"><span class="subtitle">On statement</span><span class="title" style="white-space:normal">${esc(t.merchant || '—')}</span></span></div>
        <div class="row"><span class="main"><span class="title">Statement</span></span><span class="detail">${esc(monthLabel(t.statement))}</span></div>
        ${t.balance != null ? `<div class="row"><span class="main"><span class="title">Balance after</span></span><span class="detail num">${money(t.balance)}</span></div>` : ''}
        ${t.locked ? `<button class="row tap action" data-act="unlock"><span class="main"><span class="title">Use automatic category</span></span></button>` : ''}
      </div>`);
  };
  draw();
  const changed = async (msg) => { await app.commit({ silent: true }); if (msg) toast(msg); draw(); onChange?.(); };
  sheet.el.addEventListener('click', async (e) => {
    const what = e.target.closest('[data-what]');
    if (what) {
      haptic();
      const raw = rawOf(id);
      raw.category = what.dataset.what; raw.locked = true;
      await changed(`${app.model.cats.get(raw.category)?.name || 'Category'} for this one`);
      return;
    }
    const part = e.target.closest('[data-part]');
    if (part) {
      haptic();
      const t = app.model.byId.get(id);
      const p = t.split[+part.dataset.part];
      const picked = await pickCategory(p.category, false);
      if (!picked || picked === p.category) return;
      const raw = rawOf(id);
      if (raw.parts) raw.parts[p.pi].category = picked;
      else for (const it of raw.items || []) if (it.category === p.category) { it.category = picked; it.set = true; }
      await changed('Category changed');
      return;
    }
    const item = e.target.closest('[data-item]');
    if (item) {
      haptic();
      const raw = rawOf(id);
      const it = raw.items[+item.dataset.item];
      const picked = await pickCategory(it.category, false);
      if (!picked || picked === it.category) return;
      it.category = picked; it.set = true;
      // Item categories decide the split, unless you chose one category for the whole charge.
      if (raw.locked && !raw.parts) raw.locked = false;
      await changed('Item moved');
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'category') {
      haptic();
      const t = app.model.byId.get(id);
      const picked = await pickCategory(t.split ? null : t.category, t.c > 0);
      if (!picked || (picked === t.category && !t.split)) return;
      if (t.split) {
        const raw = rawOf(id);
        delete raw.parts;
        raw.category = picked; raw.locked = true;
        await changed('Split removed');
      } else { await changeCategory(t, picked); draw(); onChange?.(); }
    }
    if (act === 'split') { haptic(); openSplit(id, () => { draw(); onChange?.(); }); }
    if (act === 'amazon') { haptic(); (await import('./amazon-import.js')).openAmazonImport(); }
    if (act === 'unlock') {
      const raw = rawOf(id);
      raw.locked = false;
      await app.commit();
      draw(); onChange?.();
    }
  });
  sheet.el.addEventListener('keydown', (e) => { if (e.target.id === 'txn-memo' && e.key === 'Enter') e.target.blur(); });
  sheet.el.addEventListener('change', async (e) => {
    if (e.target.id === 'txn-memo') {
      const raw = rawOf(id);
      const memo = e.target.value.trim().slice(0, 140);
      if ((raw.memo || '') === memo) return;
      if (memo) raw.memo = memo; else delete raw.memo;
      await app.commit({ silent: true });
      onChange?.();
      return;
    }
    if (e.target.dataset.act !== 'oneoff') return;
    haptic();
    const raw = rawOf(id);
    raw.oneOff = e.target.checked || undefined;
    await app.commit({ silent: true });
    draw(); onChange?.();
  });
}

/** Divide one charge between categories. The first line takes whatever the others don't. */
export function openSplit(id, onDone) {
  const raw = rawOf(id);
  const total = Math.abs(toCents(raw.amount));
  const sign = raw.amount < 0 ? -1 : 1;
  const current = splitParts(raw);
  let lines = current ? current.map((p) => ({ category: p.category, cents: p.cents })) : [{ category: raw.category, cents: total }];
  if (lines.length === 1) lines.push({ category: raw.category === 'groceries' ? 'household' : 'groceries', cents: 0 });
  const cats = app.model.cats;
  const sheet = openSheet({ title: 'Split', size: 'full', body: '' });
  const rest = () => total - lines.slice(1).reduce((s, l) => s + l.cents, 0);
  const draw = () => {
    sheet.setBody(`
      <div class="sheet-hero" style="padding-bottom:8px">
        <div class="name">${esc(raw.name)}</div>
        <div class="amt num">${money(fromCents(total))}</div>
        <div class="when">${esc(dateLabel(raw.date, 'day'))}</div>
      </div>
      <div class="list">${lines.map((l, k) => { const c = cats.get(l.category) || cats.get('other'); return `
        <div class="row with-icon split-line">
          <button type="button" class="split-cat" data-pick="${k}" aria-label="Category: ${esc(c.name)}">${catIcon(c, 'sm')}<span class="title">${esc(c.name)}</span>${icon('chev-d', 'chev')}</button>
          ${k === 0 ? `<span class="value num" id="split-rest">${money(fromCents(rest()))}</span>`
            : `<input class="split-amt num" data-amt="${k}" inputmode="decimal" enterkeyhint="done" value="${l.cents ? (l.cents / 100).toFixed(2) : ''}" placeholder="0.00" aria-label="Amount for ${esc(c.name)}">
               <button type="button" class="split-del" data-del="${k}" aria-label="Remove">${icon('close')}</button>`}
        </div>`; }).join('')}
      </div>
      <p class="list-foot" id="split-note">The first line is whatever’s left. ${esc(raw.name)} still shows as one charge; each part counts in its own category.</p>
      <div class="btn-row">
        <button class="btn secondary" data-act="add-line">${icon('plus')} Add Category</button>
        <button class="btn" data-act="save" id="split-save">Save Split</button>
        ${raw.parts ? '<button class="btn secondary destructive" data-act="unsplit">Remove Split</button>' : ''}
      </div>`);
    check();
  };
  const check = () => {
    const r = rest();
    const el = sheet.el.querySelector('#split-rest');
    if (el) { el.textContent = money(fromCents(r)); el.classList.toggle('neg', r < 0); }
    const save = sheet.el.querySelector('#split-save');
    if (save) save.disabled = r < 0;
    const note = sheet.el.querySelector('#split-note');
    if (note && r < 0) note.textContent = `The parts add up to more than ${money(fromCents(total))}.`;
  };
  draw();
  sheet.el.addEventListener('input', (e) => {
    const k = e.target.dataset.amt;
    if (k == null) return;
    const v = Number(String(e.target.value).replace(',', '.').replace(/[^\d.]/g, ''));
    lines[+k].cents = Number.isFinite(v) ? Math.round(v * 100) : 0;
    check();
  });
  sheet.el.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      haptic();
      const k = +pick.dataset.pick;
      const c = await pickCategory(lines[k].category, false);
      if (c) { lines[k].category = c; draw(); }
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) { haptic(); lines.splice(+del.dataset.del, 1); draw(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add-line') {
      haptic();
      const c = await pickCategory(null, false);
      if (!c) return;
      lines.push({ category: c, cents: 0 });
      draw();
      sheet.el.querySelector(`[data-amt="${lines.length - 1}"]`)?.focus();
    }
    if (act === 'save' || act === 'unsplit') {
      haptic('heavy');
      const first = { ...lines[0], cents: rest() };
      // Lines in the same category are one part.
      const merged = new Map();
      for (const l of act === 'unsplit' ? [] : [first, ...lines.slice(1)]) if (l.cents > 0) merged.set(l.category, (merged.get(l.category) || 0) + l.cents);
      if (merged.size >= 2) {
        raw.parts = [...merged].map(([category, cents]) => ({ category, amount: fromCents(sign * cents) }));
      } else {
        delete raw.parts;
        if (merged.size === 1) { raw.category = [...merged.keys()][0]; raw.locked = true; }
      }
      await app.commit({ silent: true });
      toast(merged.size >= 2 ? `Split into ${merged.size}` : 'Split removed');
      sheet.close();
      onDone?.();
    }
  });
}

async function changeCategory(t, catId) {
  const cat = app.model.cats.get(catId);
  const sign = Math.sign(t.c) || -1;
  const same = app.vault.transactions.filter((x) => x.id !== t.id && x.name === t.name && (Math.sign(x.amount) || -1) === sign);
  // A store that sells everything: "only this one" is the likely intent.
  const mixed = isMixedStore(t.name, app.rules);
  const all = { label: same.length ? `Apply to All ${same.length + 1}` : 'Always', value: 'all', style: mixed ? 'default' : 'primary' };
  const one = { label: 'Only This One', value: 'one', style: mixed ? 'primary' : 'default' };
  const choice = await alertSheet({
    title: mixed ? `Just this ${t.name} charge?` : same.length ? `Apply to all ${same.length + 1} from “${t.name}”?` : `Always use ${cat.name} for “${t.name}”?`,
    message: mixed
      ? `${t.name} sells all kinds of things, so usually only this charge is ${cat.name}.${same.length ? ` Apply to all would move the other ${plural(same.length, 'charge')} too.` : ''}`
      : same.length
        ? `Changes the other ${plural(same.length, 'transaction')} too, and saves a rule so future statements put ${t.name} in ${cat.name}.`
        : `Saves a rule so future statements put ${t.name} in ${cat.name}.`,
    actions: mixed ? [one, all, { label: 'Cancel', value: null, style: 'cancel' }] : [all, one, { label: 'Cancel', value: null, style: 'cancel' }],
  });
  if (!choice) return;
  const raw = rawOf(t.id);
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
export function openCategory(catId, { ym = 'all', mode = 'everything', merchant = null, from = null, to = null, label = null } = {}) {
  const m = app.model;
  const cat = catId ? m.cats.get(catId) : null;
  const sheet = openSheet({ title: merchant || cat?.name || 'Category', size: 'full', body: '' });
  // A date range (a week, a day) works like a month: grouped by day.
  const ranged = !!(from && to);
  const byDay = ranged ? daysBetween(from, to) <= 62 : ym !== 'all';
  const draw = () => {
    const f = filterMode(mode);
    const match = (t) => (merchant ? t.name === merchant && f(t) : t.cat.id === catId && f(t));
    const all = app.model.txns.filter(match);
    const inPeriod = all.filter((t) => (ranged ? t.date >= from && t.date <= to : ym === 'all' || t.month === ym));
    const live = inPeriod.filter((t) => !t.netted);
    const total = -live.reduce((s, t) => s + t.c, 0);
    const n = live.filter((t) => t.c < 0).length;
    const first = all[0] || inPeriod[0];
    const c = cat || first?.cat || app.model.cats.get('other');
    const months = app.model.months.map((mm) => ({ ym: mm, v: fromCents(-all.filter((t) => t.month === mm && !t.netted).reduce((s, t) => s + t.c, 0)) }));
    const groups = new Map();
    for (const t of [...inPeriod].reverse()) {
      const k = byDay ? t.date : t.month;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    sheet.setBody(`
      <div class="sheet-hero">
        ${catIcon(c, 'lg')}
        <div class="when">${label ? esc(label) : ym === 'all' ? 'All months' : esc(monthLabel(ym))}${mode === 'everyday' ? ' · Everyday' : ''}</div>
        <div class="amt num">${money(fromCents(total))}</div>
        <div class="when">${plural(n, 'payment')}${n ? ` · ${money(fromCents(total / n))} average` : ''}</div>
      </div>
      ${months.length > 1 ? `<div class="card">${miniColumns(months, c.color)}</div>` : ''}
      ${[...groups.entries()].map(([k, list]) => `
        <div class="list-head"><span>${byDay ? esc(dateLabel(k)) : esc(monthLabel(k))}</span><span class="num">${money(fromCents(-list.filter((t) => !t.netted).reduce((s, t) => s + t.c, 0)))}</span></div>
        <div class="list">${list.map((t) => txnRow(t, { showDate: !byDay })).join('')}</div>`).join('') || '<div class="empty">No transactions.</div>'}`);
  };
  draw();
  sheet.el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-txn]');
    if (!r) return;
    haptic();
    openTxn(r.dataset.txn, { onChange: draw });
  });
}
