// Amazon order history: what each "Amazon" charge on a statement actually bought.
// Reads the "Your Orders" zip (or its CSV) from Amazon's Request Your Data page on this device,
// groups items into the shipments Amazon charges for, and matches each to its bank charge.
// Only item names, prices, dates and a category are kept (inside the encrypted vault):
// order numbers, addresses, payment and tracking details are never stored.
import { decodeText, splitRows, detectDelimiter } from './file-formats.js';
import { productCategory, normText } from './categorize.js';
import { toCents, daysBetween, addDays, iso } from './format.js';

// ---------------------------------------------------------------------------
// Zip files (stored or deflated entries; enough for Amazon's export)
// ---------------------------------------------------------------------------
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const isZip = (bytes) => bytes.length > 4 && u32(bytes, 0) === 0x04034b50;

/** The files in a zip whose name passes want(name): [{ name, bytes }]. Zips inside it are opened too. */
export async function unzip(bytes, want = () => true, depth = 0) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This zip file looks damaged.');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const names = new TextDecoder();
  const out = [];
  for (let k = 0; k < count && u32(bytes, p) === 0x02014b50; k++) {
    const method = u16(bytes, p + 10);
    const size = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const nested = /\.zip$/i.test(name) && depth < 2;
    if (name.endsWith('/') || (!want(name) && !nested)) continue;
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const raw = bytes.subarray(start, start + size);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflate(raw);
    else continue;
    if (nested) out.push(...(await unzip(data, want, depth + 1)));
    else out.push({ name, bytes: data });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the order history
// ---------------------------------------------------------------------------
// Only these columns are ever looked at; everything else in a row is dropped as it's read.
const COLS = {
  order: ['order id', 'order number', 'orderid'],
  date: ['order date', 'orderdate', 'date'],
  ship: ['ship date', 'shipment date', 'shipped date'],
  title: ['product name', 'title', 'item', 'item name', 'product', 'description'],
  total: ['total owed', 'item total', 'total', 'total charged', 'amount'],
  subtotal: ['shipment item subtotal', 'item subtotal', 'subtotal'],
  subtotalTax: ['shipment item subtotal tax', 'item subtotal tax'],
  unit: ['unit price', 'purchase price per unit', 'price'],
  unitTax: ['unit price tax'],
  qty: ['quantity', 'qty', 'original quantity'],
  dept: ['category', 'product category', 'department'],
  status: ['order status', 'shipment status', 'status'],
  currency: ['currency', 'currency code'],
};

function columns(header) {
  const h = header.map((c) => normText(c));
  const at = {};
  for (const [role, names] of Object.entries(COLS)) {
    for (const n of names) { const i = h.indexOf(normText(n)); if (i >= 0 && !Object.values(at).includes(i)) { at[role] = i; break; } }
  }
  return at;
}

function money(s) {
  if (s == null) return null;
  const t = String(s).replace(/[^\d.,-]/g, '');
  if (!t || !/\d/.test(t)) return null;
  // "1,234.56" or "1.234,56"
  const n = /,\d{2}$/.test(t) ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function day(s) {
  s = String(s || '').trim();
  if (!s || /not available|n\/a/i.test(s)) return null;
  // "2024-03-15T02:10:00Z": a UTC timestamp, shown as the local day (as the bank does).
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = new Date(s); return Number.isNaN(+d) ? s.slice(0, 10) : iso(d); }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s); // Amazon's older reports: US order
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    // Month first (Amazon US), unless the first number can't be a month (25/03/2024).
    const [mo, d] = Number(m[1]) > 12 ? [m[2], m[1]] : [m[1], m[2]];
    if (Number(mo) > 12 || Number(d) > 31) return null;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(+d) ? null : iso(d);
}

/** Does this CSV look like an Amazon order history? */
export function looksLikeOrders(text) {
  const head = normText(text.slice(0, 2000));
  return /order id|order number/.test(head) && /product name|title/.test(head) && /order date/.test(head);
}

/**
 * Order-history CSV text → shipments: [{ date, ship, cents, currency, items: [{ title, amount, category, qty }] }].
 * Amazon charges once per shipment, so items are grouped by order and ship date.
 */
