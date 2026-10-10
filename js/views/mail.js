// Bank Emails: most banks email you each time your card is used. With Gmail connected, the sync server
// checks every hour (even with Money closed) and seals any alert emails to this account's key; Money opens
// them when it's open, reads the amount, the store, the date and which way the money went, and records and
// categorizes them. Unsure ones wait for a quick check. Pasted emails and .eml files work too.
import { app } from '../state.js';
import { money, esc, plural, dateLabel } from '../format.js';
import * as cloud from '../cloud.js';
import { icon, openSheet, haptic, toast, alertSheet } from '../ui.js';

let pulling = null;
let timer = null;

const when = (iso) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function mailMessage(e) {
  const code = e?.code;
  if (code === 'offline') return 'You’re offline.';
  if (code === 'mail_not_configured') return 'Gmail isn’t set up on this site yet.';
  if (code === 'mail_reconnect') return 'Gmail needs you to sign in again.';
  if (code === 'mail_forbidden') return 'Gmail said no. Make sure the Gmail API is switched on in the Google Cloud project.';
  return 'Couldn’t reach Gmail. Try again in a minute.';
}

/**
 * Collect what the hourly check found (check: ask the server to look in Gmail right now first). Opens the sealed
 * emails with the vault's key, records the transactions, and lets the server delete its copies.
 * Resolves to { added, waiting } or null.
 */
export function pullMail({ quiet = false, check = false } = {}) {
  // A quiet pull already running doesn't look in Gmail: a "check now" waits for it, then runs.
  if (pulling) return check ? pulling.then(() => pullMail({ quiet, check })) : pulling;
  const run = (async () => {
    const vault = app.vault;
    const m = vault?.mail;
    if (!m?.connected || !m.key || !app.account || !vault.sync?.token || app.demo) return null;
    const call = (action, body) => cloud.mail(app.account, vault.sync.token, action, body);
    try {
      const { openBox, readMessages } = await import('../gmail.js');
      const { routeAlerts } = await import('../mail.js');
      let st = null;
      if (check) for (let i = 0; i < 6; i++) { st = await call('check'); if (!st.more || st.problem) break; }
      const out = { added: 0, waiting: 0, read: 0 };
      for (let round = 0; round < 40; round++) {
        st = await call('inbox');
        if (app.vault !== vault) return null; // locked meanwhile
        if (!st.items.length) break;
        for (const it of st.items) {
          let msgs = [];
          try { msgs = await openBox(m.key, it.box); } catch { /* sealed to an older key: nothing to read */ }
          const r = routeAlerts(vault, readMessages(msgs), { currency: vault.account?.currency || null });
          out.added += r.added; out.waiting += r.waiting; out.read += msgs.length;
        }
        // Saved (encrypted) before the server lets go of its copies.
        await app.commit({ silent: true });
        await call('ack', { ids: st.items.map((x) => x.id) });
        if (st.items.length < 5) break;
      }
      const problem = st?.problem || null;
      const changed = m.problem !== problem || m.lastCheck !== st?.lastCheck;
      m.problem = problem;
      m.lastCheck = st?.lastCheck || m.lastCheck || null;
      if (out.read || check) m.last = { at: new Date().toISOString(), scanned: out.read, added: out.added, waiting: out.waiting };
      if (changed || check) await app.commit({ silent: true });
      if (!quiet || out.added || out.waiting) {
        const bits = [out.added ? `${plural(out.added, 'transaction')} added` : '', out.waiting ? `${out.waiting} to check` : ''].filter(Boolean);
        toast(bits.length ? `Bank emails: ${bits.join(', ')}` : 'No new bank emails', { icon: 'envelope', color: 'blue' });
      }
      return out;
    } catch (e) {
      if (app.vault !== vault) return null;
      if (e.code === 'mail_not_connected') { m.connected = false; m.problem = 'login'; await app.commit({ silent: true }); }
      if (!quiet) toast(mailMessage(e), { icon: 'warn', color: 'orange' });
      return null;
    }
  })();
  pulling = run;
  // Cleared before anything chained on it runs, so a waiting "check now" starts a fresh pull.
  run.finally(() => { if (pulling === run) pulling = null; });
  return run;
}

