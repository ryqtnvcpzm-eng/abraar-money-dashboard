// Money — app shell: lock screen, unlock/setup, auto-lock, persistence, tabs.
import { esc } from './format.js';
import * as crypto from './crypto.js';
import * as store from './store.js';
import * as bio from './biometric.js';
import { compileRules } from './categorize.js';
import { emptyVault, buildModel } from './ledger.js';
import { icon, haptic, toast, closeAllSheets, alertSheet } from './ui.js';
import { app } from './state.js';
import { renderOverview } from './views/overview.js';
import { renderSpending } from './views/spending.js';
import { renderActivity } from './views/activity.js';
import { renderPlan } from './views/plan.js';

const VIEWS = { overview: renderOverview, spending: renderSpending, activity: renderActivity, plan: renderPlan };
const lockEl = document.getElementById('lock');
const lockBody = document.getElementById('lock-body');
const lockLead = document.getElementById('lock-lead');
const appEl = document.getElementById('app');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  registerSW();
  try {
    const r = await fetch('data/rules.json', { cache: 'no-cache' });
    app.rules = compileRules(await r.json());
  } catch {
    lockLead.textContent = 'Could not load the app files. Check your connection and reload.';
    return;
  }
  const [remote, local] = [await store.fetchRemote() || await store.fetchRemoteCached(), store.loadLocal()];
  if (remote) store.setPublishedRev(Math.max(store.publishedRev(), remote.rev));
  app.bioSupported = await bio.isSupported();
  const chosen = store.chooseVault(remote, local);
  app.env = chosen?.env || null;
  showLock();
}

// ---------------------------------------------------------------------------
// Lock screen
// ---------------------------------------------------------------------------
function showLock(message = '') {
  closeAllSheets();
  appEl.hidden = true;
  lockEl.hidden = false;
  lockEl.classList.remove('leaving');
  if (app.env) {
    // A passphrase change elsewhere gives the vault a new salt; the old biometric copy can't open it.
    if (bio.enrollment() && !bio.isEnrolledFor(app.env)) {
      bio.disable();
      message ||= `${bio.label()} was turned off because your passphrase changed. Unlock once with it to turn ${bio.label()} back on in Settings.`;
    }
    const useBio = app.bioSupported && bio.isEnrolledFor(app.env);
    lockLead.textContent = useBio ? `Unlock with ${bio.label()} or your passphrase.` : 'Enter your passphrase to unlock.';
    lockBody.innerHTML = `
      ${useBio ? `<div class="btn-row" style="margin:0 0 18px"><button class="btn" type="button" id="bio-btn">${icon(bio.label() === 'Face ID' ? 'faceid' : 'touchid')} Unlock with ${esc(bio.label())}</button></div>` : ''}
      <form class="lock-form" id="unlock-form" autocomplete="off">
        <input type="text" name="username" value="money-vault" autocomplete="username" hidden>
        <input class="field" id="pass" type="password" autocomplete="current-password" placeholder="Passphrase" aria-label="Passphrase" required>
        <button class="btn ${useBio ? 'secondary' : ''}" type="submit" id="unlock-btn">${useBio ? 'Use Passphrase' : 'Unlock'}</button>
        <div class="err" id="lock-err" role="alert">${esc(message)}</div>
      </form>
      <div class="lock-links">
        <button type="button" data-act="demo">Explore with sample data</button>
        <button type="button" data-act="file">Open a different vault file…</button>
      </div>`;
    const form = document.getElementById('unlock-form');
    const pass = document.getElementById('pass');
    const err = document.getElementById('lock-err');
    if (useBio) {
      const bioBtn = document.getElementById('bio-btn');
      const tryBio = async () => {
        bioBtn.disabled = true;
        err.textContent = '';
        try {
          const session = await bio.unlock(app.env);
          const data = await crypto.openWithSession(app.env, session);
          enter({ session, vault: data, demo: false });
        } catch (e) {
          bioBtn.disabled = false;
          if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return; // cancelled or timed out
          if (e?.message === 'WRAP_INVALID' || e?.message === 'WRONG_PASSPHRASE') {
            bio.disable();
            err.textContent = `${bio.label()} couldn't unlock this vault, so it's been turned off. Use your passphrase.`;
            document.getElementById('bio-btn')?.parentElement.remove();
          } else {
            err.textContent = `${bio.label()} didn't work this time. Use your passphrase.`;
          }
          haptic('error');
        }
      };
      bioBtn.addEventListener('click', tryBio);
      // Offer it straight away when the app opens (not right after the user locked it on purpose).
      if (!app.bioPrompted && !message) { app.bioPrompted = true; setTimeout(tryBio, 350); }
    } else {
      setTimeout(() => pass.focus(), 300);
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('unlock-btn');
      const label = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        const { session, data } = await crypto.open(app.env, pass.value);
        pass.value = '';
        enter({ session, vault: data, demo: false });
      } catch {
        haptic('error');
        btn.disabled = false;
        btn.textContent = label;
        err.textContent = 'Incorrect passphrase. Try again.';
        form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
        pass.select();
      }
    });
  } else {
    lockLead.textContent = 'Your money, private by design. Everything is encrypted with a passphrase only you know.';
    lockBody.innerHTML = `
      <div class="btn-row">
        <button class="btn" data-act="setup">Create Your Vault</button>
        <button class="btn secondary" data-act="file">Open a Vault File…</button>
        <button class="btn plain" data-act="demo">Explore with Sample Data</button>
      </div>`;
  }
  lockBody.onclick = (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'setup') showSetup();
    if (a === 'demo') startDemo();
    if (a === 'file') pickVaultFile();
  };
}

