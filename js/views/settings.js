// Settings: save to GitHub / export, statements & reconciliation, merchant rules, auto-lock, passphrase, device.
import { app } from '../state.js';
import { money, monthLabel, dateLabel, esc, plural } from '../format.js';
import * as crypto from '../crypto.js';
import * as store from '../store.js';
import * as bio from '../biometric.js';
import { icon, openSheet, haptic, toast, alertSheet } from '../ui.js';

const row = (ic, color, title, { sub = '', detail = '', act = '', chev = true, cls = '' } = {}) => `
  <button class="row with-icon tap ${cls}" ${act ? `data-act="${act}"` : ''}>
    <span class="cat-icon sm" style="--c:var(--${color})">${icon(ic)}</span>
    <span class="main"><span class="title">${title}</span>${sub ? `<span class="subtitle">${sub}</span>` : ''}</span>
    ${detail ? `<span class="detail">${detail}</span>` : ''}${chev ? icon('chev-r', 'chev') : ''}
  </button>`;

export function openSettings() {
  const sheet = openSheet({ title: 'Settings', size: 'full', body: '' });
  const draw = () => {
    const v = app.vault;
    const gh = store.githubConfig();
    const dirty = app.isDirty();
    const lockMin = v.settings?.autoLockMinutes ?? 5;
    sheet.setBody(`
      ${app.demo ? '<div class="banner" style="--c:var(--indigo)"><span class="ic">' + icon('sparkle') + '</span><span class="txt"><b>Sample data</b><span>Settings that save are turned off.</span></span></div>' : ''}
      <div class="list-head"><span>Sync</span></div>
      <div class="list">
        ${row('github', dirty ? 'orange' : 'green', 'Save to GitHub', { sub: dirty ? 'Changes waiting to be saved' : 'Repo is up to date', act: 'push', chev: false, cls: 'action' })}
        ${row('share', 'blue', 'Export Encrypted File', { sub: 'vault.enc.json — commit it to data/', act: 'export', chev: false })}
        ${row('key', 'gray', 'GitHub Connection', { detail: store.hasToken() ? esc(gh.repo || 'Set up') : 'Not set up', act: 'github' })}
      </div>
      <p class="list-foot">The token stays on this device, encrypted with your passphrase.</p>

      <div class="list-head"><span>Data</span></div>
      <div class="list">
        ${row('plus', 'blue', 'Add Statement', { act: 'add' })}
        ${row('doc', 'indigo', 'Statements', { detail: String(app.model.statements.length), act: 'statements' })}
        ${row('tag', 'orange', 'Merchant Rules', { detail: String((v.userRules || []).length), act: 'rules' })}
      </div>

      <div class="list-head"><span>Security</span></div>
      <div class="list">
        ${app.bioSupported && !app.demo ? `<label class="row with-icon">
          <span class="cat-icon sm" style="--c:var(--green)">${icon(bio.label() === 'Face ID' ? 'faceid' : 'touchid')}</span>
          <span class="main"><span class="title">${bio.label()}</span><span class="subtitle">Skip typing your passphrase</span></span>
          <span class="switch"><input type="checkbox" data-act="bio" ${bio.isEnrolledFor(app.env) ? 'checked' : ''} aria-label="${bio.label()}"><span></span></span>
        </label>` : ''}
        ${row('timer', 'red', 'Auto-Lock', { detail: lockMin === 1 ? '1 minute' : `${lockMin} minutes`, act: 'autolock' })}
        ${row('key', 'gray', 'Change Passphrase', { act: 'passphrase' })}
        ${row('lock', 'blue', 'Lock Now', { act: 'lock', chev: false })}
      </div>

      <div class="list-head"><span>This device</span></div>
      <div class="list">
        <button class="row tap destructive" data-act="forget"><span class="main"><span class="title">Forget This Device</span><span class="subtitle">Removes the encrypted copy and token from this browser</span></span></button>
      </div>
      <p class="list-foot">${app.env ? `Vault revision ${app.env.rev} · saved ${esc(new Date(app.env.savedAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }))}<br>` : ''}AES-256-GCM · PBKDF2-SHA-256 × ${(app.env?.kdf?.iterations || crypto.KDF_ITERATIONS).toLocaleString('en-CA')}</p>`);
  };
  draw();
  sheet.el.addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'bio') return;
    haptic();
    if (e.target.checked) { e.target.checked = false; openBiometricSetup(draw); return; }
    const off = await alertSheet({ title: `Turn off ${bio.label()}?`, message: 'You’ll unlock with your passphrase on this device. The passkey stays in Passwords until you delete it there.', actions: [{ label: 'Turn Off', value: true, style: 'destructive' }, { label: 'Cancel', value: false, style: 'cancel' }] });
    if (off) { bio.disable(); toast(`${bio.label()} is off`); }
    draw();
  });
  sheet.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="bio"]')) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    haptic();
    if (act === 'push') { await saveToRepo(); draw(); }
    if (act === 'export') await exportVault();
    if (act === 'github') openGithub(draw);
    if (act === 'add') { sheet.close(); (await import('./importer.js')).openImporter(); }
    if (act === 'statements') openStatements();
    if (act === 'rules') openRules(draw);
    if (act === 'autolock') pickAutoLock(draw);
    if (act === 'passphrase') changePassphrase();
    if (act === 'lock') { sheet.close(); app.lock(); }
    if (act === 'forget') {
      const ok = await alertSheet({ title: 'Forget this device?', message: 'The encrypted copy on this device and your GitHub token will be removed. Anything not saved to GitHub or exported will be lost.', actions: [{ label: 'Forget', value: true, style: 'destructive' }, { label: 'Cancel', value: false, style: 'cancel' }] });
      if (ok) { store.clearLocal(); location.reload(); }
    }
  });
}

