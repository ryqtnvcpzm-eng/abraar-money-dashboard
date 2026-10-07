// UI primitives: icons, haptics, toasts, bottom sheets, alerts, segmented controls, large titles.
import { esc } from './format.js';

export const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
export const catIcon = (cat, size = '') => `<span class="cat-icon ${size}" style="--c:var(--${esc(cat.color)})">${icon(cat.icon)}</span>`;
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Light haptic tap. iOS 18+: toggling a switch-style checkbox through its label; elsewhere the Vibration API. */
export function haptic(kind = 'light') {
  try {
    if (navigator.vibrate) { navigator.vibrate(kind === 'heavy' ? 18 : kind === 'error' ? [12, 60, 12] : 8); return; }
    const label = document.getElementById('haptic');
    if (label) label.click();
  } catch { /* no haptics available */ }
}

// ---------- toast ----------
let toastTimer;
export function toast(text, { icon: ic = 'check', color = 'green' } = {}) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span class="ic" style="--c:var(--${color})">${icon(ic)}</span><span>${esc(text)}</span>`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------- sheets ----------
const stack = [];

/**
 * Open a bottom sheet.
 * opts: { title, body (html), size: 'auto'|'full', left/right (html for header buttons), onMount(el, api), onClose() }
 * Returns { el, close, setBody(html), setTitle(t) }.
 */
export function openSheet(opts) {
  const root = document.getElementById('sheets');
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  const el = document.createElement('div');
  el.className = 'sheet' + (opts.size === 'full' ? ' full' : '');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', opts.title || 'Sheet');
  el.tabIndex = -1;
  el.innerHTML = `
    <div class="grabber" aria-hidden="true"></div>
    <div class="sheet-head">
      <div class="l">${opts.left || ''}</div>
      <h2>${esc(opts.title || '')}</h2>
      <div class="r">${opts.right ?? `<button class="glass-btn" data-close aria-label="Close">${icon('close')}</button>`}</div>
    </div>
    <div class="sheet-body">${opts.body || ''}</div>`;
  root.append(scrim, el);
  const prevFocus = document.activeElement;

  let closed = false;
  const api = {
    el,
    body: el.querySelector('.sheet-body'),
    setBody(html) { api.body.innerHTML = html; },
    setTitle(t) { el.querySelector('.sheet-head h2').textContent = t; },
    close,
  };
  function close(result) {
    if (closed) return;
    closed = true;
    el.classList.remove('open');
    scrim.classList.remove('open');
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    updateBehind();
    const done = () => { el.remove(); scrim.remove(); };
    if (reducedMotion()) setTimeout(done, 150); else setTimeout(done, 480);
    opts.onClose?.(result);
    if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
  }
  scrim.addEventListener('click', () => close());
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) { haptic(); close(); } });
  enableDrag(el, close);
  stack.push(api);
  opts.onMount?.(el, api);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.classList.add('open');
    scrim.classList.add('open');
    updateBehind();
    el.focus({ preventScroll: true });
  }));
  return api;
}

export function closeAllSheets() { [...stack].reverse().forEach((s) => s.close()); }
export const topSheet = () => stack[stack.length - 1];

// The app behind the sheet recedes slightly, like iOS card presentation (phones only).
function updateBehind() {
  const app = document.getElementById('app');
  const on = stack.length > 0 && window.innerWidth < 1000 && !reducedMotion();
  app.classList.add('behind');
  app.style.transform = on ? 'scale(.94) translateY(8px)' : '';
  app.style.borderRadius = on ? '24px' : '';
  app.style.overflow = on ? 'hidden' : '';
  app.style.filter = stack.length > 1 ? 'brightness(.9)' : '';
}

// Drag the sheet down from its header (or from the body when scrolled to the top) to dismiss.
function enableDrag(el, close) {
  const head = el.querySelector('.sheet-head');
  const body = el.querySelector('.sheet-body');
  let startY = 0, dy = 0, t0 = 0, dragging = false, fromBody = false, id = null;
  const down = (e, isBody) => {
    if (window.innerWidth >= 1000) return;
    if (e.target.closest('button, input, select, textarea, a, label')) return;
    if (isBody && body.scrollTop > 0) return;
    id = e.pointerId; startY = e.clientY; dy = 0; t0 = performance.now(); dragging = false; fromBody = isBody;
  };
  const move = (e) => {
    if (e.pointerId !== id) return;
    const d = e.clientY - startY;
    if (!dragging) {
      if (d > 6 && (!fromBody || body.scrollTop <= 0)) { dragging = true; el.classList.add('dragging'); el.setPointerCapture?.(id); } else if (d < -4) { id = null; return; } else return;
    }
    dy = Math.max(0, d);
    const rubber = d < 0 ? d / 4 : dy;
    el.style.transform = `translateY(${rubber}px)`;
    e.preventDefault();
  };
  const up = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    if (!dragging) return;
    el.classList.remove('dragging');
    const v = dy / Math.max(1, performance.now() - t0);
    el.style.transform = '';
    if (dy > el.offsetHeight * 0.3 || v > 0.6) { haptic(); close(); }
  };
  head.addEventListener('pointerdown', (e) => down(e, false));
  body.addEventListener('pointerdown', (e) => down(e, true));
  el.addEventListener('pointermove', move, { passive: false });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

// ---------- alert ----------
/** iOS-style centered alert. actions: [{label, value, style: 'default'|'cancel'|'destructive'|'primary'}] → Promise<value> */
export function alertSheet({ title, message = '', actions }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'alert-wrap';
    wrap.innerHTML = `<div class="alert" role="alertdialog" aria-modal="true" aria-labelledby="al-t"><h3 id="al-t">${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}
      ${actions.map((a, i) => `<button class="btn ${a.style === 'cancel' ? 'plain' : a.style === 'destructive' ? 'destructive' : a.style === 'primary' ? '' : 'secondary'}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>`;
    document.body.append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    const done = (v) => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 250); resolve(v); };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) { haptic(); done(actions[+b.dataset.i].value); } else if (e.target === wrap) done(actions.find((a) => a.style === 'cancel')?.value);
    });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(actions.find((a) => a.style === 'cancel')?.value); });
    setTimeout(() => wrap.querySelector('.btn')?.focus(), 50);
  });
}

