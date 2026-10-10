// Money — app shell: lock screen, unlock/setup, auto-lock, persistence, tabs.
import { esc, setCurrency } from './format.js';
import * as crypto from './crypto.js';
import * as store from './store.js';
import * as bio from './biometric.js';
import * as cloud from './cloud.js';
import { compileRules } from './categorize.js';
import { emptyVault, buildModel } from './ledger.js';
import { icon, haptic, toast, closeAllSheets, alertSheet, sheetMoving } from './ui.js';
import { app } from './state.js';
import { renderOverview } from './views/overview.js';
import { renderSpending } from './views/spending.js';
import { renderActivity } from './views/activity.js';
import { recoveryCardHTML, wireRecoveryCard } from './views/recovery.js';

const VIEWS = { overview: renderOverview, spending: renderSpending, activity: renderActivity };
const lockEl = document.getElementById('lock');
const lockBody = document.getElementById('lock-body');
const lockLead = document.getElementById('lock-lead');
const appEl = document.getElementById('app');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Two kinds of vault:
//   • cloud accounts (username + passphrase, synced through the Cloudflare API) — one per person
//   • the original single vault (data/vault.enc.json in the repo, or a copy kept on this device)
async function boot() {
  registerSW();
  try {
    const r = await fetch('data/rules.json', { cache: 'no-cache' });
    app.rules = compileRules(await r.json());
  } catch {
    lockLead.textContent = 'Could not load the app files. Check your connection and reload.';
    return;
  }
  const [remote, local, bioOK, cloudOK] = await Promise.all([
    store.fetchRemote().then((r) => r || store.fetchRemoteCached()), store.loadLocal(), bio.isSupported(), cloud.available(),
  ]);
  if (remote) store.setPublishedRev(Math.max(store.publishedRev(), remote.rev));
  app.bioSupported = bioOK;
  app.cloudOK = cloudOK;
  app.legacyEnv = store.chooseVault(remote, local)?.env || null;
  const accounts = store.accounts();
  if (accounts.length) useAccount(accounts[0].username);
  // With accounts available, a new device starts at Sign In / Create Account, not someone else's vault.
  else if (cloudOK && !local) { app.account = null; app.env = null; }
  else useLegacy();
  showLock();
}

function useAccount(username) {
  app.account = username;
  app.env = store.loadAccountEnv(username);
}
function useLegacy() {
  app.account = null;
  app.env = app.legacyEnv;
}
const bioId = () => app.account || 'legacy';
app.bioId = bioId;

// ---------------------------------------------------------------------------
// Lock screen
// ---------------------------------------------------------------------------
const avatar = (u, size = 64) => {
  const hue = [...u].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<span class="avatar" style="--h:${hue};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc(u.slice(0, 1).toUpperCase())}</span>`;
};

function showLock(message = '') {
  closeAllSheets();
  appEl.hidden = true;
  lockEl.hidden = false;
  lockEl.classList.remove('leaving');
  lockEl.querySelector('.app-icon').hidden = false;
  if (app.account) return showAccountLock(message);
  if (app.env) return showLegacyLock(message);
  return showWelcome(message);
}

/** First screen on a new device. */
function showWelcome(message = '') {
  lockLead.textContent = app.cloudOK
    ? 'Your money, private by design. Sign in, or create your own account. Everything is encrypted with a passphrase only you know.'
    : 'Your money, private by design. Everything is encrypted with a passphrase only you know.';
  lockBody.innerHTML = `
    <div class="btn-row">
      ${app.cloudOK ? `<button class="btn" data-act="signin">Sign In</button>
      <button class="btn secondary" data-act="create">Create Account</button>` : `<button class="btn" data-act="setup">Create Your Vault</button>
      <button class="btn secondary" data-act="file">Open a Vault File…</button>`}
      <button class="btn plain" data-act="demo">Explore with Sample Data</button>
    </div>
    ${message ? `<div class="err" role="alert" style="margin-top:8px">${esc(message)}</div>` : ''}
    ${app.cloudOK ? `<div class="lock-links">${store.accounts().length ? '<button type="button" data-act="accounts">Accounts on this device</button>' : ''}
      ${app.legacyEnv ? '<button type="button" data-act="legacy">Open the original vault</button>' : '<button type="button" data-act="setup">Use without an account (this device only)</button>'}</div>` : ''}`;
  wireLockLinks();
}