export async function saveToRepo() {
  if (app.demo) { toast('Sample data isn’t saved', { icon: 'sparkle', color: 'indigo' }); return; }
  if (!store.hasToken()) {
    const c = await alertSheet({ title: 'Connect GitHub', message: 'Add a fine-grained token for this one repository to save with one tap. Or export the file and commit it yourself.', actions: [{ label: 'Set Up GitHub', value: 'gh', style: 'primary' }, { label: 'Export File Instead', value: 'export' }, { label: 'Cancel', value: null, style: 'cancel' }] });
    if (c === 'gh') openGithub();
    if (c === 'export') await exportVault();
    return;
  }
  toast('Saving to GitHub…', { icon: 'upload', color: 'blue' });
  try {
    await store.pushToGitHub(app.session, app.env);
    toast('Saved. Live in about a minute.', { icon: 'check', color: 'green' });
    app.rerender();
  } catch (err) {
    haptic('error');
    toast(err.message, { icon: 'warn', color: 'red' });
  }
}

export async function exportVault() {
  if (app.demo) { toast('Sample data isn’t saved', { icon: 'sparkle', color: 'indigo' }); return; }
  const r = await store.exportFile(app.env);
  if (r !== 'cancelled') toast('Commit it as data/vault.enc.json', { icon: 'share', color: 'blue' });
}

function openGithub(onDone) {
  const cfg = store.githubConfig();
  const sheet = openSheet({
    title: 'GitHub', size: 'full',
    right: `<button class="text-btn" data-act="save">Save</button>`,
    left: `<button class="text-btn" data-close style="font-weight:400">Cancel</button>`,
    body: `
      <div class="list-head"><span>Repository</span></div>
      <div class="list">
        <label class="row"><span class="main"><span class="title">Owner</span></span><input class="inline" id="gh-owner" value="${esc(cfg.owner)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label class="row"><span class="main"><span class="title">Repository</span></span><input class="inline" id="gh-repo" value="${esc(cfg.repo)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label class="row"><span class="main"><span class="title">Branch</span></span><input class="inline" id="gh-branch" value="${esc(cfg.branch || 'main')}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      </div>
      <div class="list-head"><span>Token</span></div>
      <div class="list">
        <label class="row"><span class="main"><span class="title">Token</span></span><input class="inline" type="password" id="gh-token" placeholder="${store.hasToken() ? 'Saved — paste to replace' : 'github_pat_…'}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        ${store.hasToken() ? '<button class="row tap destructive" data-act="remove"><span class="main"><span class="title">Remove Token</span></span></button>' : ''}
      </div>
      <p class="list-foot">Create a <b>fine-grained</b> token at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">github.com/settings/personal-access-tokens</a>:
        Repository access → <i>Only select repositories</i> → this repo. Permissions → <i>Contents: Read and write</i>. Nothing else.
        It’s encrypted with your passphrase and never leaves this device except to talk to api.github.com.</p>`,
  });
  sheet.el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'remove') { await store.setToken(app.session, ''); toast('Token removed'); sheet.close(); onDone?.(); }
    if (act === 'save') {
      if (app.demo) { toast('Sample data isn’t saved', { icon: 'sparkle', color: 'indigo' }); return; }
      const v = (id) => sheet.el.querySelector(id).value.trim();
      store.setGithubConfig({ owner: v('#gh-owner'), repo: v('#gh-repo'), branch: v('#gh-branch') || 'main' });
      const tok = v('#gh-token');
      if (tok) await store.setToken(app.session, tok);
      haptic();
      toast('GitHub connected');
      sheet.close();
      onDone?.();
    }
  });
}