// ---------- segmented control ----------
/** Markup for a segmented control. items: [[value, label]] */
export function segmented(name, items, value, cls = '') {
  return `<div class="segmented ${cls}" role="group" data-seg="${name}" style="grid-template-columns:repeat(${items.length},1fr)">
    <span class="thumb" aria-hidden="true"></span>
    ${items.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v === value}">${esc(l)}</button>`).join('')}</div>`;
}
/** Position segmented thumbs (call after render). */
export function layoutSegmented(root) {
  root.querySelectorAll('.segmented').forEach((seg) => {
    const btns = [...seg.querySelectorAll('button')];
    const i = Math.max(0, btns.findIndex((b) => b.getAttribute('aria-pressed') === 'true'));
    const thumb = seg.querySelector('.thumb');
    thumb.style.width = `calc((100% - 4px) / ${btns.length})`;
    thumb.style.transform = `translateX(${i * 100}%)`;
  });
}

// ---------- large title collapse ----------
/** Wire a page's scroller to its nav bar: compact title + frosted bar once the large title scrolls away. */
export function wireLargeTitle(page) {
  const scroller = page.querySelector('.scroller');
  const bar = page.querySelector('.navbar');
  const title = page.querySelector('.large-title');
  if (!scroller || !bar || !title) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    const y = scroller.scrollTop;
    bar.classList.toggle('scrolled', y > title.offsetTop + title.offsetHeight - 44 - 20);
    // Pull-down stretch, like UIKit's large titles
    title.style.transform = y < 0 ? `scale(${Math.min(1.12, 1 + -y / 900)})` : '';
  };
  scroller.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();
}

/** Standard page skeleton. */
export function pageFrame({ title, sub = '', left = '', right = '', body }) {
  return `
    <header class="navbar"><div class="nav-left">${left}</div><div class="nav-title">${esc(title)}</div><div class="nav-right">${right}</div></header>
    <div class="scroller"><div class="content">
      <div class="large-title"><div><h1 class="t-large">${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>
      ${body}
    </div></div>`;
}

// Escape closes the top-most sheet wherever focus is (alerts handle their own Escape first).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('.alert-wrap')) return;
  const top = topSheet();
  if (top) { e.preventDefault(); top.close(); }
});