/** Remembered accounts on this device — like the macOS login window. */
function showAccounts() {
  const list = store.accounts();
  lockLead.textContent = 'Who’s using Money?';
  lockBody.innerHTML = `
    <div class="list account-list">${list.map((a) => `
      <button class="row tap" data-user="${esc(a.username)}">${avatar(a.username, 40)}
        <span class="main"><span class="title">@${esc(a.username)}</span><span class="subtitle">${bio.isEnrolledFor(store.loadAccountEnv(a.username), a.username) ? bio.label() : 'Passphrase'}</span></span>${icon('chev-r', 'chev')}</button>`).join('')}
    </div>
    <div class="btn-row">
      ${app.cloudOK ? '<button class="btn secondary" data-act="signin">Sign In to Another Account</button><button class="btn plain" data-act="create">Create Account</button>' : ''}
    </div>
    ${app.legacyEnv ? '<div class="lock-links"><button type="button" data-act="legacy">Open the original vault</button></div>' : ''}`;
  lockBody.onclick = (e) => {
    const u = e.target.closest('[data-user]')?.dataset.user;
    if (u) { haptic(); useAccount(u); app.bioPrompted = false; showLock(); return; }
    handleLink(e);
  };
}

function showAccountLock(message = '') {
  const u = app.account;
  const env = app.env;
  if (env && bio.enrollment(u) && !bio.isEnrolledFor(env, u)) {
    bio.disable(u);
    message ||= `${bio.label()} was turned off because the passphrase changed. Unlock once with it to turn ${bio.label()} back on.`;
  }
  const useBio = !!env && app.bioSupported && bio.isEnrolledFor(env, u);
  lockEl.querySelector('.app-icon').hidden = true;
  lockLead.innerHTML = `<span class="lock-avatar">${avatar(u, 76)}</span><b class="lock-user">@${esc(u)}</b><br>${useBio ? `Unlock with ${esc(bio.label())} or your passphrase.` : env ? 'Enter your passphrase to unlock.' : 'Enter your passphrase to sign in on this device.'}`;
  lockBody.innerHTML = `
    ${useBio ? `<div class="btn-row" style="margin:0 0 18px"><button class="btn" type="button" id="bio-btn">${icon(bio.label() === 'Face ID' ? 'faceid' : 'touchid')} Unlock with ${esc(bio.label())}</button></div>` : ''}
    <form class="lock-form" id="unlock-form" autocomplete="on">
      <input type="text" name="username" value="${esc(u)}" autocomplete="username" hidden>
      <input class="field" id="pass" type="password" autocomplete="current-password" placeholder="Passphrase" aria-label="Passphrase" required>
      <button class="btn ${useBio ? 'secondary' : ''}" type="submit" id="unlock-btn">${useBio ? 'Use Passphrase' : 'Unlock'}</button>
      <div class="err" id="lock-err" role="alert">${esc(message)}</div>
    </form>
    <div class="lock-links">${app.cloudOK ? '<button type="button" data-act="forgot">Forgot passphrase?</button>' : ''}<button type="button" data-act="accounts">${store.accounts().length > 1 ? 'Switch account' : 'Use another account'}</button></div>`;
  wireUnlock({
    useBio,
    unlockBio: async () => {
      const session = await bio.unlock(env, u);
      return { session, data: await crypto.openWithSession(env, session) };
    },
    unlockPass: async (pass) => {
      if (env) {
        try { return await crypto.open(env, pass); } catch (e) {
          if (!app.cloudOK) throw e; // offline: it really is the wrong passphrase for this copy
        }
      }
      // No usable copy on this device (e.g. the passphrase changed on another device): fetch it,
      // keeping aside any edits here that never synced (they're offered after unlocking).
      const r = await cloud.signIn(u, pass);
      if (env && env.rev > store.syncedRev(u)) store.stashUnsynced(u, env);
      store.saveAccountEnv(u, r.env); store.setSynced(u, r.env.rev);
      app.env = r.env;
      return { session: r.session, data: r.vault };
    },
    message,
  });
  wireLockLinks();
}

