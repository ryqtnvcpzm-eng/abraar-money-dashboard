'use strict';
/* Abraar Money — encrypted personal finance PWA.
   Data flow: data.enc.json (AES-GCM) → unlock in memory → localStorage overrides merged on top. */

// ─── Config ────────────────────────────────────────────────────────────────
const AUTO_LOCK_MS = 5 * 60 * 1000;   // auto-lock after 5 min inactivity
const LOCK_ON_HIDE = true;            // lock when tab/app is hidden
const LS_OVERRIDES = 'mak.overrides.v1';
const LS_GH = 'mak.github.v1';
const EVERYDAY_EXCLUDE = ['Tuition & one-offs', 'Transfers'];

// ─── State ─────────────────────────────────────────────────────────────────
let passphrase = null;        // held in memory only, cleared on lock
let baseData = null;          // decrypted payload from data.enc.json
let rules = null;             // rules.json (categories, colors, merchant rules)
let overrides = loadOverrides();
let txs = [];                 // merged transactions (base + overrides + added)
let spendMonth = 'all';       // Spending tab scope
let spendScope = 'everyday';  // 'everyday' | 'all'
let lockTimer = null;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = (n, sign = false) => {
  const v = (sign && n > 0 ? '+' : '') + (n < 0 ? '−' : '') + '$' +
    Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v;
};
const fmt0 = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-CA');
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const monthLabel = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── Overrides (localStorage) ──────────────────────────────────────────────
function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(LS_OVERRIDES)) || {}; } catch { return {}; }
}
function saveOverrides() { localStorage.setItem(LS_OVERRIDES, JSON.stringify(overrides)); }
overrides.catChanges = overrides.catChanges || {};
overrides.merchantRules = overrides.merchantRules || [];
overrides.addedTx = overrides.addedTx || [];

// ─── Crypto (WebCrypto: PBKDF2-SHA256 → AES-256-GCM) ──────────────────────
const b64ToBuf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bufToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function deriveKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function decryptData(pass, encFile) {
  const key = await deriveKey(pass, b64ToBuf(encFile.kdf.salt), encFile.kdf.iterations);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(encFile.cipher.iv) }, key, b64ToBuf(encFile.ciphertext));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function encryptData(pass, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 200000;
  const key = await deriveKey(pass, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bufToB64(salt) },
           cipher: { name: 'AES-GCM', iv: bufToB64(iv) }, ciphertext: bufToB64(ct) };
}
function download(filename, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3400);
}

// ─── Data merge ────────────────────────────────────────────────────────────
function cleanName(tx) {
  let name = (tx.merchant || 'Unknown').replace(/\s+Date Description.*$/i, '').trim();
  const hit = (rules?.cleanNames || []).find((c) => name.toLowerCase().includes(c.match));
  return hit ? hit.name : name;
}
function rebuildTxs() {
  const all = [...(baseData?.transactions || []), ...overrides.addedTx];
  txs = all.map((t) => {
    let category = overrides.catChanges[t.id] || t.category;
    if (!overrides.catChanges[t.id]) {
      const rule = [...(overrides.merchantRules || [])].reverse()
        .find((r) => (t.merchant || '').toLowerCase().includes(r.keyword));
      if (rule) category = rule.category;
    }
    return { ...t, category, merchantClean: cleanName(t) };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
const catColor = (name) => (rules?.categories || []).find((c) => c.name === name)?.color || '#636366';
const catKind = (name) => (rules?.categories || []).find((c) => c.name === name)?.kind || 'spend';
function spendTxs(list) { return list.filter((t) => t.amount < 0 && catKind(t.category) !== 'income'); }

// ─── Lock / unlock ─────────────────────────────────────────────────────────
async function tryUnlock(pass) {
  const res = await fetch('data.enc.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('datafile');
  const encFile = await res.json();
  return decryptData(pass, encFile);
}
$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('#passInput').value;
  if (!pass) return;
  const btn = $('#unlockBtn'); btn.disabled = true; btn.textContent = 'Unlocking…';
  try {
    baseData = await tryUnlock(pass);
    passphrase = pass;
    $('#lockError').textContent = '';
    enterApp();
  } catch {
    const card = $('#lockCard'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    $('#lockError').textContent = 'That passphrase didn’t work. Try again.';
  } finally { btn.disabled = false; btn.textContent = 'Unlock'; }
});
function enterApp() {
  const ls = $('#lockScreen'); if (ls) ls.remove();
  $('#app').hidden = false;
  rebuildTxs();
  renderAll();
  resetLockTimer();
}
function lockApp() { location.reload(); }
$('#lockNowBtn').addEventListener('click', lockApp);
function resetLockTimer() {
  clearTimeout(lockTimer);
  if (!passphrase) return;
  lockTimer = setTimeout(lockApp, AUTO_LOCK_MS);
}
['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
  document.addEventListener(ev, resetLockTimer, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && LOCK_ON_HIDE && passphrase) lockApp();
});

// ─── Tabs & header ─────────────────────────────────────────────────────────
const TAB_TITLES = { overview: 'Overview', spending: 'Spending', activity: 'Activity', plan: 'Plan' };
$$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tab-page').forEach((p) => { p.hidden = p.id !== 'page-' + btn.dataset.tab; });
  $('#navTitleSmall').textContent = TAB_TITLES[btn.dataset.tab];
  $('#mainScroll').scrollTo?.(0, 0); window.scrollTo(0, 0);
  if (btn.dataset.tab === 'spending') requestAnimationFrame(drawMonthlyChart);
  if (btn.dataset.tab === 'overview') requestAnimationFrame(() => drawBalanceChart());
}));
window.addEventListener('scroll', () => {
  $('#navBar').classList.toggle('scrolled', window.scrollY > 42);
}, { passive: true });

