// Add Amazon Orders: read the order history Amazon lets you download, on this device,
// and sort every Amazon charge by what it bought.
import { app } from '../state.js';
import { money, esc, plural } from '../format.js';
import { icon, catIcon, openSheet, haptic } from '../ui.js';

const STEPS = [
  'On Amazon, go to <b>Account → Request Your Data</b> (on the app: Your Account → Login & security → Request your data).',
  'Choose <b>Your Orders</b> and submit. Amazon emails a download link, usually within a day or two.',
  'Download the zip and add it here. You can add the zip as it is, or the <b>Retail.OrderHistory</b> CSV inside it.',
];

/** Import Amazon order files picked anywhere in the app (also called from Add Statements). */
export async function importAmazonFiles(list) {
  const { readOrderFiles, applyOrders } = await import('../amazon.js');
  const ships = await readOrderFiles([...list], app.rules);
  const res = applyOrders(app.vault, ships);
  await app.commit({ silent: true });
  const cats = new Map();
  let items = 0;
  // Just what this file sorted.
  for (const t of res.sorted) for (const it of t.items || []) { if (t.amount >= 0) continue; items++; cats.set(it.category, (cats.get(it.category) || 0) + it.amount); }
  return { ...res, shipments: ships.length, items, cats: [...cats].sort((a, b) => b[1] - a[1]) };
}

export function openAmazonImport() {
  const sheet = openSheet({ title: 'Amazon Orders', size: 'full', body: '' });
  let result = null, error = null, busy = false;
  const draw = () => {
    if (result) {
      const cats = app.model.cats;
      sheet.setBody(`
        <div class="sheet-hero" style="padding-top:18px">
          <span class="cat-icon lg" style="--c:var(--${result.matched ? 'green' : 'orange'})">${icon(result.matched ? 'check' : 'box')}</span>
          <div class="name">${result.matched ? `Sorted ${plural(result.matched, 'Amazon charge')}` : 'No charges matched yet'}</div>
          <p class="when" style="max-width:340px;margin:8px auto 0">${result.matched
            ? `${plural(result.items, 'item')} from ${plural(result.shipments, 'shipment')}, matched to ${result.matched} of your ${result.charges} Amazon charges${result.refunds ? `, plus ${plural(result.refunds, 'refund')}` : ''}. Orders with more than one kind of thing are split.`
            : `Read ${plural(result.shipments, 'shipment')}, but none match an Amazon charge in your statements yet. The latest year of them is kept (encrypted), so they’ll be matched when you add those statements.`}</p>
        </div>
        ${result.cats.length ? `<div class="list-head"><span>What you bought</span></div>
        <div class="list">${result.cats.map(([id, amt]) => { const c = cats.get(id) || cats.get('shopping'); return `<div class="row with-icon">${catIcon(c)}<span class="main"><span class="title">${esc(c.name)}</span></span><span class="value">${money(amt)}</span></div>`; }).join('')}</div>` : ''}
        ${result.charges > result.matched ? `<p class="list-foot">${plural(result.charges - result.matched, 'charge')} didn’t match: often gift-card or points payments, orders in another currency, or statements you haven’t added. You can sort those by hand: tap one and pick a category, or split it.</p>` : ''}
        <div class="btn-row"><button class="btn" data-close>Done</button></div>`);
      return;
    }
    sheet.setBody(`
      <div class="sheet-hero" style="padding-top:18px">
        <span class="cat-icon lg" style="--c:var(--orange)">${icon('box')}</span>
        <div class="name">See what you bought on Amazon</div>
        <p class="when" style="max-width:350px;margin:8px auto 0">Your bank only says “Amazon”. Your order history says it was a phone case, coffee or a lamp, so each charge goes to the right category, and an order with a bit of everything is split.</p>
      </div>
      <div class="list">${STEPS.map((s, i) => `<div class="row with-icon"><span class="cat-icon sm" style="--c:var(--orange)"><b style="font:600 13px/1 var(--font)">${i + 1}</b></span><span class="main"><span class="subtitle" style="white-space:normal;color:var(--label)">${s}</span></span></div>`).join('')}</div>
      <label class="btn" style="margin-top:18px">
        ${busy ? '<span class="spinner"></span> Reading…' : `${icon('plus')} Choose Amazon File`}
        <input type="file" accept=".zip,.csv,application/zip,text/csv" hidden id="amz-file" ${busy ? 'disabled' : ''}>
      </label>
      ${error ? `<p class="list-foot neg" style="text-align:center">${esc(error)}</p>` : ''}
      <p class="list-foot">Read on this device and never uploaded. Only item names, prices, dates and categories are kept, inside your encrypted vault. Addresses, order numbers and payment details are ignored.</p>`);
  };
  draw();
  sheet.el.addEventListener('change', async (e) => {
    if (e.target.id !== 'amz-file' || !e.target.files?.length) return;
    busy = true; error = null; draw();
    try {
      result = await importAmazonFiles(e.target.files);
      haptic('success');
    } catch (err) {
      error = err?.message || 'Couldn’t read that file.';
      haptic('error');
    }
    busy = false;
    draw();
  });
}