function showLegacyLock(message = '') {
  if (bio.enrollment('legacy') && !bio.isEnrolledFor(app.env, 'legacy')) {
    bio.disable('legacy');
    message ||= `${bio.label()} was turned off because your passphrase changed. Unlock once with it to turn ${bio.label()} back on in Settings.`;
  }
  const useBio = app.bioSupported && bio.isEnrolledFor(app.env, 'legacy');
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
      ${app.cloudOK ? '<button type="button" data-act="signin">Sign in to an account</button><button type="button" data-act="create">Create an account</button>' : ''}
      <button type="button" data-act="demo">Explore with sample data</button>
      <button type="button" data-act="file">Open a different vault file…</button>
    </div>`;
  const env = app.env;
  wireUnlock({
    useBio,
    unlockBio: async () => {
      const session = await bio.unlock(env, 'legacy');
      return { session, data: await crypto.openWithSession(env, session) };
    },
    unlockPass: (pass) => crypto.open(env, pass),
    message,
  });
  wireLockLinks();
}

/** Shared Face ID / passphrase wiring for both lock screens. */
function wireUnlock({ useBio, unlockBio, unlockPass, message }) {
  const form = document.getElementById('unlock-form');
  const pass = document.getElementById('pass');
  const err = document.getElementById('lock-err');
  if (useBio) {
    const bioBtn = document.getElementById('bio-btn');
    const tryBio = async () => {
      bioBtn.disabled = true;
      err.textContent = '';
      try {
        const { session, data } = await unlockBio();
        enter({ session, vault: data, demo: false });
      } catch (e) {
        bioBtn.disabled = false;
        if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return;
        if (e?.message === 'WRAP_INVALID' || e?.message === 'WRONG_PASSPHRASE') {
          bio.disable(bioId());
          err.textContent = `${bio.label()} couldn't unlock this vault, so it's been turned off. Use your passphrase.`;
          bioBtn.parentElement.remove();
        } else {
          err.textContent = `${bio.label()} didn't work this time. Use your passphrase.`;
        }
        haptic('error');
      }
    };
    bioBtn.addEventListener('click', tryBio);
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
      const { session, data } = await unlockPass(pass.value);
      pass.value = '';
      enter({ session, vault: data, demo: false });
    } catch (ex) {
      haptic('error');
      btn.disabled = false;
      btn.textContent = label;
      err.textContent = cloudMessage(ex) || 'Incorrect passphrase. Try again.';
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
      pass.select();
    }
  });
}

function cloudMessage(e) {
  return {
    wrong_credentials: 'Username or passphrase is incorrect.',
    bad_invite: 'That invite code isn’t right. Ask the person who shared Money with you.',
    username_taken: 'That username is taken. Try another.',
    bad_username: 'Usernames are 3–32 letters, numbers, dots, dashes or underscores.',
    too_many_attempts: 'Too many tries. Wait 15 minutes, then try again.',
    offline: 'You’re offline. Connect to the internet and try again.',
    not_configured: 'Accounts aren’t set up on this site yet.',
    wrong_recovery_key: 'That recovery key doesn’t match this account.',
    bad_recovery_key: 'A recovery key is 24 letters and numbers, like K7QM-2D9X-….',
    conflict: 'Something changed on another device. Try again.',
    bad_server_kdf: 'The server sent unsafe encryption settings, so Money stopped. Your data is untouched.',
  }[e?.code] || (e?.status ? `Something went wrong (${e.status}). Try again.` : '');
}

function handleLink(e) {
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (!a) return false;
  haptic();
  if (a === 'setup') showSetup();
  if (a === 'demo') startDemo();
  if (a === 'file') pickVaultFile();
  if (a === 'signin') showSignIn();
  if (a === 'create') showCreateAccount();
  if (a === 'forgot') showForgot(document.getElementById('si-user')?.value || app.account || '');
  if (a === 'accounts') store.accounts().length ? showAccounts() : showWelcome();
  if (a === 'legacy') { useLegacy(); showLock(); }
  if (a === 'back') showLock();
  return true;
}
// (Wrapped: an onclick handler that returns false cancels the click, which would block form submits.)
function wireLockLinks() { lockBody.onclick = (e) => { handleLink(e); }; }

function showSignIn() {
  lockEl.querySelector('.app-icon').hidden = false;
  lockLead.textContent = 'Sign in with your username and passphrase.';
  lockBody.innerHTML = `
    <form class="lock-form" id="signin-form" autocomplete="on">
      <input class="field" id="si-user" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Username" aria-label="Username" required>
      <input class="field" id="si-pass" type="password" autocomplete="current-password" placeholder="Passphrase" aria-label="Passphrase" required>
      <button class="btn" type="submit" id="si-btn">Sign In</button>
      <div class="err" id="lock-err" role="alert"></div>
    </form>
    <div class="lock-links"><button type="button" data-act="forgot">Forgot passphrase?</button><button type="button" data-act="create">Create an account instead</button><button type="button" data-act="back">Back</button></div>`;
  setTimeout(() => document.getElementById('si-user').focus(), 250);
  document.getElementById('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('lock-err');
    const btn = document.getElementById('si-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await cloud.signIn(document.getElementById('si-user').value, document.getElementById('si-pass').value);
      document.getElementById('si-pass').value = '';
      store.rememberAccount(r.username);
      store.saveAccountEnv(r.username, r.env);
      store.setSynced(r.username, r.env.rev);
      app.account = r.username;
      app.env = r.env;
      enter({ session: r.session, vault: r.vault, demo: false });
    } catch (ex) {
      haptic('error');
      err.textContent = cloudMessage(ex) || 'Couldn’t sign in. Try again.';
      btn.disabled = false; btn.textContent = 'Sign In';
    }
  });
  wireLockLinks();
}