export function parseOrders(text, compiled) {
  const rows = splitRows(text.replace(/^﻿/, ''), detectDelimiter(text));
  if (rows.length < 2) return [];
  const at = columns(rows[0]);
  if (at.title == null || at.date == null) throw new Error('This doesn’t look like an Amazon order history.');
  const groups = new Map();
  for (const r of rows.slice(1)) {
    const get = (k) => (at[k] == null ? '' : r[at[k]] ?? '');
    if (/cancel/i.test(get('status'))) continue;
    const date = day(get('date'));
    const title = get('title').replace(/\s+/g, ' ').trim();
    if (!date || !title) continue;
    const qty = Math.max(1, Number(get('qty')) || 1);
    let amount = money(get('total'));
    if (amount == null) {
      const sub = money(get('subtotal'));
      amount = sub != null ? sub + (money(get('subtotalTax')) || 0) : money(get('unit')) != null ? (money(get('unit')) + (money(get('unitTax')) || 0)) * qty : null;
    }
    if (amount == null || amount <= 0) continue;
    const ship = day(get('ship'));
    const order = get('order') || `${date}|${title}`;
    const key = `${order}|${ship || ''}`;
    const g = groups.get(key) || { order, date, ship, cents: 0, currency: get('currency').toUpperCase() || null, items: [] };
    g.cents += toCents(amount);
    g.items.push({ title: title.slice(0, 90), amount: Math.round(amount * 100) / 100, category: productCategory(title, get('dept'), compiled) || 'shopping', qty });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Read whatever the user picked (zip or CSV) into shipments. */
export async function readOrderFiles(files, compiled) {
  const out = [];
  for (const f of files) {
    const bytes = f.bytes || new Uint8Array(await f.arrayBuffer());
    const texts = [];
    if (isZip(bytes)) {
      // The retail order history; digital orders are already told apart by their statement descriptor.
      for (const e of await unzip(bytes, (n) => /\.csv$/i.test(n) && !/digital|return|refund|cart|wishlist|address|payment/i.test(n.split('/').pop()))) texts.push(decodeText(e.bytes));
    } else texts.push(decodeText(bytes));
    for (const t of texts) if (looksLikeOrders(t)) out.push(...parseOrders(t, compiled));
  }
  // Several files (Retail.OrderHistory.1, .2…) each run in their own order: one timeline.
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!out.length) throw new Error('No Amazon orders found. Pick the “Your Orders” zip from Amazon’s Request Your Data page, or its Retail.OrderHistory CSV.');
  return out;
}

// ---------------------------------------------------------------------------
// Matching orders to bank charges
// ---------------------------------------------------------------------------
const OTHER_AMAZON = /PRIME|DIGITAL|KINDLE|AUDIBLE|MUSIC|FRESH|PHARMACY|WEB SERVICES|\bAWS\b|WHOLE ?F/i;
/** An Amazon shopping charge (not Prime, Kindle, Fresh…) */
export const isAmazonCharge = (t) => /^amazon$/i.test(t.name || '') || (/AMAZON|AMZN/i.test(t.merchant || '') && !OTHER_AMAZON.test(t.merchant || ''));

/**
 * Attach the items each Amazon charge paid for (t.items).
 * Shipments are matched by exact amount, within a few days of shipping (or ordering);
 * a whole order charged at once is tried next; refunds take the category of the item they match.
 * fresh: a newly read order history, which re-sorts the charges in the dates it covers
 * (your own fixes to an item's category are kept). Otherwise only charges not sorted yet are tried.
 * Returns { charges, matched, refunds, left } where left = shipments no charge matched.
 */
export function matchOrders(vault, ships = vault.orders || [], { fresh = false } = {}) {
  const charges = vault.transactions.filter((t) => isAmazonCharge(t) && !t.parts);
  // Only charges in the dates the order history covers (refunds can come months later).
  const lo = ships.length ? addDays(ships[0].date, -2) : '9999';
  const hi = ships.reduce((m, x) => ((x.ship || x.date) > m ? x.ship || x.date : m), '0000');
  const covered = (t) => t.date >= lo && t.date <= addDays(hi, t.amount < 0 ? 25 : 120);
  const fixed = new Map();
  if (fresh) {
    for (const t of charges) for (const it of t.items || []) if (it.set) fixed.set(it.title, it.category);
    for (const t of charges) if (covered(t)) delete t.items;
  }
  const open = charges.filter((t) => !t.items);
  const used = new Set();
  const take = (cents, from, lo2, hi2) => {
    let best = null;
    for (const t of open) {
      if (used.has(t) || t.amount >= 0 || Math.abs(toCents(-t.amount) - cents) > 1) continue;
      const d = daysBetween(from, t.date);
      if (d < lo2 || d > hi2) continue;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { t, d };
    }
    if (best) used.add(best.t);
    return best?.t || null;
  };
  const sorted = [];
  const attach = (t, items) => { t.items = items.map((it) => ({ ...it, ...(fixed.has(it.title) ? { category: fixed.get(it.title), set: true } : {}) })); sorted.push(t); };
  let matched = 0;
  const left = [];
  for (const s of [...ships].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const t = s.ship ? take(s.cents, s.ship, -3, 10) || take(s.cents, s.date, -1, 21) : take(s.cents, s.date, -1, 21);
    if (t) { attach(t, s.items); matched++; } else left.push(s);
  }
  // Some regions charge the whole order at once.
  const byOrder = new Map();
  for (const s of left) { if (!s.ref) continue; const o = byOrder.get(s.ref) || { date: s.date, cents: 0, items: [], ships: [] }; o.cents += s.cents; o.items.push(...s.items); o.ships.push(s); byOrder.set(s.ref, o); }
  const done = new Set();
  for (const o of byOrder.values()) {
    if (o.ships.length < 2) continue;
    const t = take(o.cents, o.date, -1, 21);
    if (t) { attach(t, o.items); matched++; for (const s of o.ships) done.add(s); }
  }
  // Refunds: money back for one item takes that item's category.
  let refunds = 0;
  const items = ships.flatMap((s) => s.items.map((it) => ({ it, date: s.ship || s.date })));
  for (const t of open) {
    if (t.amount <= 0 || !covered(t)) continue;
    const c = toCents(t.amount);
    const hit = items.filter(({ it, date }) => Math.abs(toCents(it.amount) - c) <= 1 && daysBetween(date, t.date) >= 0 && daysBetween(date, t.date) <= 120).pop();
    if (hit) { attach(t, [{ ...hit.it, amount: t.amount }]); refunds++; }
  }
  return { charges: charges.filter((t) => t.amount < 0 && covered(t)).length, matched, refunds, left: left.filter((s) => !done.has(s)), sorted };
}

/**
 * Read order history into the vault: re-sort the Amazon charges it covers, then keep only the shipments
 * no statement has yet (so a statement added later can still be sorted). No order numbers are kept.
 */
export function applyOrders(vault, shipments) {
  const refs = new Map();
  const from = shipments.length ? shipments[0].date : null;
  const to = shipments.length ? shipments[shipments.length - 1].date : null;
  // A short reference links shipments of one order (for whole-order charges) without keeping the order number.
  const slim = shipments.map((s) => {
    if (!refs.has(s.order)) refs.set(s.order, `${from}:${refs.size + 1}`);
    return { date: s.date, ship: s.ship || undefined, cents: s.cents, ref: refs.get(s.order), items: s.items.map(({ title, amount, category, qty }) => (qty > 1 ? { title, amount, category, qty } : { title, amount, category })) };
  });
  const res = matchOrders(vault, slim, { fresh: true });
  keepWaiting(vault, (vault.orders || []).filter((s) => s.date < from || s.date > to).concat(res.left));
  return res;
}

/** After statements are added: sort what the waiting shipments can now match. */
export function matchWaiting(vault) {
  if (!vault.orders?.length) return null;
  const res = matchOrders(vault, vault.orders);
  keepWaiting(vault, res.left);
  return res;
}

// Shipments waiting for their statement: the latest year of them, at most 1,500, to keep the vault small.
function keepWaiting(vault, list) {
  const all = list.sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = all.length ? all[all.length - 1].date : null;
  const cutoff = last ? `${Number(last.slice(0, 4)) - 1}${last.slice(4)}` : null;
  vault.orders = all.filter((s) => s.date >= cutoff).slice(-1500);
  if (!vault.orders.length) delete vault.orders;
}

export const _test = { day, money, columns };