// ─── Bottom sheet ──────────────────────────────────────────────────────────
function openSheet(html) {
  $('#sheetContent').innerHTML = html;
  $('#sheetBackdrop').hidden = false; $('#sheet').hidden = false;
}
function closeSheet() {
  const s = $('#sheet'), b = $('#sheetBackdrop');
  if (s) s.hidden = true; if (b) b.hidden = true;
}
$('#sheetBackdrop').addEventListener('click', closeSheet);

// ─── Canvas helpers ────────────────────────────────────────────────────────
function setupCanvas(canvas, heightCss) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = heightCss || canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ─── Overview ──────────────────────────────────────────────────────────────
let dailySeries = []; // {date, balance}
function renderOverview() {
  const sums = baseData.statementSummaries;
  const latest = sums[sums.length - 1];
  $('#ovBalance').textContent = fmt(latest.closing);
  const totalIn = txs.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalOut = -txs.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const net = totalIn - totalOut;
  $('#ovIn').textContent = fmt(totalIn);
  $('#ovOut').textContent = fmt(totalOut);
  $('#ovNetCard').textContent = fmt(net, true);
  const netEl = $('#ovNet');
  netEl.textContent = `${fmt(net, true)} since January`;
  netEl.style.color = net >= 0 ? 'var(--green)' : 'var(--red)';

  // daily running balance
  dailySeries = [];
  let bal = baseData.openingBalance;
  const byDate = {};
  txs.forEach((t) => { byDate[t.date] = (byDate[t.date] || 0) + t.amount; });
  const dates = Object.keys(byDate).sort();
  let cursor = dates.length ? dates[0] : '2026-01-01';
  const end = latest ? '2026-09-30' : cursor;
  while (cursor <= end) {
    if (byDate[cursor]) bal = +(bal + byDate[cursor]).toFixed(2);
    dailySeries.push({ date: cursor, balance: bal });
    const d = new Date(cursor + 'T12:00:00'); d.setDate(d.getDate() + 1);
    cursor = d.toISOString().slice(0, 10);
  }
  $('#chartRange').innerHTML = `<span>Jan 1, 2026</span><span>Sep 30, 2026</span>`;
  drawBalanceChart();
  renderInsights();
  $('#ovMonths').innerHTML = sums.map((s) => `
    <div class="month-row"><span class="m-name">${monthLabel(s.month)}</span>
      <span class="m-nums">in ${fmt0(s.moneyIn)} · out ${fmt0(s.moneyOut)}<br><span class="m-close">${fmt(s.closing)}</span></span></div>`).join('');
}
function drawBalanceChart(scrubIdx = -1) {
  const canvas = $('#balanceChart'); if (!canvas || !dailySeries.length) return;
  const { ctx, w, h } = setupCanvas(canvas, 190);
  const padL = 6, padR = 6, padT = 14, padB = 16;
  const vals = dailySeries.map((d) => d.balance);
  let min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(1, max - min); min -= span * 0.08; max += span * 0.08;
  const X = (i) => padL + (i / (dailySeries.length - 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);
  ctx.clearRect(0, 0, w, h);
  // gridlines
  ctx.strokeStyle = cssVar('--sep'); ctx.lineWidth = 0.5;
  [0.25, 0.55, 0.85].forEach((f) => { const y = padT + f * (h - padT - padB); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); });
  // area + line
  const grad = ctx.createLinearGradient(0, padT, 0, h);
  grad.addColorStop(0, 'rgba(10,132,255,.28)'); grad.addColorStop(1, 'rgba(10,132,255,0)');
  ctx.beginPath();
  dailySeries.forEach((d, i) => { i ? ctx.lineTo(X(i), Y(d.balance)) : ctx.moveTo(X(i), Y(d.balance)); });
  ctx.strokeStyle = '#0a84ff'; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(X(dailySeries.length - 1), h - padB); ctx.lineTo(X(0), h - padB); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // min/max labels
  ctx.fillStyle = cssVar('--text-3'); ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(fmt0(max - span * 0.08), padL, 10);
  // scrub
  if (scrubIdx >= 0 && dailySeries[scrubIdx]) {
    const d = dailySeries[scrubIdx], x = X(scrubIdx), y = Y(d.balance);
    ctx.strokeStyle = cssVar('--text-3'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
    ctx.fillStyle = '#0a84ff'; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill();
    const lbl = $('#scrubLabel');
    lbl.textContent = `${monthLabel(d.date.slice(0, 7)).split(' ')[0]} ${+d.date.slice(8)}, ${d.date.slice(0, 4)} · ${fmt(d.balance)}`;
    lbl.style.left = Math.max(0, Math.min(w - 150, x - 60)) + 'px';
    lbl.classList.add('on');
  }
}
(function initScrub() {
  const wrap = $('.chart-wrap'); if (!wrap) return;
  let scrubbing = false;
  const handle = (e) => {
    const canvas = $('#balanceChart'); const rect = canvas.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const i = Math.round((x / rect.width) * (dailySeries.length - 1));
    drawBalanceChart(Math.max(0, Math.min(dailySeries.length - 1, i)));
  };
  wrap.addEventListener('pointerdown', (e) => { scrubbing = true; wrap.setPointerCapture(e.pointerId); handle(e); });
  wrap.addEventListener('pointermove', (e) => { if (scrubbing) handle(e); });
  const end = () => { scrubbing = false; $('#scrubLabel').classList.remove('on'); drawBalanceChart(); };
  wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
})();
function renderInsights() {
  const ct = txs.filter((t) => /couche-tard/i.test(t.merchantClean));
  const ctSum = -ct.reduce((s, t) => s + Math.min(0, t.amount), 0);
  const spend = spendTxs(txs); const totalSpend = -spend.reduce((s, t) => s + t.amount, 0);
  const tuition = -spend.filter((t) => t.category === 'Tuition & one-offs').reduce((s, t) => s + t.amount, 0);
  const everyday = -spend.filter((t) => !EVERYDAY_EXCLUDE.includes(t.category)).reduce((s, t) => s + t.amount, 0);
  const peak = dailySeries.reduce((m, d) => (d.balance > m.balance ? d : m), dailySeries[0] || { balance: 0, date: '' });
  const cards = [
    { bg: 'linear-gradient(150deg,#ff9500,#ff5e3a)', h: `${ct.length} Couche-Tard stops`, p: `${fmt0(ctSum)} in small snacks and drinks — about ${fmt0(ctSum / 9)} a month in pocket-change purchases.` },
    { bg: 'linear-gradient(150deg,#5e5ce6,#af52de)', h: 'Tuition was ' + Math.round((tuition / totalSpend) * 100) + '% of all spending', p: `${fmt0(tuition)} went to McGill and one-offs. School is the story of 2026 — not daily habits.` },
    { bg: 'linear-gradient(150deg,#30d158,#0a84ff)', h: `Everyday spending ≈ ${fmt0(everyday / 9)}/mo`, p: `Without tuition, transfers and one-offs you spent ${fmt0(everyday)} in 9 months — well under your $2,030 plan.` },
    { bg: 'linear-gradient(150deg,#ff375f,#ff9500)', h: 'April was the big month', p: 'McGill payments plus the Japan trip pushed April spending to $17,785 — your largest month by far.' },
    { bg: 'linear-gradient(150deg,#0a84ff,#64d2ff)', h: `Balance peaked at ${fmt0(peak.balance)}`, p: `Back in ${monthLabel((peak.date || '2026-01').slice(0, 7))}, after winter deposits landed. It sits at $11,249 now.` },
  ];
  $('#insightScroller').innerHTML = cards.map((c) =>
    `<div class="insight-card" style="background:${c.bg}"><h4>${esc(c.h)}</h4><p>${esc(c.p)}</p></div>`).join('');
}

// ─── Spending ──────────────────────────────────────────────────────────────
function inScope(list) {
  return spendScope === 'everyday' ? list.filter((t) => !EVERYDAY_EXCLUDE.includes(t.category)) : list;
}
function renderSpending() {
  const sums = baseData.statementSummaries;
  const chips = [{ v: 'all', l: 'All 2026' }, ...sums.map((s) => ({ v: s.month, l: MONTHS[+s.month.slice(5, 7) - 1] }))];
  $('#monthChips').innerHTML = chips.map((c) =>
    `<button class="chip ${spendMonth === c.v ? 'active' : ''}" data-month="${c.v}">${c.l}</button>`).join('');
  $$('#monthChips .chip').forEach((ch) => ch.addEventListener('click', () => { spendMonth = ch.dataset.month; renderSpending(); }));

  const scoped = spendTxs(txs.filter((t) => spendMonth === 'all' || t.month === spendMonth));
  const list = inScope(scoped);
  const total = -list.reduce((s, t) => s + t.amount, 0);
  const byCat = {};
  list.forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) - t.amount; });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  $('#spendTotal').innerHTML = `${fmt(total)}<small>${spendScope === 'everyday' ? 'Everyday spending' : 'All spending'} · ${spendMonth === 'all' ? 'Jan – Sep 2026' : monthLabel(spendMonth)}</small>`;
  $('#stackBar').innerHTML = cats.map(([c, v]) =>
    `<div class="stack-seg" style="background:${catColor(c)};width:${total ? (v / total) * 100 : 0}%" title="${esc(c)}"></div>`).join('');
  $('#categoryList').innerHTML = cats.length ? cats.map(([c, v]) => `
    <button class="cat-row" data-cat="${esc(c)}">
      <span class="cat-dot" style="background:${catColor(c)}"></span>
      <span class="cat-main"><span class="cat-name">${esc(c)}</span><br><span class="cat-pct">${total ? ((v / total) * 100).toFixed(1) : 0}% · ${list.filter((t) => t.category === c).length} purchases</span></span>
      <span class="cat-amt">${fmt(v)}</span><span class="cat-chev">›</span>
    </button>`).join('') : '<div class="empty-state">No spending here.</div>';
  $$('#categoryList .cat-row').forEach((row) => row.addEventListener('click', () => openCategorySheet(row.dataset.cat)));
  renderMerchants(scoped);
  drawMonthlyChart();
}
$('#scopeEveryday').addEventListener('click', () => setScope('everyday'));
$('#scopeAll').addEventListener('click', () => setScope('all'));
function setScope(s) {
  spendScope = s;
  $('#scopeEveryday').classList.toggle('active', s === 'everyday');
  $('#scopeAll').classList.toggle('active', s === 'all');
  renderSpending();
}
function renderMerchants(scopedSpend) {
  const byM = {};
  scopedSpend.forEach((t) => {
    const m = t.merchantClean;
    byM[m] = byM[m] || { count: 0, sum: 0 };
    byM[m].count++; byM[m].sum += -t.amount;
  });
  const top = Object.entries(byM).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  $('#topMerchants').innerHTML = top.length ? top.map(([m, v]) =>
    `<div class="merch-row"><span>${esc(m)} <span class="visits">× ${v.count}</span></span><span class="m-amt">${fmt(v.sum)}</span></div>`).join('')
    : '<div class="empty-state">Nothing here yet.</div>';
}
function drawMonthlyChart() {
  const canvas = $('#monthlyChart'); if (!canvas || !baseData) return;
  const { ctx, w, h } = setupCanvas(canvas, 210);
  const padB = 22, padT = 8;
  const months = baseData.statementSummaries.map((s) => s.month);
  const catNames = (rules?.categories || []).filter((c) => c.kind !== 'income').map((c) => c.name);
  const data = months.map((mo) => {
    const list = inScope(spendTxs(txs.filter((t) => t.month === mo)));
    const byCat = {};
    list.forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) - t.amount; });
    return { mo, byCat, total: Object.values(byCat).reduce((s, v) => s + v, 0) };
  });
  const max = Math.max(...data.map((d) => d.total), 1);
  const bw = (w - 16) / data.length;
  ctx.clearRect(0, 0, w, h);
  data.forEach((d, i) => {
    let y = h - padB;
    catNames.forEach((c) => {
      const v = d.byCat[c] || 0; if (!v) return;
      const bh = (v / max) * (h - padT - padB);
      ctx.fillStyle = catColor(c);
      ctx.fillRect(8 + i * bw + 3, y - bh, bw - 6, bh);
      y -= bh;
    });
    ctx.fillStyle = cssVar('--text-3'); ctx.font = '10.5px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(MONTHS[+d.mo.slice(5, 7) - 1], 8 + i * bw + bw / 2, h - 8);
    ctx.fillStyle = cssVar('--text-2'); ctx.font = '600 10px -apple-system, sans-serif';
    ctx.fillText(fmt0(d.total), 8 + i * bw + bw / 2, y - 4);
  });
  ctx.textAlign = 'left';
  $('#monthlyLegend').innerHTML = catNames
    .filter((c) => data.some((d) => d.byCat[c]))
    .map((c) => `<span class="legend-item"><span class="cat-dot" style="background:${catColor(c)}"></span>${esc(c)}</span>`).join('');
}
function openCategorySheet(cat) {
  const list = spendTxs(txs.filter((t) => t.category === cat && (spendMonth === 'all' || t.month === spendMonth)));
  const shown = inScope(list).sort((a, b) => b.date.localeCompare(a.date));
  const total = -shown.reduce((s, t) => s + t.amount, 0);
  openSheet(`<h3>${esc(cat)}</h3><p class="sheet-sub">${shown.length} transactions · ${fmt(total)} total</p>` +
    (shown.slice(0, 60).map((t) => `
      <div class="sheet-tx"><span>${esc(t.merchantClean)}<br><span class="st-date">${t.date}</span></span><span class="tx-amt">${fmt(-t.amount)}</span></div>`).join('')
      || '<div class="empty-state">No transactions.</div>') +
    (shown.length > 60 ? `<p class="sheet-sub">Showing first 60 of ${shown.length}.</p>` : ''));
}