function passphraseFields() {
  return `
    <input class="field" id="p1" type="password" autocomplete="new-password" placeholder="New passphrase" aria-label="New passphrase" minlength="12" required>
    <div class="meter" aria-hidden="true"><i id="meter"></i></div>
    <div class="hint" id="hint">At least 12 characters. Four random words work well.</div>
    <input class="field" id="p2" type="password" autocomplete="new-password" placeholder="Confirm passphrase" aria-label="Confirm passphrase" required>`;
}
function wireMeter() {
  const p1 = document.getElementById('p1');
  const meter = document.getElementById('meter');
  const hint = document.getElementById('hint');
  p1.addEventListener('input', () => {
    const bits = crypto.strength(p1.value);
    const lvl = bits < 40 ? ['red', 'Weak'] : bits < 60 ? ['orange', 'Okay'] : bits < 80 ? ['green', 'Strong'] : ['green', 'Very strong'];
    meter.style.width = Math.min(100, bits) + '%';
    meter.style.setProperty('--c', `var(--${lvl[0]})`);
    hint.textContent = p1.value.length < 12 ? 'At least 12 characters. Four random words work well.' : `${lvl[1]}. It can’t be recovered, so keep it in your password manager.`;
  });
}
function checkNewPassphrase(err) {
  const v1 = document.getElementById('p1').value, v2 = document.getElementById('p2').value;
  if (v1.length < 12) { err.textContent = 'Use at least 12 characters.'; haptic('error'); return null; }
  if (crypto.strength(v1) < 40) { err.textContent = 'That passphrase is too easy to guess. Add another word or two.'; haptic('error'); return null; }
  if (v1 !== v2) { err.textContent = 'The passphrases don’t match.'; haptic('error'); return null; }
  return v1;
}

function showCreateAccount() {
  lockEl.querySelector('.app-icon').hidden = false;
  lockLead.textContent = 'Create your own private account. Only you can see what’s in it.';
  lockBody.innerHTML = `
    <form class="lock-form" id="create-form" autocomplete="on">
      <input class="field" id="ca-invite" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Invite code" aria-label="Invite code" required>
      <input class="field" id="ca-user" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Choose a username" aria-label="Username" required>
      ${passphraseFields()}
      <button class="btn" type="submit" id="ca-btn">Create Account</button>
      <div class="err" id="lock-err" role="alert"></div>
    </form>
    <p class="hint" style="text-align:center;margin-top:10px">Your passphrase encrypts everything on your device. It can’t be reset, by anyone.</p>
    <div class="lock-links"><button type="button" data-act="signin">I already have an account</button><button type="button" data-act="back">Back</button></div>`;
  wireMeter();
  setTimeout(() => document.getElementById('ca-invite').focus(), 250);
  document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('lock-err');
    const username = cloud.normUser(document.getElementById('ca-user').value);
    if (!cloud.USER_RE.test(username)) { err.textContent = cloudMessage({ code: 'bad_username' }); haptic('error'); return; }
    const pass = checkNewPassphrase(err);
    if (!pass) return;
    const btn = document.getElementById('ca-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const vault = emptyVault();
      const r = await cloud.createAccount({ invite: document.getElementById('ca-invite').value.trim(), username, passphrase: pass, vault });
      document.getElementById('p1').value = ''; document.getElementById('p2').value = '';
      store.rememberAccount(r.username);
      store.saveAccountEnv(r.username, r.env);
      store.setSynced(r.username, r.env.rev);
      app.account = r.username;
      app.env = r.env;
      showRecoveryKey(r.username, r.recoveryKey, () => enter({ session: r.session, vault, demo: false, firstRun: true }));
    } catch (ex) {
      haptic('error');
      err.textContent = cloudMessage(ex) || 'Couldn’t create the account. Try again.';
      btn.disabled = false; btn.textContent = 'Create Account';
    }
  });
  wireLockLinks();
}