export function openStatements() {
  const sheet = openSheet({ title: 'Statements', size: 'full', body: '' });
  const draw = () => {
    const list = [...app.model.statements].reverse();
    sheet.setBody(list.length ? `
      <div class="list" style="margin-top:6px">${list.map((s) => `
        <button class="row tap" data-st="${esc(s.id)}">
          <span class="main"><span class="title">${esc(monthLabel(s.id))}</span><span class="subtitle">${plural(s.count, 'transaction')} · closes at ${money(s.closing)}</span></span>
          ${s.reconciled ? '<span class="chip ok">Reconciled</span>' : '<span class="chip bad">Check</span>'}${icon('chev-r', 'chev')}
        </button>`).join('')}</div>
      <p class="list-foot">Each statement: opening + deposits − withdrawals = closing, and both totals match the bank’s summary to the cent.</p>`
      : '<div class="empty"><h3>No statements</h3><p>Add a CIBC PDF to get started.</p></div>');
  };
  draw();
  sheet.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-st]');
    if (b) { haptic(); openStatement(b.dataset.st, draw); }
  });
}

function openStatement(id, onChange) {
  const s = app.vault.statements.find((x) => x.id === id);
  const sheet = openSheet({
    title: monthLabel(id), size: 'auto',
    body: `
      <div class="list-head"><span>${esc(dateLabel(s.start, 'short'))} – ${esc(dateLabel(s.end, 'long'))}</span>${s.reconciled ? '<span class="chip ok">Reconciled</span>' : '<span class="chip bad">Doesn’t match</span>'}</div>
      <div class="list">
        <div class="row"><span class="main"><span class="title">Opening balance</span></span><span class="detail num">${money(s.opening)}</span></div>
        <div class="row"><span class="main"><span class="title">Deposits</span></span><span class="detail num">+${money(s.deposits)}</span></div>
        <div class="row"><span class="main"><span class="title">Withdrawals</span></span><span class="detail num">−${money(s.withdrawals)}</span></div>
        <div class="row"><span class="main"><span class="title" style="font-weight:600">Closing balance</span></span><span class="detail num" style="color:var(--label);font-weight:600">${money(s.closing)}</span></div>
      </div>
      <div class="list-head"><span>Checks</span></div>
      <div class="list">${(s.checks || []).map((c) => `<div class="row"><span class="main"><span class="title">${esc(c.label)}</span><span class="subtitle">Statement ${c.statement != null ? money(c.statement) : '—'} · found ${money(c.computed)}</span></span>
        <span style="color:var(--${c.ok === false ? 'red' : c.ok ? 'green' : 'gray'})">${icon(c.ok === false ? 'close' : c.ok ? 'check' : 'ellipsis')}</span></div>`).join('')}
        ${(s.issues || []).map((x) => `<div class="row"><span class="main"><span class="subtitle neg" style="white-space:normal">${esc(x)}</span></span></div>`).join('')}
      </div>
      <p class="list-foot">${plural(s.count, 'transaction')} · imported ${esc(new Date(s.importedAt).toLocaleDateString('en-CA', { dateStyle: 'medium' }))}</p>
      <div class="btn-row"><button class="btn destructive" data-act="remove">Remove Statement</button></div>`,
  });
  sheet.el.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-act="remove"]')) return;
    const ok = await alertSheet({ title: `Remove ${monthLabel(id)}?`, message: `Deletes its ${s.count} transactions from the vault. You can add the PDF again later.`, actions: [{ label: 'Remove', value: true, style: 'destructive' }, { label: 'Cancel', value: false, style: 'cancel' }] });
    if (!ok) return;
    app.vault.statements = app.vault.statements.filter((x) => x.id !== id);
    app.vault.transactions = app.vault.transactions.filter((t) => t.statement !== id);
    await app.commit({ silent: true });
    sheet.close();
    onChange?.();
    toast('Statement removed');
  });
}