function showSetup() {
  lockLead.textContent = 'Choose a passphrase. It encrypts everything, and it can’t be recovered — so write it down somewhere safe.';
  lockBody.innerHTML = `
    <form class="lock-form" id="setup-form" autocomplete="off">
      <input type="text" name="username" value="money-vault" autocomplete="username" hidden>
      <input class="field" id="p1" type="password" autocomplete="new-password" placeholder="New passphrase" aria-label="New passphrase" minlength="12" required>
      <div class="meter" aria-hidden="true"><i id="meter"></i></div>
      <div class="hint" id="hint">At least 12 characters. Four random words work well.</div>
      <input class="field" id="p2" type="password" autocomplete="new-password" placeholder="Confirm passphrase" aria-label="Confirm passphrase" required>
      <button class="btn" type="submit" id="create-btn">Create Vault</button>
      <div class="err" id="lock-err" role="alert"></div>
    </form>
    <div class="lock-links"><button type="button" data-act="back">Back</button></div>`;
  const p1 = document.getElementById('p1');
  const meter = document.getElementById('meter');
  const hint = document.getElementById('hint');
  setTimeout(() => p1.focus(), 200);
  p1.addEventListener('input', () => {
    const bits = crypto.strength(p1.value);
    const lvl = bits < 40 ? ['red', 'Weak'] : bits < 60 ? ['orange', 'Okay'] : bits < 80 ? ['green', 'Strong'] : ['green', 'Very strong'];
    meter.style.width = Math.min(100, bits) + '%';
    meter.style.setProperty('--c', `var(--${lvl[0]})`);
    hint.textContent = p1.value.length < 12 ? 'At least 12 characters. Four random words work well.' : `${lvl[1]}. Your vault file is public, so a long passphrase is what keeps it private.`;
  });
  document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('lock-err');
    const v1 = p1.value, v2 = document.getElementById('p2').value;
    if (v1.length < 12) { err.textContent = 'Use at least 12 characters.'; haptic('error'); return; }
    if (crypto.strength(v1) < 40) { err.textContent = 'That passphrase is too easy to guess. Add another word or two.'; haptic('error'); return; }
    if (v1 !== v2) { err.textContent = 'The passphrases don’t match.'; haptic('error'); return; }
    const btn = document.getElementById('create-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    const session = await crypto.createSession(v1);
    p1.value = ''; document.getElementById('p2').value = '';
    const vault = emptyVault();
    app.env = await crypto.seal(session, vault, 1);
    store.saveLocal(app.env);
    enter({ session, vault, demo: false, firstRun: true });
  });
  lockBody.onclick = (e) => { if (e.target.closest('[data-act="back"]')) showLock(); };
}

function pickVaultFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      const env = JSON.parse(await f.text());
      if (!crypto.isEnvelope(env)) throw new Error();
      app.env = env;
      store.saveLocal(env);
      showLock();
      toast('Vault file loaded');
    } catch { toast('That isn’t a Money vault file', { icon: 'warn', color: 'orange' }); }
  };
  input.click();
}

async function startDemo() {
  const { demoVault } = await import('./demo.js');
  enter({ session: null, vault: demoVault(), demo: true });
}

// ---------------------------------------------------------------------------
// Unlocked
// ---------------------------------------------------------------------------
function enter({ session, vault, demo, firstRun = false }) {
  app.session = session;
  app.vault = vault;
  app.demo = demo;
  vault.settings ||= { autoLockMinutes: 5 };
  rebuild();
  lockEl.classList.add('leaving');
  appEl.hidden = false;
  setTimeout(() => { lockEl.hidden = true; }, 450);
  app.stale = new Set(Object.keys(VIEWS));
  selectTab(app.tab || 'overview', { force: true });
  startAutoLock();
  haptic();
  if (firstRun) setTimeout(() => import('./views/importer.js').then((m) => m.openImporter({ welcome: true })), 600);
}

