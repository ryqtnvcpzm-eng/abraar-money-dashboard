// Bank Sync: connect a bank once through Plaid's own page, then new transactions arrive on their own.
// The Plaid access token lives only in the encrypted vault; the Worker adds Plaid's secret and keeps nothing.
import { app } from '../state.js';
import { money, esc, plural, dateLabel } from '../format.js';
import * as cloud from '../cloud.js';
import { icon, openSheet, haptic, toast, alertSheet } from '../ui.js';

let syncing = null;

/** Pull new transactions (quiet = in the background after unlocking). Resolves to counts, or null. */
export function syncBank({ quiet = false } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    const b = app.vault?.bank;
    const token = app.vault?.sync?.token;
    if (!b?.accessToken || !app.account || !token || app.demo) return null;
    try {
      const res = await cloud.bank(app.account, token, 'sync', { accessToken: b.accessToken, cursor: b.cursor || '', accountId: b.accountId });
      const { applyBankSync } = await import('../bank.js');
      const counts = applyBankSync(app.vault, res);
      b.problem = null;
      await app.commit({ silent: true });
      if (!quiet) toast(counts.added ? `${plural(counts.added, 'new transaction')}` : res.status === 'NOT_READY' ? 'Your bank is still sending history' : 'Up to date', { icon: 'arrows', color: 'blue' });
      return counts;
    } catch (e) {
      const code = e.plaid || e.code;
      if (code === 'ITEM_LOGIN_REQUIRED' || code === 'PENDING_EXPIRATION') { b.problem = 'login'; await app.commit({ silent: true }); }
      if (!quiet) toast(bankMessage(e), { icon: 'warn', color: 'orange' });
      return null;
    } finally {
      setTimeout(() => { syncing = null; }, 0);
    }
  })();
  return syncing;
}

/** In the background: when connected and the last sync is more than six hours old. */
export function maybeAutoSync() {
  const b = app.vault?.bank;
  if (!b?.accessToken || b.problem) return;
  if (b.lastSync && Date.now() - Date.parse(b.lastSync) < 6 * 3600e3) return;
  syncBank({ quiet: true });
}

function bankMessage(e) {
  const code = e?.plaid || e?.code;
  if (code === 'offline') return 'You’re offline.';
  if (code === 'bank_not_configured') return 'Bank sync isn’t set up on this site yet.';
  if (code === 'ITEM_LOGIN_REQUIRED' || code === 'PENDING_EXPIRATION') return 'Your bank needs you to sign in again.';
  if (/redirect/i.test(e?.detail || '') && /INVALID|REDIRECT/.test(code || '')) return 'Add this site’s bank-done page to Plaid’s allowed redirect URIs.';
  return e?.detail || 'Couldn’t reach your bank. Try again in a minute.';
}