function openRules(onChange) {
  const sheet = openSheet({ title: 'Merchant Rules', size: 'full', body: '' });
  const draw = () => {
    const rules = app.vault.userRules || [];
    sheet.setBody(rules.length ? `
      <div class="list" style="margin-top:6px">${rules.map((r, i) => {
        const c = app.model.cats.get(r.category);
        return `<div class="row with-icon"><span class="cat-icon sm" style="--c:var(--${c?.color || 'gray'})">${icon(c?.icon || 'tag')}</span>
          <span class="main"><span class="title">${esc(r.name)}</span><span class="subtitle">${r.sign > 0 ? 'Money in' : 'Money out'} → ${esc(c?.name || r.category)}</span></span>
          <button class="glass-btn" style="width:34px;height:34px;font-size:15px;color:var(--red);background:var(--fill-3);box-shadow:none" data-del="${i}" aria-label="Delete rule for ${esc(r.name)}">${icon('trash')}</button></div>`;
      }).join('')}</div>
      <p class="list-foot">Your rules beat the built-in ones in data/rules.json, and they’re stored encrypted.</p>`
      : `<div class="empty"><div class="ic">${icon('tag')}</div><h3>No rules yet</h3><p>Change a transaction’s category and choose “Apply to All” to create one.</p></div>`);
  };
  draw();
  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    haptic();
    app.vault.userRules.splice(+b.dataset.del, 1);
    await app.commit({ silent: true });
    draw(); onChange?.();
  });
}

function pickAutoLock(onChange) {
  const opts = [1, 2, 5, 15];
  const cur = app.vault.settings?.autoLockMinutes ?? 5;
  const sheet = openSheet({
    title: 'Auto-Lock',
    body: `<div class="list" style="margin-top:6px">${opts.map((m) => `<button class="row tap" data-min="${m}"><span class="main"><span class="title">${m === 1 ? '1 minute' : `${m} minutes`}</span></span>${m === cur ? `<span style="color:var(--tint)">${icon('check')}</span>` : ''}</button>`).join('')}</div>
      <p class="list-foot">Money also locks when it’s been in the background for over a minute.</p>`,
  });
  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-min]');
    if (!b) return;
    haptic();
    app.vault.settings = { ...(app.vault.settings || {}), autoLockMinutes: +b.dataset.min };
    sheet.close();
    await app.commit({ silent: true });
    onChange?.();
  });
}