// ─── Activity ──────────────────────────────────────────────────────────────
function renderActivity() {
  const q = ($('#txSearch').value || '').toLowerCase();
  const list = [...txs].reverse().filter((t) =>
    !q || t.merchantClean.toLowerCase().includes(q) || t.category.toLowerCase().includes(q) || t.raw.toLowerCase().includes(q));
  const groups = {};
  list.forEach((t) => { (groups[t.date] = groups[t.date] || []).push(t); });
  const dates = Object.keys(groups).sort().reverse();
  $('#txList').innerHTML = dates.length ? dates.slice(0, 120).map((d) => {
    const dt = new Date(d + 'T12:00:00');
    const head = `${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
    return `<div class="date-header">${head}</div><div class="tx-group">` +
      groups[d].map((t) => `
        <button class="tx-row" data-tx="${t.id}">
          <span class="tx-main"><span class="tx-merchant">${esc(t.merchantClean)}</span><br><span class="tx-cat">${esc(t.category)}</span></span>
          <span class="tx-amt ${t.amount >= 0 ? 'amt-in' : 'amt-out'}">${fmt(t.amount, t.amount > 0)}</span>
        </button>`).join('') + '</div>';
  }).join('') : '<div class="empty-state">No transactions match.</div>';
  $$('#txList .tx-row').forEach((row) => row.addEventListener('click', () => openTxSheet(row.dataset.tx)));
}
$('#txSearch').addEventListener('input', renderActivity);

function openTxSheet(id) {
  const t = txs.find((x) => x.id === id); if (!t) return;
  const cats = (rules?.categories || []).map((c) => c.name);
  openSheet(`
    <h3>${esc(t.merchantClean)}</h3>
    <p class="sheet-sub">${t.date} · ${fmt(t.amount, t.amount > 0)} · from statement</p>
    <div class="field"><label>Category</label></div>
    <div class="cat-grid">${cats.map((c) => `
      <button class="cat-opt ${c === t.category ? 'selected' : ''}" data-cat="${esc(c)}">
        <span class="cat-dot" style="background:${catColor(c)}"></span>${esc(c)}</button>`).join('')}
    </div>
    <div class="switch-row"><span>Apply to all “${esc(t.merchantClean)}” transactions</span>
      <label class="switch"><input type="checkbox" id="applyAllToggle"><span class="track"></span></label></div>
    <p class="sheet-sub">Applying to all also saves a merchant rule on this device, so future statements categorize the same way.</p>
    <button class="btn-primary" id="saveTxCat">Save</button>`);
  let chosen = t.category;
  $$('#sheetContent .cat-opt').forEach((b) => b.addEventListener('click', () => {
    chosen = b.dataset.cat;
    $$('#sheetContent .cat-opt').forEach((x) => x.classList.toggle('selected', x === b));
  }));
  $('#saveTxCat').addEventListener('click', () => {
    const applyAll = $('#applyAllToggle').checked;
    if (applyAll) {
      const key = t.merchantClean.toLowerCase();
      overrides.merchantRules = overrides.merchantRules.filter((r) => r.keyword !== key);
      overrides.merchantRules.push({ keyword: key, category: chosen });
      txs.filter((x) => x.merchantClean === t.merchantClean).forEach((x) => { overrides.catChanges[x.id] = chosen; });
      toast(`All ${t.merchantClean} transactions → ${chosen}`);
    } else {
      overrides.catChanges[t.id] = chosen;
      toast('Category updated');
    }
    saveOverrides(); rebuildTxs(); renderAll(); closeSheet();
  });
}

// ─── Plan ──────────────────────────────────────────────────────────────────
function makeRing(cx, cy, r, frac, color, width) {
  const circ = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--fill)" stroke-width="${width}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"
      stroke-dasharray="${(circ * f).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"
      style="transition:stroke-dasharray 1s var(--spring)"/>`;
}
function renderPlan() {
  const plan = baseData.budgetPlan;
  $('#planSub').textContent = `Take-home ≈ ${fmt0(plan.takeHome)}/mo · save ${fmt0(plan.saveTarget)} (65%) · spend ${fmt0(plan.spendBudget)}.`;
  const latestMonth = baseData.statementSummaries[baseData.statementSummaries.length - 1].month;
  const monthTx = txs.filter((t) => t.month === latestMonth);
  const spent = -spendTxs(monthTx).filter((t) => !EVERYDAY_EXCLUDE.includes(t.category)).reduce((s, t) => s + t.amount, 0);
  const eating = -monthTx.filter((t) => t.amount < 0 && t.category === 'Restaurants & takeout').reduce((s, t) => s + t.amount, 0);
  const jobStarted = new Date() >= new Date(plan.startsOn);
  $('#ringsSvg').innerHTML =
    makeRing(100, 100, 84, jobStarted ? 0 : 0, '#30d158', 17) +
    makeRing(100, 100, 60, spent / plan.spendBudget, '#0a84ff', 17) +
    makeRing(100, 100, 36, eating / 300, '#ff9500', 17) +
    `<text x="100" y="97" text-anchor="middle" font-size="15" font-weight="800" fill="var(--text)">${jobStarted ? '' : 'Nov 2'}</text>
     <text x="100" y="115" text-anchor="middle" font-size="10.5" fill="var(--text-3)">${jobStarted ? '' : 'job starts'}</text>`;
  $('#ringsLegend').innerHTML = `
    <div class="ring-leg"><span class="ring-swatch" style="background:#30d158"></span><span><span class="rl-name">Saved</span><br><span class="rl-sub">${jobStarted ? 'Tracking live' : 'Starts Nov 2, 2026'} · target ${fmt0(plan.saveTarget)}/mo</span></span></div>
    <div class="ring-leg"><span class="ring-swatch" style="background:#0a84ff"></span><span><span class="rl-name">Spent</span><br><span class="rl-sub">${fmt0(spent)} of ${fmt0(plan.spendBudget)} · ${monthLabel(latestMonth)} preview</span></span></div>
    <div class="ring-leg"><span class="ring-swatch" style="background:#ff9500"></span><span><span class="rl-name">Eating out</span><br><span class="rl-sub">${fmt0(eating)} of $300 · ${monthLabel(latestMonth)} preview</span></span></div>`;
  $('#planNote').textContent = jobStarted
    ? 'Real tracking is on. Add each month’s statement to keep the rings honest.'
    : `Preview using ${monthLabel(latestMonth)} statement data — real budget tracking begins Nov 2026.`;
  $('#bvaTag').textContent = jobStarted ? '' : 'Preview · ' + monthLabel(latestMonth);
  // Budget vs actual: map plan allocation → data categories
  const mapping = [
    ['Housing', plan.allocation.Housing, null], ['Groceries', plan.allocation.Groceries, 'Groceries'],
    ['Restaurants/dates', plan.allocation['Restaurants/dates'], 'Restaurants & takeout'],
    ['Coffee', plan.allocation.Coffee, 'Convenience & snacks'], ['Gym', plan.allocation.Gym, null],
    ['Transit', plan.allocation.Transit, 'Transport'], ['Misc', plan.allocation.Misc, 'Shopping & household'],
    ['Flex', plan.allocation.Flex, 'Other'],
  ];
  $('#budgetBars').innerHTML = mapping.map(([name, budget, cat]) => {
    const actual = cat ? -monthTx.filter((t) => t.amount < 0 && t.category === cat).reduce((s, t) => s + t.amount, 0) : 0;
    const pct = Math.min(100, (actual / budget) * 100);
    const color = actual > budget ? 'var(--red)' : 'var(--green)';
    return `<div class="budget-row"><div class="budget-head"><span class="b-name">${name}</span>
      <span class="b-nums">${cat ? fmt0(actual) + ' / ' : '— / '}${fmt0(budget)}</span></div>
      <div class="budget-track"><div class="budget-fill" style="width:${pct}%;background:${color}"></div></div></div>`;
  }).join('') + `<p class="sheet-sub" style="margin-top:10px">Housing and Gym don’t appear in the statement account yet — they’ll show once the job starts.</p>`;
}

// ─── Add Statement (pdf.js, in-browser) ────────────────────────────────────
$('#addStatementBtn').addEventListener('click', () => $('#pdfInput').click());
$('#pdfInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const status = $('#pdfStatus');
  status.innerHTML = '<div class="card" style="margin-bottom:12px">Reading your statement…</div>';
  try {
    const parsed = await parseStatementPdf(file);
    showImportSheet(parsed);
    status.innerHTML = '';
  } catch (err) {
    console.error(err);
    status.innerHTML = `<div class="recon-bad">Couldn’t parse that PDF — check it’s a CIBC statement and try again. Nothing was added.</div>`;
  }
});
async function parseStatementPdf(file) {
  if (!window.pdfjsLib) throw new Error('pdf.js unavailable (offline first load?)');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    // group text items into visual lines by y coordinate
    const lines = {};
    tc.items.forEach((it) => {
      const y = Math.round(it.transform[5]);
      (lines[y] = lines[y] || []).push({ x: it.transform[4], s: it.str });
    });
    Object.keys(lines).sort((a, b) => b - a).forEach((y) => {
      fullText += lines[y].sort((a, b) => a.x - b.x).map((i) => i.s).join(' ') + '\n';
    });
  }
  // statement period / year
  const period = fullText.match(/For\s+([A-Z][a-z]{2})\s+\d+\s+to\s+([A-Z][a-z]{2})\s+\d+,\s+(20\d{2})/);
  const year = period ? period[3] : String(new Date().getFullYear());
  const monthName = period ? period[2] : MONTHS[new Date().getMonth()];
  const monthNum = String(MONTHS.indexOf(monthName) + 1).padStart(2, '0');
  const stmtMonth = `${year}-${monthNum}`;
  const money = (s) => parseFloat(s.replace(/[$,]/g, ''));
  const openM = fullText.match(/Opening balance[^$\d]*\$?([\d,]+\.\d{2})/i);
  const closeM = fullText.match(/Closing balance[^$\d]*\$?([\d,]+\.\d{2})/i);
  // balance-step method: lines with >= 2 money values; last = balance, previous = amount
  const moneyRe = /\$?-?[\d,]+\.\d{2}/g;
  const rawLines = fullText.split('\n');
  let prevBal = openM ? money(openM[1]) : null;
  const found = [];
  let current = null;
  const flush = () => { if (current && current.delta) found.push(current); current = null; };
  for (const raw of rawLines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || /account number|branch transit|10774E|continued/i.test(line)) continue;
    const monies = [...line.matchAll(moneyRe)].map((m) => money(m[0]));
    if (/Opening balance/i.test(line) && monies.length) { flush(); prevBal = monies[monies.length - 1]; continue; }
    if (/Balance forward/i.test(line) && monies.length) { flush(); prevBal = monies[monies.length - 1]; continue; }
    if (/Closing balance/i.test(line)) { flush(); continue; }
    if (monies.length >= 2 && !line.includes('@')) {
      flush();
      const bal = monies[monies.length - 1];
      const delta = prevBal == null ? null : +(bal - prevBal).toFixed(2);
      current = { desc: line, delta, bal };
      prevBal = bal;
    } else if (current && line.length > 1) {
      current.desc += ' ' + line;
    }
  }
  flush();
  // build transactions, dedupe against existing
  const existingKey = (t) => `${t.date}|${t.amount.toFixed(2)}|${t.merchantClean.toLowerCase()}`;
  const seen = new Set(txs.map(existingKey));
  const added = []; const dupes = [];
  const dateRe = new RegExp(`^(${MONTHS.join('|')})\\s+(\\d{1,2})\\b`);
  found.forEach((f, i) => {
    const dm = f.desc.match(dateRe);
    const day = dm ? String(+dm[2]).padStart(2, '0') : '01';
    const mName = dm ? dm[1] : monthName;
    const date = `${year}-${String(MONTHS.indexOf(mName) + 1).padStart(2, '0')}-${day}`;
    const merchantRaw = f.desc.replace(dateRe, '').replace(/-?[\d,]+\.\d{2}/g, '').replace(/\s+/g, ' ').trim();
    const tx = { id: 'tx-new-' + Date.now() + '-' + i, date, month: date.slice(0, 7),
      merchant: titleCase(merchantRaw.slice(0, 60) || 'Unknown'), raw: f.desc.slice(0, 140), amount: f.delta,
      category: 'Other' };
    tx.merchantClean = cleanName(tx);
    tx.category = categorize(tx);
    if (seen.has(existingKey(tx))) dupes.push(tx); else { added.push(tx); seen.add(existingKey(tx)); }
  });
  const pIn = added.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const pOut = -added.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const recon = { opening: openM ? money(openM[1]) : null, closing: closeM ? money(closeM[1]) : null,
    parsedIn: +pIn.toFixed(2), parsedOut: +pOut.toFixed(2), added, dupes, stmtMonth };
  if (recon.opening != null && recon.closing != null) {
    recon.expectedNet = +(recon.closing - recon.opening).toFixed(2);
    recon.parsedNet = +(pIn - pOut).toFixed(2);
    recon.matches = Math.abs(recon.expectedNet - recon.parsedNet) < 0.02;
  }
  return recon;
}
function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
function categorize(tx) {
  if (tx.amount > 0) return 'Income';
  const hay = (tx.merchantClean + ' ' + tx.raw).toLowerCase();
  const allRules = [...(rules?.merchantRules || []), ...(overrides.merchantRules || [])];
  for (const r of allRules) if (hay.includes(r.keyword)) return r.category;
  return 'Other';
}
function showImportSheet(r) {
  const reconHtml = (r.opening != null && r.closing != null)
    ? (r.matches
      ? `<div class="recon-ok">✓ Reconciled: ${fmt(r.parsedIn)} in, ${fmt(r.parsedOut)} out — matches the statement (open ${fmt(r.opening)} → close ${fmt(r.closing)}).</div>`
      : `<div class="recon-bad">⚠ Doesn’t reconcile: parsed net ${fmt(r.parsedNet, true)} but the statement moved ${fmt(r.expectedNet, true)} (open ${fmt(r.opening)} → close ${fmt(r.closing)}). You can still add these, but check for missing lines.</div>`)
    : `<div class="recon-bad">Couldn’t find opening/closing balances in the PDF, so reconciliation wasn’t possible.</div>`;
  openSheet(`<h3>Add statement · ${monthLabel(r.stmtMonth)}</h3>
    <p class="sheet-sub">${r.added.length} new transactions · ${r.dupes.length} duplicates skipped</p>
    ${reconHtml}
    ${r.added.slice(0, 25).map((t) => `<div class="sheet-tx"><span>${esc(t.merchantClean)}<br><span class="st-date">${t.date} · ${esc(t.category)}</span></span><span class="tx-amt ${t.amount >= 0 ? 'amt-in' : ''}">${fmt(t.amount, t.amount > 0)}</span></div>`).join('')}
    ${r.added.length > 25 ? `<p class="sheet-sub">…and ${r.added.length - 25} more.</p>` : ''}
    <button class="btn-primary" id="confirmImport" ${r.added.length ? '' : 'disabled'}>Add ${r.added.length} transactions</button>
    <button class="btn-secondary" id="cancelImport">Cancel</button>`);
  $('#cancelImport').addEventListener('click', closeSheet);
  $('#confirmImport').addEventListener('click', () => {
    overrides.addedTx.push(...r.added.map(({ merchantClean, ...rest }) => rest));
    saveOverrides(); rebuildTxs(); renderAll(); closeSheet();
    toast(`Added ${r.added.length} transactions. Export the encrypted file (Plan tab) to make it permanent.`);
  });
}