/** A vault kept only on this device (or committed to the repo), no account. */
/** Right after sign-up: the one chance to save the recovery key before going in. */
function showRecoveryKey(username, code, onDone) {
  lockEl.querySelector('.app-icon').hidden = false;
  lockLead.innerHTML = '<b>Save your recovery key</b><br>If you ever forget your passphrase, this key lets you set a new one. Keep it somewhere safe, like your password manager.';
  lockBody.innerHTML = `${recoveryCardHTML(code)}
    <div class="btn-row" style="margin-top:14px"><button class="btn" type="button" id="rk-done">I’ve Saved It</button></div>
    <p class="hint" style="text-align:center;margin-top:10px">Anyone with this key and your username could reset your passphrase, so keep it private. You can see it again in Settings.</p>`;
  let saved = false;
  let warned = false;
  wireRecoveryCard(lockBody, code, username, () => { saved = true; });
  document.getElementById('rk-done').addEventListener('click', (e) => {
    // Not copied, saved or shared yet: say so once, right here (alerts sit under the lock screen).
    if (!saved && !warned) {
      warned = true;
      haptic('error');
      e.currentTarget.textContent = 'Continue Without Saving';
      e.currentTarget.classList.add('secondary');
      const hint = lockBody.querySelector('.hint');
      hint.style.color = 'var(--negative)';
      hint.textContent = 'You haven’t copied or saved it yet. It’s the only way back in if you forget your passphrase. You can also find it later in Settings → Recovery Key.';
      return;
    }
    haptic();
    onDone();
  });
}

/** Forgot passphrase: Face ID on a device that has it, or the recovery key. */
function showForgot(prefill = '') {
  const u0 = cloud.normUser(prefill);
  const env = u0 ? store.loadAccountEnv(u0) : null;
  const canBio = !!env && app.bioSupported && bio.isEnrolledFor(env, u0);
  const name = bio.label();
  lockEl.querySelector('.app-icon').hidden = false;
  lockLead.textContent = canBio ? `Set a new passphrase with ${name} or your recovery key.` : 'Set a new passphrase with your recovery key.';
  lockBody.innerHTML = `
    ${canBio ? `<div class="btn-row" style="margin:0 0 18px"><button class="btn" type="button" id="fg-bio">${icon(name === 'Face ID' ? 'faceid' : 'touchid')} Reset with ${esc(name)}</button></div>` : ''}
    <form class="lock-form" id="fg-form" autocomplete="off">
      <input class="field" id="fg-user" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Username" aria-label="Username" value="${esc(u0)}" required>
      <input class="field mono" id="fg-key" type="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Recovery key" aria-label="Recovery key" required>
      <button class="btn ${canBio ? 'secondary' : ''}" type="submit" id="fg-btn">Continue</button>
      <div class="err" id="lock-err" role="alert"></div>
    </form>
    <p class="hint" style="text-align:center;margin-top:10px">Your recovery key was shown when you created your account, and it’s in Settings on any device you’re signed in to. Without it, nobody can get your data back, not even whoever runs the site. That’s what keeps it private.</p>
    <div class="lock-links"><button type="button" data-act="back">Back</button></div>`;
  const err = document.getElementById('lock-err');
  setTimeout(() => document.getElementById(u0 ? 'fg-key' : 'fg-user').focus(), 250);
  document.getElementById('fg-bio')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true; err.textContent = '';
    let bits;
    try {
      bits = await bio.unlockBits(env, u0);
      showNewPassphrase(await cloud.openWithBits(u0, bits));
    } catch (ex) {
      b.disabled = false;
      if (ex?.name === 'NotAllowedError' || ex?.name === 'AbortError') return;
      haptic('error');
      if (ex?.message === 'WRAP_INVALID') bio.disable(u0);
      err.textContent = ex?.code === 'wrong_recovery_key' || ex?.message === 'WRAP_INVALID' || ex?.message === 'WRONG_PASSPHRASE'
        ? `${name} on this device is from an older passphrase. Use your recovery key.` : cloudMessage(ex) || `${name} didn’t work this time.`;
    } finally { bits?.fill(0); }
  });
  document.getElementById('fg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('fg-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    err.textContent = '';
    try {
      const r = await cloud.recoverWithKey(document.getElementById('fg-user').value, document.getElementById('fg-key').value);
      document.getElementById('fg-key').value = '';
      showNewPassphrase(r);
    } catch (ex) {
      haptic('error');
      err.textContent = cloudMessage(ex) || 'Couldn’t check the recovery key. Try again.';
      btn.disabled = false; btn.textContent = 'Continue';
    }
  });
  wireLockLinks();
}