function changePassphrase() {
  if (app.demo) { toast('Sample data isn’t saved', { icon: 'sparkle', color: 'indigo' }); return; }
  const sheet = openSheet({
    title: 'Change Passphrase', size: 'full',
    body: `
      <form class="lock-form" id="cp" autocomplete="off" style="margin-top:8px">
        <input type="text" name="username" value="money-vault" autocomplete="username" hidden>
        <input class="field" type="password" id="cp0" placeholder="Current passphrase" autocomplete="current-password" required>
        <input class="field" type="password" id="cp1" placeholder="New passphrase" autocomplete="new-password" minlength="12" required>
        <input class="field" type="password" id="cp2" placeholder="Confirm new passphrase" autocomplete="new-password" required>
        <button class="btn" type="submit">Change Passphrase</button>
        <div class="err" id="cp-err" role="alert"></div>
      </form>
      <p class="list-foot">The vault is re-encrypted with a new key. Save to GitHub afterwards; the old passphrase keeps working on the old file until you do.</p>`,
  });
  sheet.el.querySelector('#cp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = (id) => sheet.el.querySelector(id).value;
    const err = sheet.el.querySelector('#cp-err');
    const btn = sheet.el.querySelector('button[type="submit"]');
    if (g('#cp1').length < 12 || crypto.strength(g('#cp1')) < 40) { err.textContent = 'Choose a longer passphrase (four random words work well).'; return; }
    if (g('#cp1') !== g('#cp2')) { err.textContent = 'The new passphrases don’t match.'; return; }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      await crypto.open(app.env, g('#cp0'));
    } catch {
      haptic('error'); err.textContent = 'Current passphrase is incorrect.'; btn.disabled = false; btn.textContent = 'Change Passphrase'; return;
    }
    const token = await store.getToken(app.session);
    app.session = await crypto.createSession(g('#cp1'));
    const hadBio = bio.enrollment();
    bio.disable(); // the old biometric copy belongs to the old key
    if (token) await store.setToken(app.session, token);
    await app.commit({ silent: true });
    sheet.close();
    toast(hadBio ? `Passphrase changed. Turn ${bio.label()} back on in Settings, then Save to GitHub.` : 'Passphrase changed. Save to GitHub to update the repo.', { icon: 'key', color: 'blue' });
  });
}

function openBiometricSetup(onDone) {
  const name = bio.label();
  const sheet = openSheet({
    title: `Turn On ${name}`, size: 'full',
    body: `
      <div class="sheet-hero" style="padding-top:12px">
        <span class="cat-icon lg" style="--c:var(--green)">${icon(name === 'Face ID' ? 'faceid' : 'touchid')}</span>
        <div class="name">Unlock with ${esc(name)}</div>
        <p class="when" style="max-width:340px;margin:8px auto 0">Money saves a passkey in your iCloud Keychain. ${esc(name)} unlocks it, and it unlocks your vault on this device. Your passphrase is never stored, and it still works everywhere.</p>
      </div>
      <form class="lock-form" id="bio-form" autocomplete="off">
        <input type="text" name="username" value="money-vault" autocomplete="username" hidden>
        <input class="field" type="password" id="bio-pass" placeholder="Passphrase" autocomplete="current-password" required aria-label="Passphrase">
        <button class="btn" type="submit" id="bio-go">Continue</button>
        <div class="err" id="bio-err" role="alert"></div>
      </form>
      <p class="list-foot">Set it up separately on your iPhone and your Mac. Needs iOS 18 or macOS 15 or later. If you change your passphrase, turn it on again.</p>`,
  });
  setTimeout(() => sheet.el.querySelector('#bio-pass')?.focus(), 400);
  sheet.el.querySelector('#bio-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = sheet.el.querySelector('#bio-pass');
    const err = sheet.el.querySelector('#bio-err');
    const btn = sheet.el.querySelector('#bio-go');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    err.textContent = '';
    let bits;
    try {
      bits = await crypto.deriveKeyBits(pass.value, crypto.unb64(app.env.kdf.salt), app.env.kdf.iterations);
      await crypto.openWithSession(app.env, { key: await crypto.keyFromBits(bits) }); // checks the passphrase
    } catch {
      bits?.fill(0);
      haptic('error'); err.textContent = 'Incorrect passphrase.'; btn.disabled = false; btn.textContent = 'Continue'; return;
    }
    pass.value = '';
    try {
      await bio.enroll(bits, app.env);
      haptic();
      sheet.close();
      toast(`${name} is on`, { icon: name === 'Face ID' ? 'faceid' : 'touchid', color: 'green' });
      onDone?.();
    } catch (ex) {
      haptic('error');
      err.textContent = ex?.name === 'NotAllowedError' ? `${name} was cancelled. Try again when you’re ready.`
        : ex?.message === 'PRF_UNSUPPORTED' ? `This browser can’t do ${name} unlock yet. Use Safari on iOS 18 / macOS 15 or later.`
        : `Couldn’t set up ${name} (${ex?.name || 'error'}).`;
      btn.disabled = false; btn.textContent = 'Try Again';
    } finally {
      bits.fill(0);
    }
  });
}