/** After unlocking: collect now, then every hour while Money stays open. */
export function maybeAutoCheck({ now = true } = {}) {
  const m = app.vault?.mail;
  if (!m?.connected) return;
  if (now) pullMail({ quiet: true });
  clearInterval(timer);
  timer = setInterval(() => { if (app.vault?.mail?.connected) pullMail({ quiet: true }); else clearInterval(timer); }, 3600e3);
}

const STEPS_ALERTS = 'In your bank’s app or website, look for <b>Alerts</b> or <b>Notifications</b> and turn on email alerts for purchases (set the amount to $0 or $1 to get every one), plus e-Transfers and deposits if you like.';

export async function openMail({ onDone } = {}) {
  let poll = null, link = null, verifier = null, error = null, busy = false, pasteNote = null, showPaste = false, showSetup = false, finishing = false, closed = false;
  let picked = null; // keys ticked in the review list
  let shown = new Set(); // keys the list on screen shows (Skip never drops ones you haven't seen)
  const stop = () => { clearInterval(poll); poll = null; document.removeEventListener('visibilitychange', onVisible); };
  const onVisible = () => { if (document.visibilityState === 'visible' && poll) finish(); };
  const sheet = openSheet({ title: 'Bank Emails', size: 'full', body: '<div class="empty" style="padding:60px 0"><span class="spinner dark"></span></div>', onClose: () => { closed = true; stop(); onDone?.(); } });
  const status = app.demo || !app.account ? { mail: false } : await cloud.serverStatus();
  const { mailState, addAlerts, dismissAlerts, routeAlerts } = await import('../mail.js');
  const { parseAlert, parseEml, sourceOf, KIND_NAMES } = await import('../email-parse.js');
  if (closed || !app.vault) return;
  if (!app.demo) {
    const m = mailState(app.vault);
    if (m.refresh) { delete m.refresh; m.connected = false; } // the earlier version kept the sign-in here
  }

  const hero = (ic, color, title, text) => `<div class="sheet-hero" style="padding-top:18px">
    <span class="cat-icon lg" style="--c:var(--${color})">${icon(ic)}</span><div class="name">${title}</div>
    <p class="when" style="max-width:350px;margin:8px auto 0">${text}</p></div>`;
  const steps = (list, color = 'blue') => `<div class="list">${list.map((s, i) => `<div class="row with-icon"><span class="cat-icon sm" style="--c:var(--${color})"><b style="font:600 13px/1 var(--font)">${i + 1}</b></span><span class="main"><span class="subtitle" style="white-space:normal;color:var(--label)">${s}</span></span></div>`).join('')}</div>`;

  function review() {
    const m = app.vault.mail;
    shown = new Set(m.pending.map((p) => p.key));
    if (!m.pending.length) return '';
    picked ||= new Set(m.pending.filter((p) => !(p.currency && app.vault.account?.currency && p.currency !== app.vault.account.currency)).map((p) => p.key));
    const groups = new Map();
    for (const p of m.pending) { const k = sourceOf(p); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
    const n = m.pending.filter((p) => picked.has(p.key)).length;
    return `<div class="section-head" style="margin-top:22px"><h2>To Check</h2><span class="detail" style="color:var(--label-2)">${m.pending.length}</span></div>
      <p class="list-foot" style="margin-top:-4px">Money wasn’t sure about these (or they’re in another currency). Tick the ones to record.</p>
      ${[...groups].map(([src, list]) => `
        <div class="list-head"><span>${esc(src)}</span></div>
        <div class="list">
          ${list.map((p) => {
            const foreign = p.currency && app.vault.account?.currency && p.currency !== app.vault.account.currency;
            return `<button class="row with-icon tap mail-row" data-key="${esc(p.key)}" aria-pressed="${picked.has(p.key)}">
              <span class="pick">${icon('check')}</span>
              <span class="main"><span class="title">${esc(p.merchant || KIND_NAMES[p.kind] || 'Transaction')}${p.confidence !== 'high' ? '<span class="mail-tag">Check</span>' : ''}</span>
              <span class="subtitle">${esc(dateLabel(p.date, 'short'))} · ${esc(KIND_NAMES[p.kind] || '')}${foreign ? ` · in ${esc(p.currency)}` : ''}</span></span>
              <span class="value num ${p.amount > 0 ? 'pos' : ''}">${money(p.amount, { sign: p.amount > 0 })}</span></button>`;
          }).join('')}
          <label class="row"><span class="main"><span class="title">Record new ones by themselves</span><span class="subtitle" style="white-space:normal">When Money is sure what an email says. Off: every one waits here.</span></span>
            <span class="switch"><input type="checkbox" data-follow="${esc(src)}" ${m.sources[src] !== 'ask' ? 'checked' : ''} aria-label="Record new ones from ${esc(src)} by themselves"><span></span></span></label>
          <button class="row tap" data-ignore="${esc(src)}"><span class="main"><span class="title" style="color:var(--red)">Ignore Emails Like These</span></span></button>
        </div>`).join('')}
      <div class="btn-row"><button class="btn" data-act="add" ${n ? '' : 'disabled'}>${icon('plus')} Add ${n ? plural(n, 'Transaction') : 'Transactions'}</button>
        <button class="btn secondary" data-act="dismiss">Skip ${n === m.pending.length ? 'All' : 'the Rest'}</button></div>`;
  }

  function gmailBlock() {
    const m = app.vault.mail;
    if (app.demo) return '';
    if (!app.account) return `<div class="list-head"><span>Gmail</span></div><p class="list-foot" style="margin-top:0">Connecting Gmail goes through the sync server, so it needs a Money account (Settings → Account). Pasting an email or adding .eml files works without one.</p>`;
    if (!status.mail) {
      return `<div class="list-head"><span>Gmail</span></div>
        <button class="row with-icon tap" data-act="setup" style="border-radius:var(--radius)"><span class="cat-icon sm" style="--c:var(--gray)">${icon('envelope')}</span>
          <span class="main"><span class="title">Gmail isn’t switched on</span><span class="subtitle">${showSetup ? 'How the site owner turns it on' : 'Tap to see how to turn it on'}</span></span>${icon(showSetup ? 'chev-d' : 'chev-r', 'chev')}</button>
        ${showSetup ? steps([
          'At <b>console.cloud.google.com</b>, make a project and switch on the <b>Gmail API</b> (APIs &amp; Services → Library).',
          'Under <b>Google Auth Platform</b>, set up the consent screen (External), add the Gmail addresses that will use it as test users, then <b>Publish</b> it so sign-ins don’t expire every 7 days.',
          `Under <b>Clients</b>, create a <b>Web application</b> client with this redirect URI: <b>${esc(location.origin)}/api/v1/mail/callback</b>`,
          'In Cloudflare → your Worker → Settings → Variables and secrets, add <b>GOOGLE_CLIENT_ID</b>, and <b>GOOGLE_CLIENT_SECRET</b> as a secret.',
        ], 'gray') : ''}`;
    }
    if (m.connected && m.problem !== 'login') {
      return `<div class="list-head"><span>Gmail</span></div>
        ${m.problem === 'forbidden' ? `<p class="list-foot neg" style="margin-top:0">Gmail said no. Make sure the Gmail API is switched on in the Google Cloud project.</p>` : ''}
        <div class="list">
          <div class="row with-icon"><span class="cat-icon sm" style="--c:var(--${m.problem ? 'orange' : 'green'})">${icon('envelope')}</span><span class="main"><span class="title">Gmail connected</span><span class="subtitle">Checked every hour, even with Money closed</span></span></div>
          <div class="row"><span class="main"><span class="title">${m.lastCheck ? `Last checked ${esc(when(m.lastCheck))}` : 'Not checked yet'}</span>${m.last ? `<span class="subtitle">${m.last.scanned ? `${plural(m.last.scanned, 'new email')} read · ${m.last.added} recorded${m.last.waiting ? ` · ${m.last.waiting} to check` : ''}` : 'No new emails'}</span>` : ''}</span></div>
        </div>
        <button class="btn" data-act="check" style="margin-top:12px" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span> Checking…' : `${icon('arrows')} Check Now`}</button>`;
    }
    return `<div class="list-head"><span>Gmail</span></div>
      ${m.problem === 'login' ? `<div class="banner" style="--c:var(--orange)"><span class="ic">${icon('warn')}</span><span class="txt"><b>Sign in to Gmail again</b><span>Google ended the connection. Connect again to keep recording transactions.</span></span></div>` : ''}
      ${poll ? `<div class="list"><div class="row"><span class="spinner dark"></span><span class="main"><span class="title">Waiting for Google…</span><span class="subtitle" style="white-space:normal">Allow read-only access on Google’s page, then come back. This updates by itself.</span></span></div></div>` : ''}
      ${link ? `<a class="btn" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" data-act="go">${icon('envelope')} ${poll ? 'Open Google Again' : 'Connect Gmail'}</a>`
        : `<button class="btn" disabled><span class="spinner"></span> Preparing…</button>`}
      <p class="list-foot">Google asks to let Money <b>read</b> your email. Every hour, Money looks only for emails that read like bank alerts and records the transactions in them. It can’t send, change or delete anything.</p>`;
  }

  const draw = () => {
    const m = app.vault.mail || {};
    if (app.demo) return sheet.setBody(hero('lock', 'gray', 'Not in sample data', 'Bank emails add real transactions, so it’s off while you’re exploring sample data.'));
    const fresh = !m.connected && !(m.pending || []).length && !(m.seen || []).length;
    sheet.setBody(`
      ${hero('envelope', 'blue', 'Transactions from bank emails', fresh
        ? 'Most banks email you every time your card is used. Connect Gmail and Money checks every hour for those alerts, then records and categorizes each purchase, deposit and transfer. No statements to download.'
        : 'Every hour, new alerts are read for the amount, store, date and direction, then recorded and categorized. The few Money isn’t sure about wait here for a quick check.')}
      ${error ? `<p class="list-foot neg" style="text-align:center">${esc(error)}</p>` : ''}
      ${review()}
      ${gmailBlock()}
      <div class="list-head"><span>Other email apps</span></div>
      <div class="list">
        <button class="row with-icon tap" data-act="paste" aria-expanded="${showPaste}"><span class="cat-icon sm" style="--c:var(--indigo)">${icon('copy')}</span>
          <span class="main"><span class="title">Paste an Email</span><span class="subtitle">Copy an alert from any email app</span></span>${icon(showPaste ? 'chev-d' : 'chev-r', 'chev')}</button>
        ${showPaste ? `<div class="row" style="display:block;padding:12px 16px">
          <textarea class="mail-paste" id="mail-text" placeholder="e.g. A purchase of $12.48 was made at Tim Hortons on Oct 3 with your Visa card." aria-label="Email text"></textarea>
          <button class="btn small" data-act="read" style="margin-top:10px">Read It</button>
          ${pasteNote ? `<p class="list-foot ${pasteNote.ok ? '' : 'neg'}" style="padding:8px 0 0">${esc(pasteNote.text)}</p>` : ''}</div>` : ''}
        <label class="row with-icon tap"><span class="cat-icon sm" style="--c:var(--teal)">${icon('doc')}</span>
          <span class="main"><span class="title">Add Email Files</span><span class="subtitle">.eml files saved or dragged from Mail or Outlook</span></span>${icon('chev-r', 'chev')}
          <input type="file" accept=".eml,message/rfc822" multiple hidden id="mail-file"></label>
      </div>
      <div class="list-head"><span>Getting alerts</span></div>
      <p class="list-foot" style="margin-top:0">${STEPS_ALERTS} Alerts that go to a different address can be forwarded to the Gmail you connect, or pasted here.</p>
      ${m.connected ? `<div class="list" style="margin-top:22px"><button class="row tap" data-act="disconnect"><span class="main"><span class="title" style="color:var(--red)">Disconnect Gmail</span></span></button></div>` : ''}
      <p class="list-foot">The hourly check runs on your Money server: it keeps the Gmail sign-in encrypted, and locks any alert emails it finds so only your own devices can open them. They’re deleted from the server as soon as Money has read them. Only the date, amount, a cleaned-up store name and which bank sent it are kept, inside your encrypted vault; card and account numbers never are. One-time codes, ads, statements-ready notes, reminders and declined purchases are skipped.</p>`);
  };

  async function prepare() {
    if (!status.mail || !app.account || app.vault.mail?.connected && app.vault.mail.problem !== 'login') return;
    try {
      const { pkce, newMailKey } = await import('../gmail.js');
      // The key that lets only this account's devices open what the hourly check finds (kept if reconnecting).
      if (!app.vault.mail.key) { app.vault.mail.key = await newMailKey(); await app.commit({ silent: true }); }
      const p = await pkce();
      verifier = p.verifier;
      link = await cloud.mail(app.account, app.vault.sync.token, 'link', { challenge: p.challenge });
      error = null;
    } catch (e) { error = mailMessage(e); }
    draw();
  }
  async function finish() {
    if (finishing || !link) return;
    finishing = true;
    try {
      const { publicOf } = await import('../gmail.js');
      const r = await cloud.mail(app.account, app.vault.sync.token, 'finish', { state: link.state, verifier, publicKey: publicOf(app.vault.mail.key) });
      if (r.status === 'pending') return;
      stop();
      if (r.status !== 'done') {
        error = r.status === 'no_scope' ? 'Money needs the “read your email” box ticked on Google’s page to find alerts.'
          : r.status === 'other_browser' ? 'Google came back to a different browser than the one Money is open in. On iPhone, open Money in Safari (not from the Home Screen) to connect Gmail; once it’s connected, it works on all your devices.'
            : r.status === 'expired' ? 'That took too long. Try again.' : 'Gmail wasn’t connected. Try again when you’re ready.';
        link = null; draw(); prepare(); return;
      }
      const m = mailState(app.vault);
      Object.assign(m, { connected: true, connectedAt: new Date().toISOString(), problem: null });
      link = null;
      await app.commit({ silent: true });
      haptic('success');
      await runCheck();
      maybeAutoCheck({ now: false });
    } catch (e) { error = mailMessage(e); draw(); } finally { finishing = false; }
  }
  async function runCheck() {
    busy = true; error = null; draw();
    await pullMail({ check: true });
    busy = false; picked = null; draw();
  }
  async function take(parsed) {
    const out = routeAlerts(app.vault, parsed, { currency: app.vault.account?.currency || null });
    picked = null;
    await app.commit({ silent: true });
    return out;
  }

  draw();
  prepare();

  sheet.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="go"]')) {
      haptic();
      if (!poll) { poll = setInterval(finish, 3000); document.addEventListener('visibilitychange', onVisible); setTimeout(draw, 50); }
      return;
    }
    const row = e.target.closest('.mail-row');
    if (row) {
      if (!picked) return;
      haptic();
      const k = row.dataset.key;
      if (picked.has(k)) picked.delete(k); else picked.add(k);
      row.setAttribute('aria-pressed', String(picked.has(k)));
      const n = app.vault.mail.pending.filter((p) => shown.has(p.key) && picked.has(p.key)).length;
      const add = sheet.el.querySelector('[data-act="add"]');
      add.disabled = !n;
      add.innerHTML = `${icon('plus')} Add ${n ? plural(n, 'Transaction') : 'Transactions'}`;
      sheet.el.querySelector('[data-act="dismiss"]').textContent = `Skip ${n === shown.size ? 'All' : 'the Rest'}`;
      return;
    }
    const ignore = e.target.closest('[data-ignore]')?.dataset.ignore;
    if (ignore) {
      const ok = await alertSheet({ title: `Ignore ${ignore}?`, message: 'These alerts are skipped, now and from now on. You can still add the same transactions from a statement.', actions: [{ label: 'Ignore', value: true, style: 'destructive' }, { label: 'Cancel', value: false, style: 'cancel' }] });
      if (!ok) return;
      const m = app.vault.mail;
      m.sources[ignore] = false;
      dismissAlerts(app.vault, m.pending.filter((p) => sourceOf(p) === ignore).map((p) => p.key));
      picked = null;
      await app.commit({ silent: true });
      draw();
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if ((act === 'add' || act === 'dismiss') && (!picked || busy)) return;
    if (act === 'add') {
      haptic('success');
      const m = app.vault.mail;
      const chosen = m.pending.filter((p) => picked.has(p.key) && shown.has(p.key));
      const r = addAlerts(app.vault, chosen.map((p) => ({ ...p, ok: true })));
      // The rest stay for later; only an explicit Skip drops them.
      picked = null;
      await app.commit({ silent: true });
      const dup = r.duplicates + r.covered;
      toast(r.added ? `${plural(r.added, 'transaction')} added${dup ? ` (${dup} already there)` : ''}` : 'Already in your transactions', { icon: 'check', color: 'green' });
      draw();
    }
    if (act === 'dismiss') {
      const m = app.vault.mail;
      const onScreen = m.pending.filter((p) => shown.has(p.key));
      const rest = onScreen.filter((p) => !picked.has(p.key)).map((p) => p.key);
      dismissAlerts(app.vault, rest.length ? rest : onScreen.map((p) => p.key));
      picked = null;
      await app.commit({ silent: true });
      draw();
    }
    if (act === 'check') { haptic(); await runCheck(); }
    if (act === 'setup') { showSetup = !showSetup; draw(); }
    if (act === 'paste') { showPaste = !showPaste; pasteNote = null; draw(); if (showPaste) sheet.el.querySelector('#mail-text')?.focus(); }
    if (act === 'read') {
      const text = sheet.el.querySelector('#mail-text')?.value || '';
      if (!text.trim()) return;
      const p = parseAlert({ text });
      if (!p.ok) {
        haptic('error');
        pasteNote = { ok: false, text: { code: 'That’s a sign-in or verification code, not a transaction.', declined: 'That purchase was declined, so no money moved.', statement: 'That’s a “statement ready” note. Add the statement itself instead.', reminder: 'That’s a payment reminder, not a transaction.', balance: 'That’s a balance update, not a transaction.', promo: 'That looks like an ad.', order: 'That’s a shipping update. The charge shows up in your bank alerts or statement.', receipt: 'That looks like a store receipt. Money uses your bank’s alert for the charge instead.' }[p.reason] || 'Couldn’t find a transaction in that. Paste the whole alert, including the amount.' };
        draw();
        return;
      }
      haptic('success');
      const out = await take([p]);
      pasteNote = { ok: true, text: out.added ? `Added: ${p.merchant || KIND_NAMES[p.kind]} ${money(p.amount)} on ${dateLabel(p.date, 'short')}.` : out.waiting ? `Found ${p.merchant || KIND_NAMES[p.kind]} ${money(p.amount)} on ${dateLabel(p.date, 'short')}. It’s in the list above to check.` : out.covered ? 'Your statements already cover that day.' : 'Already read that one.' };
      draw();
    }
    if (act === 'disconnect') {
      const ok = await alertSheet({ title: 'Disconnect Gmail?', message: 'Transactions already added stay. Money stops reading new alerts and Google forgets the connection.', actions: [{ label: 'Disconnect', value: true, style: 'destructive' }, { label: 'Cancel', value: false, style: 'cancel' }] });
      if (!ok) return;
      haptic('heavy');
      const m = app.vault.mail;
      try { await cloud.mail(app.account, app.vault.sync.token, 'remove'); } catch { /* forgotten here either way */ }
      for (const k of ['connected', 'connectedAt', 'lastCheck', 'problem', 'last']) delete m[k];
      await app.commit({ silent: true });
      toast('Gmail disconnected');
      draw();
      prepare();
    }
  });

  sheet.el.addEventListener('change', async (e) => {
    const follow = e.target.dataset?.follow;
    if (follow) {
      haptic();
      if (e.target.checked) delete app.vault.mail.sources[follow]; else app.vault.mail.sources[follow] = 'ask';
      await app.commit({ silent: true });
      return;
    }
    if (e.target.id !== 'mail-file' || !e.target.files?.length) return;
    const files = [...e.target.files];
    const parsed = [];
    for (const f of files.slice(0, 200)) {
      try { parsed.push(parseAlert(parseEml(new Uint8Array(await f.arrayBuffer())))); } catch { /* not an email file */ }
    }
    const found = parsed.filter((p) => p.ok).length;
    const out = await take(parsed);
    toast(found ? `${plural(found, 'alert')} found${out.added ? `, ${out.added} added` : ''}${out.waiting ? `, ${out.waiting} to check` : ''}` : 'No bank alerts in those emails', { icon: found ? 'envelope' : 'warn', color: found ? 'blue' : 'orange' });
    draw();
  });
}