/** Choose a new passphrase for an account opened with the recovery key or Face ID. */
function showNewPassphrase(r) {
  lockEl.querySelector('.app-icon').hidden = true;
  lockLead.innerHTML = `<span class="lock-avatar">${avatar(r.username, 76)}</span><b class="lock-user">@${esc(r.username)}</b><br>Choose a new passphrase.`;
  lockBody.innerHTML = `
    <form class="lock-form" id="np-form" autocomplete="on">
      <input type="text" name="username" value="${esc(r.username)}" autocomplete="username" hidden>
      ${passphraseFields()}
      <button class="btn" type="submit" id="np-btn">Set New Passphrase</button>
      <div class="err" id="lock-err" role="alert"></div>
    </form>
    <p class="hint" style="text-align:center;margin-top:10px">Your other devices will ask for the new passphrase. Your recovery key keeps working.</p>`;
  wireMeter();
  setTimeout(() => document.getElementById('p1').focus(), 250);
  document.getElementById('np-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('lock-err');
    const pass = checkNewPassphrase(err);
    if (!pass) return;
    const btn = document.getElementById('np-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const res = await cloud.setPassphrase({ username: r.username, oldToken: r.token, vault: r.vault, env: r.env, baseRev: r.env.rev, passphrase: pass });
      document.getElementById('p1').value = ''; document.getElementById('p2').value = '';
      bio.disable(r.username); // it held the old key
      store.rememberAccount(r.username);
      store.saveAccountEnv(r.username, res.env);
      store.setSynced(r.username, res.env.rev);
      app.account = r.username;
      app.env = res.env;
      enter({ session: res.session, vault: res.vault, demo: false });
      setTimeout(() => toast(res.vault.recovery?.code ? 'New passphrase set on all your devices' : 'New passphrase set. Turn on a recovery key in Settings.', { icon: 'key', color: 'blue' }), 500);
    } catch (ex) {
      haptic('error');
      err.textContent = cloudMessage(ex) || 'Couldn’t set the passphrase. Try again.';
      btn.disabled = false; btn.textContent = 'Set New Passphrase';
    }
  });
}

function showSetup() {
  lockEl.querySelector('.app-icon').hidden = false;
  lockLead.textContent = 'Choose a passphrase. It encrypts everything, and it can’t be recovered — so write it down somewhere safe.';
  lockBody.innerHTML = `
    <form class="lock-form" id="setup-form" autocomplete="off">
      <input type="text" name="username" value="money-vault" autocomplete="username" hidden>
      ${passphraseFields()}
      <button class="btn" type="submit" id="create-btn">Create Vault</button>
      <div class="err" id="lock-err" role="alert"></div>
    </form>
    <div class="lock-links"><button type="button" data-act="back">Back</button></div>`;
  wireMeter();
  setTimeout(() => document.getElementById('p1').focus(), 200);
  document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = checkNewPassphrase(document.getElementById('lock-err'));
    if (!pass) return;
    const btn = document.getElementById('create-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    const session = await crypto.createSession(pass);
    document.getElementById('p1').value = ''; document.getElementById('p2').value = '';
    const vault = emptyVault();
    app.account = null;
    app.env = await crypto.seal(session, vault, 1);
    store.saveLocal(app.env);
    app.legacyEnv = app.env;
    enter({ session, vault, demo: false, firstRun: true });
  });
  wireLockLinks();
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
      store.saveLocal(env);
      app.legacyEnv = env;
      useLegacy();
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
  if (app.account && !demo) store.rememberAccount(app.account);
  rebuild();
  lockEl.classList.add('leaving');
  appEl.hidden = false;
  setTimeout(() => { lockEl.hidden = true; }, 450);
  app.stale = new Set(Object.keys(VIEWS));
  selectTab(app.tab || 'overview', { force: true });
  startAutoLock();
  haptic();
  // A new account starts with Gmail (no statements needed); without accounts, with statement files.
  if (firstRun) setTimeout(() => (app.account ? import('./views/mail.js').then((m) => m.openMail()) : import('./views/importer.js').then((m) => m.openImporter({ welcome: true }))), 600);
  if (app.account && !demo) {
    pullLatest().then(offerUnsynced)
      .then(() => (app.vault?.bank && !app.demo ? import('./views/bank.js').then((m) => m.maybeAutoSync()) : null))
      .then(() => (app.vault?.mail?.connected && !app.demo ? import('./views/mail.js').then((m) => m.maybeAutoCheck()) : null));
  }
}

export function rebuild() {
  setCurrency(app.vault.account?.currency);
  app.model = buildModel(app.vault, app.rules);
}