export async function openBank({ onDone } = {}) {
  const sheet = openSheet({ title: 'Bank Sync', size: 'full', body: '<div class="empty" style="padding:60px 0"><span class="spinner dark"></span></div>', onClose: () => { stop(); onDone?.(); } });
  let poll = null, link = null, phase = 'start', error = null, choice = null, last = null;
  const stop = () => { clearInterval(poll); poll = null; document.removeEventListener('visibilitychange', onVisible); };
  const onVisible = () => { if (document.visibilityState === 'visible' && poll) check(); };
  const status = app.demo ? { bank: false } : await cloud.serverStatus();

  const hero = (ic, color, title, text) => `<div class="sheet-hero" style="padding-top:18px">
    <span class="cat-icon lg" style="--c:var(--${color})">${icon(ic)}</span><div class="name">${title}</div>
    <p class="when" style="max-width:350px;margin:8px auto 0">${text}</p></div>`;
  const privacy = `<p class="list-foot">Plaid connects to your bank on its own page, so Money never sees your bank password. The connection key is kept only in your encrypted vault; the sync server adds Plaid’s secret, passes transactions through and stores nothing. Account numbers are never kept. Disconnect any time.</p>`;

  const draw = () => {
    const b = app.vault.bank;
    if (app.demo) return sheet.setBody(hero('lock', 'gray', 'Not in sample data', 'Bank sync connects a real bank, so it’s off while you’re exploring sample data.'));
    if (!app.account) return sheet.setBody(hero('lock', 'gray', 'Needs an account', 'Bank sync goes through the sync server, so it needs a Money account (Settings → Account).'));
    if (!status.bank) {
      return sheet.setBody(`${hero('arrows', 'blue', 'Bank sync isn’t switched on', 'This site can pull new transactions from your bank through Plaid. The site owner turns it on once:')}
        <div class="list">${[
          'Make a free Plaid account at <b>dashboard.plaid.com</b> (the Trial plan connects real banks in Canada and the US).',
          'In Cloudflare → your Worker → Settings → Variables and secrets, add <b>PLAID_CLIENT_ID</b>, and <b>PLAID_SECRET</b> as a secret.',
          `In Plaid’s dashboard, add <b>${esc(location.origin)}/bank-done.html</b> as an allowed redirect URI.`,
        ].map((s, i) => `<div class="row with-icon"><span class="cat-icon sm" style="--c:var(--blue)"><b style="font:600 13px/1 var(--font)">${i + 1}</b></span><span class="main"><span class="subtitle" style="white-space:normal;color:var(--label)">${s}</span></span></div>`).join('')}</div>
        <p class="list-foot">Until then, add statements as files: PDF, CSV, OFX or QIF.</p>`);
    }
    if (phase === 'choose') {
      return sheet.setBody(`${hero('arrows', 'blue', 'Which account?', `Pick the account this vault follows${choice.institution ? ` at ${esc(choice.institution)}` : ''}.`)}
        <div class="list">${choice.accounts.map((a, i) => `<button class="row with-icon tap" data-pick="${i}"><span class="cat-icon sm" style="--c:var(--${a.type === 'credit' ? 'orange' : 'blue'})">${icon(a.type === 'credit' ? 'receipt' : 'banknote')}</span>
          <span class="main"><span class="title">${esc(a.name)}</span><span class="subtitle">${esc(a.subtype || a.type || '')}</span></span>
          ${a.current != null ? `<span class="value">${money(a.type === 'credit' ? -a.current : a.current)}</span>` : ''}${icon('chev-r', 'chev')}</button>`).join('')}</div>`);
    }
    if (phase === 'syncing') return sheet.setBody(hero('arrows', 'blue', 'Bringing in your transactions…', 'This takes a few seconds the first time.') + '<div class="empty" style="padding:20px 0"><span class="spinner dark"></span></div>');
    if (b?.accessToken && phase !== 'relink') {
      const fileEnd = app.vault.statements.filter((s) => s.source !== 'sync').map((s) => s.fileEnd || s.end).sort().pop();
      return sheet.setBody(`${hero('check', b.problem ? 'orange' : 'green', esc(b.institution || 'Your bank'), esc(b.accountName || 'Connected'))}
        ${b.problem === 'login' ? `<div class="banner" style="--c:var(--orange)"><span class="ic">${icon('warn')}</span><span class="txt"><b>Sign in to your bank again</b><span>Your bank ended the connection. Reconnect to keep syncing.</span></span><button class="btn small" data-act="relink">Reconnect</button></div>` : ''}
        <div class="list">
          <div class="row"><span class="main"><span class="title">Last synced</span></span><span class="detail">${b.lastSync ? esc(new Date(b.lastSync).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : 'Never'}</span></div>
          ${b.balance != null ? `<div class="row"><span class="main"><span class="title">Balance at the bank</span></span><span class="detail num">${money(b.type === 'credit' ? -b.balance : b.balance)}</span></div>` : ''}
          ${last ? `<div class="row"><span class="main"><span class="title">This sync</span></span><span class="detail">${last.added ? `${last.added.toLocaleString('en-CA')} new` : 'Nothing new'}${last.updated ? `, ${last.updated} updated` : ''}</span></div>` : ''}
        </div>
        ${error ? `<p class="list-foot neg">${esc(error)}</p>` : ''}
        <div class="btn-row"><button class="btn" data-act="sync">${icon('arrows')} Sync Now</button>
          <button class="btn secondary destructive" data-act="disconnect">Disconnect</button></div>
        <p class="list-foot">New transactions come in on their own when you open Money (every few hours). ${fileEnd ? `Days up to ${esc(dateLabel(fileEnd, 'short'))} come from your statement files, which stay the record; a statement you add later replaces synced days.` : 'A statement you add later replaces the synced days it covers.'}</p>
        ${privacy}`);
    }
    // Not connected (or reconnecting).
    const relink = phase === 'relink';
    return sheet.setBody(`${hero('arrows', 'blue', relink ? 'Reconnect your bank' : 'Connect your bank', relink ? 'Sign in on Plaid’s page and come back here.' : 'New transactions show up on their own, already categorized. No more downloading statements every month.')}
      ${poll ? `<div class="list"><div class="row"><span class="spinner dark"></span><span class="main"><span class="title">Waiting for your bank…</span><span class="subtitle" style="white-space:normal">Finish on Plaid’s page, then come back. This updates by itself.</span></span></div></div>` : ''}
      ${link ? `<a class="btn" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" data-act="go" style="margin-top:14px">${icon('arrows')} ${poll ? 'Open Plaid Again' : relink ? 'Reconnect with Plaid' : 'Connect with Plaid'}</a>`
        : `<button class="btn" disabled style="margin-top:14px"><span class="spinner"></span> Preparing…</button>`}
      ${error ? `<p class="list-foot neg" style="text-align:center">${esc(error)}</p>` : ''}
      ${privacy}`);
  };

  async function prepare() {
    try {
      link = await cloud.bank(app.account, app.vault.sync.token, 'link', phase === 'relink' ? { accessToken: app.vault.bank.accessToken } : {});
      error = null;
    } catch (e) { error = bankMessage(e); }
    draw();
  }
  async function check() {
    try {
      const r = await cloud.bank(app.account, app.vault.sync.token, 'finish', { linkToken: link.linkToken, update: phase === 'relink' });
      if (r.status === 'pending') return;
      stop();
      if (r.status === 'exited') { error = 'The connection wasn’t finished. Try again when you’re ready.'; link = null; draw(); prepare(); return; }
      if (phase === 'relink') { app.vault.bank.problem = null; phase = 'start'; await app.commit({ silent: true }); draw(); await runSync(); return; }
      const { followable } = await import('../bank.js');
      choice = { ...r, accounts: followable(r.accounts) };
      if (!choice.accounts.length) { error = 'No chequing, savings or card accounts came back from that bank.'; link = null; draw(); prepare(); return; }
      if (choice.accounts.length === 1) return connect(choice.accounts[0]);
      phase = 'choose'; draw();
    } catch (e) { error = bankMessage(e); draw(); }
  }
  async function connect(a) {
    app.vault.bank = { institution: choice.institution, accessToken: choice.accessToken, accountId: a.id, accountName: a.name, type: a.type, cursor: '', connectedAt: new Date().toISOString() };
    phase = 'syncing'; draw();
    await app.commit({ silent: true });
    await runSync();
  }
  async function runSync() {
    phase = 'syncing'; draw();
    last = await syncBank();
    phase = 'start'; draw();
  }

  draw();
  if (status.bank && !app.demo && app.account && (!app.vault.bank?.accessToken)) prepare();

  sheet.el.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-act="go"]');
    if (go) {
      // The link opens Plaid in a new tab; keep checking here until it's done.
      haptic();
      if (!poll) { poll = setInterval(check, 3000); document.addEventListener('visibilitychange', onVisible); setTimeout(draw, 50); }
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) { haptic(); connect(choice.accounts[+pick.dataset.pick]); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'sync') { haptic(); error = null; await runSync(); }
    if (act === 'relink') { haptic(); phase = 'relink'; link = null; draw(); prepare(); }
    if (act === 'disconnect') {
      const ok = await alertSheet({
        title: 'Disconnect your bank?',
        message: 'Transactions already synced stay. New ones stop coming in until you connect again.',
        actions: [{ label: 'Disconnect', value: true, style: 'destructive' }, { label: 'Cancel', value: false, style: 'cancel' }],
      });
      if (!ok) return;
      haptic('heavy');
      const b = app.vault.bank;
      try { await cloud.bank(app.account, app.vault.sync.token, 'remove', { accessToken: b.accessToken }); } catch { /* removed here either way */ }
      delete app.vault.bank;
      await app.commit({ silent: true });
      toast('Bank disconnected');
      link = null; last = null; phase = 'start';
      draw();
      if (status.bank) prepare();
    }
  });
}