export function rebuild() { app.model = buildModel(app.vault, app.rules); }

/** Persist a change: re-encrypt, store the working copy, re-render. */
app.commit = async function commit({ silent = false } = {}) {
  rebuild();
  app.stale = new Set(Object.keys(VIEWS));
  renderTab(app.tab);
  if (app.demo) { if (!silent) toast('Sample data isn’t saved', { icon: 'sparkle', color: 'indigo' }); return; }
  const rev = (app.env?.rev || 0) + 1;
  app.env = await crypto.seal(app.session, app.vault, rev);
  if (!store.saveLocal(app.env)) toast('Couldn’t save on this device — export the file', { icon: 'warn', color: 'orange' });
  renderTab(app.tab);
};
app.isDirty = () => !app.demo && !!app.env && app.env.rev > store.publishedRev();
app.lock = lock;
app.rerender = () => { app.stale = new Set(Object.keys(VIEWS)); renderTab(app.tab); };

function lock(reason = '') {
  if (!app.vault) return;
  app.bioPrompted = true;
  app.session = null;
  app.vault = null;
  app.model = null;
  for (const id of Object.keys(VIEWS)) document.getElementById(`page-${id}`).innerHTML = '';
  stopAutoLock();
  if (app.demo) { app.demo = false; showLock(); return; }
  showLock(reason);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabs = [...document.querySelectorAll('.tab')];
const lens = document.querySelector('.tab-lens');
tabs.forEach((t) => t.addEventListener('click', () => {
  haptic();
  if (t.dataset.tab === app.tab) {
    const sc = document.querySelector(`#page-${app.tab} .scroller`);
    sc?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  selectTab(t.dataset.tab);
}));
document.querySelector('.tabbar').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const i = tabs.findIndex((t) => t.dataset.tab === app.tab);
  const n = tabs[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + tabs.length) % tabs.length];
  selectTab(n.dataset.tab); n.focus();
});

export function selectTab(name, { force = false } = {}) {
  app.tab = name;
  tabs.forEach((t) => {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
  positionLens();
  if (force || app.stale.has(name)) renderTab(name);
}
app.selectTab = selectTab;

function positionLens() {
  const t = tabs.find((x) => x.dataset.tab === app.tab);
  if (!t) return;
  lens.style.width = `${t.offsetWidth}px`;
  lens.style.height = window.innerWidth >= 1000 ? `${t.offsetHeight}px` : '';
  lens.style.transform = window.innerWidth >= 1000 ? `translateY(${t.offsetTop}px)` : `translateX(${t.offsetLeft - 5}px)`;
}
window.addEventListener('resize', () => { positionLens(); clearTimeout(app._rs); app._rs = setTimeout(() => app.vault && app.rerender(), 200); });

function renderTab(name) {
  if (!app.model) return;
  const page = document.getElementById(`page-${name}`);
  const sc = page.querySelector('.scroller');
  const y = sc ? sc.scrollTop : 0;
  VIEWS[name](page);
  const sc2 = page.querySelector('.scroller');
  if (sc2 && y) sc2.scrollTop = y;
  app.stale.delete(name);
}
app.renderTab = renderTab;

// ---------------------------------------------------------------------------
// Auto-lock after inactivity, and when the app has been in the background too long
// ---------------------------------------------------------------------------
let lastActive = Date.now();
let hiddenAt = null;
let timer = null;
const bump = () => { lastActive = Date.now(); };
const limit = () => (app.vault?.settings?.autoLockMinutes ?? 5) * 60_000;
function startAutoLock() {
  lastActive = Date.now();
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => window.addEventListener(ev, bump, { passive: true, capture: true }));
  clearInterval(timer);
  timer = setInterval(() => { if (app.vault && Date.now() - lastActive > limit()) lock('Locked after inactivity.'); }, 10_000);
}
function stopAutoLock() { clearInterval(timer); }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (app.vault && hiddenAt && Date.now() - hiddenAt > Math.min(limit(), 60_000)) lock('Locked while you were away.');
  hiddenAt = null;
});

// ---------------------------------------------------------------------------
// Service worker (offline) — never caches anything but the app's own files
// ---------------------------------------------------------------------------
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          app.updateReady = true;
          if (app.vault) toast('Update ready — it applies next launch', { icon: 'sparkle', color: 'blue' });
        }
      });
    });
  }).catch(() => {});
}

app.icon = icon;
app.alert = alertSheet;
// Native apps don't zoom. CSS touch-action: manipulation stops double-tap zoom; iOS ignores
// user-scalable=no, so pinch is blocked here.
['gesturestart', 'gesturechange'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

boot();