// ─── Settings / export ─────────────────────────────────────────────────────
function currentPayload() {
  return { ...baseData, transactions: txs.map(({ merchantClean, ...rest }) => rest), exportedAt: new Date().toISOString() };
}
$('#changePassBtn').addEventListener('click', () => {
  openSheet(`<h3>Change passphrase</h3>
    <p class="sheet-sub">Set your own passphrase, then download the newly encrypted <b>data.enc.json</b> and replace the file in your repo. Until you do, the temporary passphrase still works.</p>
    <div class="field"><label>New passphrase</label><input type="password" id="newPass1" autocomplete="new-password"></div>
    <div class="field"><label>Confirm passphrase</label><input type="password" id="newPass2" autocomplete="new-password"></div>
    <button class="btn-primary" id="doChangePass">Encrypt &amp; download data.enc.json</button>`);
  $('#doChangePass').addEventListener('click', async () => {
    const p1 = $('#newPass1').value, p2 = $('#newPass2').value;
    if (p1.length < 8) return toast('Use at least 8 characters.');
    if (p1 !== p2) return toast('Passphrases don’t match.');
    const enc = await encryptData(p1, currentPayload());
    download('data.enc.json', JSON.stringify(enc, null, 2));
    passphrase = p1;
    toast('Encrypted file downloaded — commit it to replace the old one.');
    closeSheet();
  });
});
$('#exportTxBtn').addEventListener('click', () => {
  download('transactions-backup.json', JSON.stringify(txs.map(({ merchantClean, ...rest }) => rest), null, 2));
  toast('Backup downloaded (unencrypted — keep it safe).');
});
$('#exportRulesBtn').addEventListener('click', () => {
  const merged = JSON.parse(JSON.stringify(rules));
  const existing = new Set(merged.merchantRules.map((r) => r.keyword));
  overrides.merchantRules.forEach((r) => { if (!existing.has(r.keyword)) merged.merchantRules.push(r); });
  merged.onDeviceOverrides = overrides.catChanges;
  download('rules.json', JSON.stringify(merged, null, 2));
  toast('Rules downloaded — commit it to update the repo copy.');
});
$('#resetBtn').addEventListener('click', () => {
  openSheet(`<h3>Reset to statement data?</h3>
    <p class="sheet-sub">This removes your on-device category changes, merchant rules and any added statements. The encrypted statement data is untouched.</p>
    <button class="btn-primary" id="doReset" style="background:var(--red)">Reset my edits</button>
    <button class="btn-secondary" id="cancelReset">Keep my edits</button>`);
  $('#cancelReset').addEventListener('click', closeSheet);
  $('#doReset').addEventListener('click', () => {
    overrides = { catChanges: {}, merchantRules: [], addedTx: [] };
    saveOverrides(); rebuildTxs(); renderAll(); closeSheet(); toast('Back to pure statement data.');
  });
});
$('#ghCommitBtn').addEventListener('click', () => {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS_GH)) || {}; } catch { return {}; } })();
  openSheet(`<h3>Commit to GitHub (optional)</h3>
    <p class="sheet-sub">Advanced: pushes the encrypted <b>data.enc.json</b> straight to your private repo. Your token is stored <b>only in this browser</b> (localStorage) and sent only to api.github.com. Use a fine-grained token limited to this one repository, Contents: read &amp; write.</p>
    <div class="field"><label>Repository (owner/name)</label><input id="ghRepo" placeholder="you/abraar-money-dashboard" value="${esc(saved.repo || '')}"></div>
    <div class="field"><label>File path</label><input id="ghPath" value="${esc(saved.path || 'data.enc.json')}"></div>
    <div class="field"><label>GitHub token</label><input type="password" id="ghToken" placeholder="github_pat_…" value="${esc(saved.token || '')}"></div>
    <button class="btn-primary" id="doGhCommit">Encrypt with my passphrase &amp; commit</button>`);
  $('#doGhCommit').addEventListener('click', async () => {
    const repo = $('#ghRepo').value.trim(), path = $('#ghPath').value.trim() || 'data.enc.json', token = $('#ghToken').value.trim();
    if (!repo || !token) return toast('Repo and token are required.');
    localStorage.setItem(LS_GH, JSON.stringify({ repo, path, token }));
    try {
      const enc = await encryptData(passphrase, currentPayload());
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(enc, null, 2))));
      const api = `https://api.github.com/repos/${repo}/contents/${path}`;
      const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
      let sha;
      const cur = await fetch(api, { headers });
      if (cur.ok) sha = (await cur.json()).sha;
      const res = await fetch(api, { method: 'PUT', headers,
        body: JSON.stringify({ message: 'Update encrypted data', content, sha }) });
      if (!res.ok) throw new Error('GitHub ' + res.status);
      toast('Committed to GitHub ✓'); closeSheet();
    } catch (e) { toast('Commit failed — check repo, path and token scope.'); }
  });
});

// ─── Render / init ─────────────────────────────────────────────────────────
function renderAll() { renderOverview(); renderSpending(); renderActivity(); renderPlan(); }
window.addEventListener('resize', () => { if (passphrase) { drawBalanceChart(); drawMonthlyChart(); } });
(async function init() {
  try { rules = await (await fetch('rules.json')).json(); } catch { rules = { categories: [], merchantRules: [], cleanNames: [] }; }
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js?v=5'); } catch (e) { /* offline support optional */ }
  }
  setTimeout(() => $('#passInput').focus(), 300);
})();