/** Persist a change: re-encrypt, store the working copy, sync, re-render. */
app.commit = async function commit({ silent = false } = {}) {
  rebuild();
  app.stale = new Set(Object.keys(VIEWS));
  if (app.demo) { renderTab(app.tab); prerenderSoon(); if (!silent) toast('Sample data isn’t saved', { icon: 'sparkle', color: 'indigo' }); return; }
  // Encrypt first, then render once (the screen shows whether it's synced, which depends on the new revision).
  const rev = (app.env?.rev || 0) + 1;
  app.env = await crypto.seal(app.session, app.vault, rev);
  const ok = app.account ? store.saveAccountEnv(app.account, app.env) : store.saveLocal(app.env);
  if (!ok) toast('Couldn’t save on this device — export the file', { icon: 'warn', color: 'orange' });
  if (app.account) scheduleSync();
  if (app.vault) { renderTab(app.tab); prerenderSoon(); }
};
app.isDirty = () => {
  if (app.demo || !app.env) return false;
  return app.account ? app.env.rev > store.syncedRev(app.account) : app.env.rev > store.publishedRev();
};
app.lock = lock;
app.rerender = () => { app.stale = new Set(Object.keys(VIEWS)); renderTab(app.tab); prerenderSoon(); };
app.useAccount = useAccount;
app.showLock = showLock;

// ---------------------------------------------------------------------------
// Cloud sync (accounts only)
// ---------------------------------------------------------------------------
let syncTimer = null;
let syncing = false;
function scheduleSync(delay = 1200) { clearTimeout(syncTimer); syncTimer = setTimeout(() => app.syncNow({ quiet: true }), delay); }
function refreshSyncUI() { app.stale.add('overview'); if (app.tab === 'overview') renderTab('overview'); }

app.syncNow = async function syncNow({ quiet = false } = {}) {
  const u = app.account;
  const token = app.vault?.sync?.token;
  if (!u || !token || app.demo || syncing) return;
  if (app.env.rev <= store.syncedRev(u)) { if (!quiet) toast('Everything is synced'); return; }
  syncing = true;
  const sent = app.env; // a save can land while this upload is in flight: only mark what was actually sent
  try {
    await cloud.push(u, token, sent, store.syncedRev(u));
    store.setSynced(u, sent.rev);
    app.syncError = null;
    if (!quiet) toast('Synced');
  } catch (e) {
    if (e.code === 'conflict') await resolveConflict();
    else if (e.status === 401) keyChangedElsewhere();
    else {
      if (e.code !== 'offline') app.syncError = cloudMessage(e) || 'Couldn’t sync';
      if (!quiet) toast(e.code === 'offline' ? 'You’re offline. Money will sync when you’re back.' : app.syncError, { icon: 'warn', color: 'orange' });
    }
  } finally {
    syncing = false;
    if (app.vault) {
      refreshSyncUI();
      if (app.account === u && app.env.rev > sent.rev && app.env.rev > store.syncedRev(u)) scheduleSync(300);
    }
  }
};

/**
 * Another device changed the passphrase (our token stopped working). Lock, but never throw away
 * edits this device hadn't synced: keep them aside and offer them after the next unlock.
 */
function keyChangedElsewhere() {
  const u = app.account;
  if (u && app.env && app.env.rev > store.syncedRev(u)) store.stashUnsynced(u, app.env);
  lock('Your passphrase was changed on another device. Unlock with the new one.', { dropCopy: true });
}

/** After unlocking: if edits were left over from before a passphrase change, let the person keep them. */
async function offerUnsynced() {
  const u = app.account;
  const env = u && store.unsynced(u);
  if (!env) return;
  const choice = await alertSheet({
    title: 'Unsynced changes from before',
    message: 'This device had changes that weren’t synced when your passphrase was changed on another device. Save them as a file? It opens with your old passphrase.',
    actions: [{ label: 'Save as File', value: 'save', style: 'primary' }, { label: 'Discard', value: 'discard', style: 'destructive' }, { label: 'Later', value: null, style: 'cancel' }],
  });
  if (choice === 'save') {
    const url = URL.createObjectURL(new Blob([JSON.stringify(env, null, 1)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `money-${u}-unsynced.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    store.clearUnsynced(u);
  } else if (choice === 'discard') store.clearUnsynced(u);
}
window.addEventListener('online', () => { if (app.vault && app.isDirty()) app.syncNow({ quiet: true }); });

/** After unlocking: fetch the newest copy from the cloud. */
async function pullLatest() {
  const u = app.account;
  const token = app.vault?.sync?.token;
  if (!u || !token) return;
  let r;
  try { r = await cloud.pull(u, token); } catch (e) {
    if (e.status === 401) keyChangedElsewhere();
    return;
  }
  if (app.account !== u || !app.vault) return;
  const synced = store.syncedRev(u);
  const localChanges = app.env.rev > synced;
  if (r.rev > synced) {
    if (localChanges) return resolveConflict(r);
    await adoptRemote(r);
  } else if (localChanges) {
    scheduleSync(0);
  }
}

async function adoptRemote(r) {
  const u = app.account;
  let data;
  try { data = await crypto.openWithSession(r.envelope, app.session); } catch {
    // Another device changed the passphrase: keep its copy and ask for the new one.
    store.saveAccountEnv(u, r.envelope);
    store.setSynced(u, r.rev);
    app.env = r.envelope;
    lock('Your passphrase was changed on another device. Unlock with the new one.');
    return;
  }
  app.vault = data;
  app.env = r.envelope;
  store.saveAccountEnv(u, r.envelope);
  store.setSynced(u, r.rev);
  rebuild();
  app.rerender();
  toast('Updated from your other device', { icon: 'arrows', color: 'blue' });
}

async function resolveConflict(remote = null) {
  const u = app.account;
  const token = app.vault?.sync?.token;
  try { remote ||= await cloud.pull(u, token); } catch { return; }
  const choice = await alertSheet({
    title: 'Changed on two devices',
    message: 'This device and another one both changed your data since the last sync. Which version should Money keep?',
    actions: [
      { label: 'Use the Other Device’s', value: 'remote', style: 'primary' },
      { label: 'Keep This Device’s', value: 'local' },
      { label: 'Decide Later', value: null, style: 'cancel' },
    ],
  });
  if (!app.vault || app.account !== u) return; // locked or switched while the question was open
  if (choice === 'remote') return adoptRemote(remote);
  if (choice !== 'local') { refreshSyncUI(); return; }
  // Keep ours, but as a newer revision than the server's, so every device moves forward to it.
  // A normal compare-and-swap against the version we just saw: if yet another save lands first, we ask again.
  try {
    app.env = await crypto.seal(app.session, app.vault, Math.max(app.env.rev, remote.rev) + 1);
    store.saveAccountEnv(u, app.env);
    await cloud.push(u, token, app.env, remote.rev);
    store.setSynced(u, app.env.rev);
    toast('Synced');
  } catch (e) {
    if (e.code === 'conflict') return resolveConflict();
    toast(cloudMessage(e) || 'Couldn’t sync', { icon: 'warn', color: 'orange' });
  }
  refreshSyncUI();
}

function lock(reason = '', { dropCopy = false } = {}) {
  if (!app.vault) return;
  app.bioPrompted = true;
  app.session = null;
  app.vault = null;
  app.model = null;
  clearTimeout(syncTimer);
  for (const id of Object.keys(VIEWS)) document.getElementById(`page-${id}`).innerHTML = '';
  stopAutoLock();
  closeAllSheets();
  if (dropCopy && app.account) { app.env = null; store.dropAccountEnv(app.account); }
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
  positionLens();
  // Build the page *before* showing it (never during the swap), then swap instantly and fade its content up.
  if (force || app.stale.has(name)) renderTab(name);
  document.querySelectorAll('.page').forEach((p) => {
    const on = p.id === `page-${name}`;
    const was = p.classList.contains('active');
    p.classList.toggle('active', on);
    if (on && !was && !force) { p.classList.remove('entering'); void p.offsetWidth; p.classList.add('entering'); }
  });
  prerenderSoon();
}

// Tabs you're not looking at are rebuilt quietly when nothing is moving, so switching to them is instant.
// Building a tab takes a while on a phone, so it never runs while an animation is playing or right after
// you touched something: it would make that animation stutter.
let prerenderTimer;
let lastTouch = 0;
['pointerdown', 'keydown', 'wheel'].forEach((ev) => document.addEventListener(ev, () => { lastTouch = performance.now(); }, { capture: true, passive: true }));
const animating = () => document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations !== Infinity);
function prerenderSoon() {
  clearTimeout(prerenderTimer);
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 16 }), 50));
  const next = () => {
    if (!app.model) return;
    const name = Object.keys(VIEWS).find((t) => t !== app.tab && app.stale.has(t));
    if (!name) return;
    // Not while a sheet is open (you're about to close it), not while anything moves, not right after a touch.
    if (document.querySelector('.sheet') || animating() || performance.now() - lastTouch < 1500) { prerenderTimer = setTimeout(() => idle(next), 400); return; }
    renderTab(name);
    prerenderTimer = setTimeout(() => idle(next), 200); // one tab at a time, then check again
  };
  prerenderTimer = setTimeout(() => idle(next), 700);
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
