// Money sync API (Cloudflare Worker + D1). It only ever stores ciphertext.
//
// Each account row holds an encrypted vault envelope plus the public KDF parameters (salt,
// iterations) needed to turn the passphrase back into the key on a new device. Reading or writing
// a vault needs an auth token that the browser derives from the passphrase-derived key
// (HKDF, "money/cloud-auth/v1"). The server stores only SHA-256 of that token, so it can't
// decrypt anything and can't hand anyone else's ciphertext out.
//
// Routes (JSON):
//   GET    /api/v1/status                      -> { configured }
//   POST   /api/v1/accounts                    { invite, username, kdf, authHash, envelope } -> 201
//   GET    /api/v1/accounts/:user/kdf          -> { salt, iterations }   (fake but stable for unknown users)
//   GET    /api/v1/accounts/:user/vault        Bearer token -> { envelope, rev }
//   PUT    /api/v1/accounts/:user/vault        Bearer token { envelope, baseRev, kdf?, authHash?, force?, recovery? } -> { rev }
//   GET    /api/v1/accounts/:user/recovery     -> { recovery }  (fake but stable when there's none)
//   PUT    /api/v1/accounts/:user/recovery     Bearer token { recovery | null } -> 204
//   DELETE /api/v1/accounts/:user              Bearer token -> 204
//   POST   /api/v1/accounts/:user/bank/link    Bearer token { accessToken? } -> { linkToken, url }
//   POST   /api/v1/accounts/:user/bank/finish  Bearer token { linkToken } -> { status, accessToken?, institution?, accounts? }
//   POST   /api/v1/accounts/:user/bank/sync    Bearer token { accessToken, cursor, accountId } -> { added, modified, removed, cursor, accounts }
//   POST   /api/v1/accounts/:user/bank/remove  Bearer token { accessToken } -> 204
//   POST   /api/v1/accounts/:user/mail/link    Bearer token { challenge } -> { state, url }
//   GET    /api/v1/mail/callback               (Google sends the browser here) -> 302 /mail-done.html
//   POST   /api/v1/accounts/:user/mail/finish  Bearer token { state, verifier, publicKey } -> { status }
//   POST   /api/v1/accounts/:user/mail/check   Bearer token -> { fetched, more, connected, lastCheck, problem, waiting }
//   POST   /api/v1/accounts/:user/mail/inbox   Bearer token -> { items: [{ id, box }], connected, lastCheck, problem, waiting }
//   POST   /api/v1/accounts/:user/mail/ack     Bearer token { ids } -> 204
//   POST   /api/v1/accounts/:user/mail/remove  Bearer token -> 204
//   (scheduled, hourly)                         checks every connected Gmail
//
// Bank sync (optional, Plaid): the browser keeps the Plaid access token inside its encrypted vault and
// sends it with each sync. The Worker adds the Plaid secret, relays the call and keeps nothing:
// transactions pass through in memory only. Account numbers (even Plaid's last-4 "mask") are dropped.
//
// Bank emails (optional, Gmail): Google signs you in and sends a one-time code here, which waits (for at
// most 15 minutes, under a hash of a random state, and only for the browser that asked) until the app
// collects it. Turning the code into a token needs both the Google client secret (here) and a PKCE verifier
// only the app has. So that Gmail can be checked every hour with the app closed, the Worker keeps the
// Google sign-in, encrypted with a key derived from its secret. Each hour it searches Gmail (read-only) for
// alert-like emails, keeps only their sender, subject, date and text, and seals them to the account's
// public key (ECDH P-256 + AES-GCM); the private key lives only in the encrypted vault, so only the
// account's own devices can read them. The app reads them when it opens, adds the transactions to the
// vault, and the sealed copies are deleted.
//
// Recovery: the browser can wrap the vault key with a random recovery key the owner saves
// (AES-GCM, key from HKDF of the recovery key). The server only stores that wrapped blob, which is
// useless without the recovery key, so it can hand it to anyone who asks.
//
// Bindings: DB (D1). Secret: INVITE_CODE (needed to create accounts).
// Optional, for bank sync: PLAID_CLIENT_ID, PLAID_SECRET (secret), PLAID_ENV ("production" or "sandbox"),
// PLAID_COUNTRIES (default "CA,US").
// Optional, for bank emails: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (secret).

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MAX_ENVELOPE = 1_800_000; // D1 rows top out around 2 MB
const MAX_FAILS = 10; // wrong tokens per account from one network, per window
const MAX_FAILS_ACCOUNT = 300; // wrong tokens per account from everywhere, per window (bounds distributed guessing)
const FAIL_WINDOW = 15 * 60; // seconds
const enc = new TextEncoder();

const json = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: HEADERS });
const err = (status, error, extra = {}) => json({ error, ...extra }, status);

let schemaReady = false;
let siteSecret = null;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS accounts (
      username TEXT PRIMARY KEY, salt TEXT NOT NULL, iterations INTEGER NOT NULL, auth_hash TEXT NOT NULL,
      envelope TEXT NOT NULL, rev INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare('CREATE TABLE IF NOT EXISTS failures (username TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS recovery (username TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS mail_handoff (state_hash TEXT PRIMARY KEY, username TEXT NOT NULL, browser_hash TEXT NOT NULL, code TEXT, error TEXT, created INTEGER NOT NULL)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS mail_watch (username TEXT PRIMARY KEY, token_enc TEXT NOT NULL, pubkey TEXT NOT NULL, last_check TEXT,
      seen TEXT NOT NULL, problem TEXT, last_run INTEGER NOT NULL, connected_at TEXT NOT NULL)`),
    db.prepare('CREATE TABLE IF NOT EXISTS mail_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, box TEXT NOT NULL, created INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS mail_inbox_user ON mail_inbox (username, id)'),
  ]);
  // A random secret made once per site, for the fake answers about unknown usernames.
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('site_secret', fresh).run();
  siteSecret = (await db.prepare('SELECT v FROM meta WHERE k = ?').bind('site_secret').first())?.v || fresh;
  schemaReady = true;
}

async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function validEnvelope(e) {
  return e && e.format === 'abraar-money-vault' && e.v === 1 && Number.isInteger(e.rev) && e.rev > 0
    && typeof e.ct === 'string' && e.kdf && typeof e.kdf.salt === 'string' && Number.isInteger(e.kdf.iterations)
    && JSON.stringify(e).length <= MAX_ENVELOPE;
}
const validKdf = (k) => k && typeof k.salt === 'string' && k.salt.length >= 16 && k.salt.length <= 64 && Number.isInteger(k.iterations) && k.iterations >= 100_000 && k.iterations <= 10_000_000;
const validHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const validRecovery = (r) => r && r.v === 1 && typeof r.iv === 'string' && r.iv.length === 16 && B64.test(r.iv) && typeof r.ct === 'string' && r.ct.length <= 100 && B64.test(r.ct);
const setRecovery = (db, username, r, now) => (r
  ? db.prepare('INSERT OR REPLACE INTO recovery (username, blob, updated_at) VALUES (?, ?, ?)').bind(username, JSON.stringify(r), now)
  : db.prepare('DELETE FROM recovery WHERE username = ?').bind(username));

async function body(req) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_ENVELOPE + 10_000) throw Object.assign(new Error('too_large'), { status: 413 });
  try { return await req.json(); } catch { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}

async function hmac(env, label, username) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`money-${label}|${siteSecret || env.INVITE_CODE || 'unset'}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(username)));
}
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

/** Stable fake salt for unknown usernames, so the KDF endpoint doesn't reveal who has an account. */
async function fakeKdf(env, username) {
  const mac = await hmac(env, 'kdf', username);
  return { salt: b64(mac.slice(0, 16)), iterations: 600_000 };
}
/** Same idea for recovery: a blob of the right shape that no key opens. */
async function fakeRecovery(env, username) {
  const a = await hmac(env, 'rec-a', username);
  const b = await hmac(env, 'rec-b', username);
  return { v: 1, iv: b64(a.slice(0, 12)), ct: b64(new Uint8Array([...a.slice(12, 32), ...b.slice(0, 28)])) };
}

/** Count one wrong guess atomically and return the new count for that key. */
async function bump(db, key, now) {
  const r = await db.prepare(`INSERT INTO failures (username, count, window_start) VALUES (?1, 1, ?2)
    ON CONFLICT(username) DO UPDATE SET
      count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END
    RETURNING count`).bind(key, now, FAIL_WINDOW).first();
  return r?.count ?? 1;
}

async function authorize(req, db, username) {
  const now = Math.floor(Date.now() / 1000);
  const client = req.headers.get('CF-Connecting-IP') || 'local';
  const here = `${username}|${client}`;
  // Throttle wrong guesses per account *and network*: someone else guessing can't lock the owner out.
  // The attempt is counted atomically *before* the token is checked, so parallel requests can't
  // all slip in under the limit; a correct token then clears the count.
  const all = await db.prepare('SELECT count, window_start FROM failures WHERE username = ?').bind(`${username}|*`).first();
  if (all && now - all.window_start < FAIL_WINDOW && all.count >= MAX_FAILS_ACCOUNT) {
    return { error: err(429, 'too_many_attempts', { retryAfter: FAIL_WINDOW - (now - all.window_start) }) };
  }
  const tries = await bump(db, here, now);
  if (tries > MAX_FAILS) return { error: err(429, 'too_many_attempts', { retryAfter: FAIL_WINDOW }) };
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const row = await db.prepare('SELECT * FROM accounts WHERE username = ?').bind(username).first();
  if (row && token && safeEqual(await sha256hex(token), row.auth_hash)) {
    await db.prepare('DELETE FROM failures WHERE username = ?').bind(here).run();
    return { row };
  }
  // Counted whether or not the account exists, so behaviour is the same.
  await bump(db, `${username}|*`, now);
  return { error: err(401, 'unauthorized') };
}

// ---------------------------------------------------------------------------
// Bank sync through Plaid
// ---------------------------------------------------------------------------
const bankOn = (env) => !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
const plaidBase = (env) => (/^(https:\/\/|http:\/\/localhost[:/])/.test(env.PLAID_BASE || '') ? env.PLAID_BASE.replace(/\/+$/, '')
  : `https://${env.PLAID_ENV === 'sandbox' ? 'sandbox' : 'production'}.plaid.com`);
const ACCESS_RE = /^access-[a-z]+-[0-9a-f-]{20,60}$/;
const LINK_RE = /^link-[a-z]+-[0-9a-f-]{20,60}$/;

async function plaid(env, path, payload) {
  let res, data;
  try {
    res = await fetch(`${plaidBase(env)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Plaid-Version': '2020-09-14' },
      body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...payload }),
    });
    data = await res.json();
  } catch {
    throw Object.assign(new Error('bank_unreachable'), { status: 502 });
  }
  if (!res.ok || data?.error_code) {
    // Plaid's message for people (never the request or our secret).
    throw Object.assign(new Error('bank_error'), { status: 502, extra: { plaid: data?.error_code || 'UNKNOWN', detail: data?.display_message || data?.error_message || '' } });
  }
  return data;
}

const slimAccount = (a) => ({
  id: a.account_id || a.id, name: a.official_name || a.name || 'Account', type: a.type, subtype: a.subtype,
  current: a.balances?.current ?? null, available: a.balances?.available ?? null, currency: a.balances?.iso_currency_code || null,
});
const slimTxn = (t) => ({
  id: t.transaction_id, account: t.account_id, date: t.date, amount: t.amount, currency: t.iso_currency_code || t.unofficial_currency_code || null,
  name: t.name || '', merchant: t.merchant_name || '', original: t.original_description || '', pending: !!t.pending,
  pfc: t.personal_finance_category?.detailed || t.personal_finance_category?.primary || '',
});

async function bankRoute(action, req, env, url, username) {
  if (!bankOn(env)) return err(503, 'bank_not_configured');
  const b = await body(req);
  if (action === 'link') {
    // New connection, or "update mode" when the bank needs you to sign in again.
    const update = typeof b.accessToken === 'string' && ACCESS_RE.test(b.accessToken);
    const user = [...await hmac(env, 'plaid-user', username)].slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join('');
    const r = await plaid(env, '/link/token/create', {
      client_name: 'Money', language: 'en',
      country_codes: String(env.PLAID_COUNTRIES || 'CA,US').split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
      user: { client_user_id: user },
      ...(update ? { access_token: b.accessToken } : { products: ['transactions'], transactions: { days_requested: 730 } }),
      hosted_link: { completion_redirect_uri: `${url.origin}/bank-done.html`, url_lifetime_seconds: 1800 },
    });
    if (!r.hosted_link_url) return err(502, 'bank_error', { plaid: 'NO_HOSTED_LINK', detail: 'Plaid didn’t return a Hosted Link URL.' });
    return json({ linkToken: r.link_token, url: r.hosted_link_url });
  }
  if (action === 'finish') {
    if (typeof b.linkToken !== 'string' || !LINK_RE.test(b.linkToken)) return err(400, 'bad_request');
    const r = await plaid(env, '/link/token/get', { link_token: b.linkToken });
    const sessions = r.link_sessions || [];
    let publicToken = null, institution = null, finished = false;
    for (const s of sessions) {
      const add = s.results?.item_add_results?.[0];
      const pt = add?.public_token || s.on_success?.public_token;
      if (pt) { publicToken = pt; institution = add?.institution?.name || s.on_success?.metadata?.institution?.name || null; }
      if (s.on_success) finished = true;
      if (s.exit || s.on_exit) finished ||= 'exit';
    }
    if (b.update) return json({ status: publicToken || finished === true ? 'done' : finished ? 'exited' : 'pending' });
    if (!publicToken) return json({ status: finished === 'exit' ? 'exited' : 'pending' });
    const ex = await plaid(env, '/item/public_token/exchange', { public_token: publicToken });
    const acc = await plaid(env, '/accounts/get', { access_token: ex.access_token });
    return json({ status: 'done', accessToken: ex.access_token, institution: institution || acc.item?.institution_name || null, accounts: (acc.accounts || []).map(slimAccount) });
  }
  if (action === 'sync') {
    if (typeof b.accessToken !== 'string' || !ACCESS_RE.test(b.accessToken)) return err(400, 'bad_request');
    const start = typeof b.cursor === 'string' && b.cursor.length < 2000 ? b.cursor : '';
    const want = typeof b.accountId === 'string' ? b.accountId : null;
    const keep = (t) => !want || t.account_id === want;
    // Page through everything since the cursor; if the data changes mid-way, start again from it.
    for (let attempt = 0; attempt < 3; attempt++) {
      let cursor = start, status = null;
      const out = { added: [], modified: [], removed: [], accounts: [] };
      try {
        for (let page = 0; page < 40; page++) {
          const r = await plaid(env, '/transactions/sync', { access_token: b.accessToken, cursor: cursor || undefined, count: 500, options: { include_original_description: true } });
          out.added.push(...r.added.filter(keep).map(slimTxn));
          out.modified.push(...r.modified.filter(keep).map(slimTxn));
          out.removed.push(...r.removed.filter(keep).map((x) => x.transaction_id));
          out.accounts = (r.accounts || []).map(slimAccount);
          status = r.transactions_update_status || null;
          // An empty cursor means Plaid hasn't pulled the history yet: keep the one we had.
          if (r.next_cursor) cursor = r.next_cursor;
          if (!r.has_more) break;
        }
      } catch (e) {
        if (e.extra?.plaid === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') continue;
        throw e;
      }
      if (!out.accounts.length) out.accounts = ((await plaid(env, '/accounts/get', { access_token: b.accessToken })).accounts || []).map(slimAccount);
      return json({ ...out, cursor, status });
    }
    return err(502, 'bank_error', { plaid: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', detail: 'Your bank was updating. Try again in a minute.' });
  }
  if (action === 'remove') {
    if (typeof b.accessToken !== 'string' || !ACCESS_RE.test(b.accessToken)) return err(400, 'bad_request');
    await plaid(env, '/item/remove', { access_token: b.accessToken });
    return json(null, 204);
  }
  return err(404, 'not_found');
}

// ---------------------------------------------------------------------------
// Bank emails through Gmail: Google sign-in, then a check every hour (and on demand)
// ---------------------------------------------------------------------------
const mailOn = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const googleBase = (env) => (/^(https:\/\/|http:\/\/localhost[:/])/.test(env.GOOGLE_BASE || '') ? env.GOOGLE_BASE.replace(/\/+$/, '') : null);
const googleUrl = (env, what) => {
  const test = googleBase(env);
  if (test) return `${test}/${what}`;
  return { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' }[what];
};
const STATE_RE = /^[0-9a-f]{64}$/;
const PKCE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const HANDOFF_TTL = 15 * 60; // seconds

async function google(env, what, form) {
  let res, data;
  try {
    res = await fetch(googleUrl(env, what), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    data = what === 'revoke' ? {} : await res.json();
  } catch {
    throw Object.assign(new Error('mail_unreachable'), { status: 502 });
  }
  if (!res.ok) {
    // An expired or revoked sign-in needs Google again; anything else is Google's error code (never our secret).
    if (data?.error === 'invalid_grant') throw Object.assign(new Error('mail_reconnect'), { status: 400 });
    throw Object.assign(new Error('mail_error'), { status: 502, extra: { google: String(data?.error || res.status).slice(0, 60) } });
  }
  return data;
}

// The browser that asked for the sign-in link gets this cookie; Google's code is only accepted in a browser
// that has it. Without it, someone could send you their own sign-in link and collect your Gmail access.
const MAIL_COOKIE = '__Host-money-mail';
const cookieOf = (req, name) => (String(req.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`)) || '').slice(name.length + 1);

async function mailCallback(req, env, url) {
  const done = (ok) => new Response(null, { status: 302, headers: {
    Location: `${url.origin}/mail-done.html${ok ? '' : '?error=1'}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Set-Cookie': `${MAIL_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
  } });
  const state = url.searchParams.get('state') || '';
  if (!env.DB || !mailOn(env) || !STATE_RE.test(state)) return done(false);
  await ensureSchema(env.DB);
  const code = url.searchParams.get('code');
  const now = Math.floor(Date.now() / 1000);
  const browser = cookieOf(req, MAIL_COOKIE);
  const hash = await sha256hex(state);
  const fresh = 'state_hash = ? AND code IS NULL AND error IS NULL AND created > ?';
  if (!/^[0-9a-f]{64}$/.test(browser)) {
    // Google came back to a different browser than the one Money is in (or to someone else's): no code.
    await env.DB.prepare(`UPDATE mail_handoff SET error = 'other_browser' WHERE ${fresh}`).bind(hash, now - HANDOFF_TTL).run();
    return done(false);
  }
  const ok = !!code && code.length < 2048;
  const r = await env.DB.prepare(`UPDATE mail_handoff SET code = ?, error = ? WHERE ${fresh} AND browser_hash = ?`)
    .bind(ok ? code : null, ok ? null : String(url.searchParams.get('error') || 'cancelled').slice(0, 60), hash, now - HANDOFF_TTL, await sha256hex(browser)).run();
  if (r.meta?.changes !== 1) await env.DB.prepare(`UPDATE mail_handoff SET error = 'other_browser' WHERE ${fresh}`).bind(hash, now - HANDOFF_TTL).run();
  return done(ok && r.meta?.changes === 1);
}

async function mailRoute(action, req, env, url, username) {
  if (!mailOn(env)) return err(503, 'mail_not_configured');
  const b = await body(req);
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  if (action === 'link') {
    if (typeof b.challenge !== 'string' || !PKCE_RE.test(b.challenge)) return err(400, 'bad_request');
    const rand = () => [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const state = rand(), browser = rand();
    await db.batch([
      db.prepare('DELETE FROM mail_handoff WHERE created < ? OR username = ?').bind(now - HANDOFF_TTL, username),
      db.prepare('INSERT INTO mail_handoff (state_hash, username, browser_hash, code, error, created) VALUES (?, ?, ?, NULL, NULL, ?)').bind(await sha256hex(state), username, await sha256hex(browser), now),
    ]);
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/api/v1/mail/callback`, response_type: 'code', scope: GMAIL_SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state, code_challenge: b.challenge, code_challenge_method: 'S256',
    });
    const res = json({ state, url: `${googleUrl(env, 'auth')}?${q}` });
    res.headers.set('Set-Cookie', `${MAIL_COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${HANDOFF_TTL}`);
    return res;
  }
  if (action === 'finish') {
    if (typeof b.state !== 'string' || !STATE_RE.test(b.state) || typeof b.verifier !== 'string' || !PKCE_RE.test(b.verifier) || !validPublicKey(b.publicKey)) return err(400, 'bad_request');
    const hash = await sha256hex(b.state);
    await db.prepare('DELETE FROM mail_handoff WHERE created < ?').bind(now - HANDOFF_TTL).run();
    const row = await db.prepare('SELECT code, error, created FROM mail_handoff WHERE state_hash = ? AND username = ?').bind(hash, username).first();
    if (!row) return json({ status: 'expired' });
    if (row.error) { await db.prepare('DELETE FROM mail_handoff WHERE state_hash = ?').bind(hash).run(); return json({ status: row.error === 'other_browser' ? 'other_browser' : 'exited' }); }
    if (!row.code) return json({ status: 'pending' });
    // The code works once: take it out before using it.
    const del = await db.prepare('DELETE FROM mail_handoff WHERE state_hash = ? AND code IS NOT NULL').bind(hash).run();
    if (del.meta?.changes !== 1) return json({ status: 'pending' });
    const t = await google(env, 'token', {
      code: row.code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/api/v1/mail/callback`, grant_type: 'authorization_code', code_verifier: b.verifier,
    });
    if (!String(t.scope || '').split(' ').includes(GMAIL_SCOPE)) {
      // Google lets people untick the Gmail box; without it there's nothing to read.
      if (t.refresh_token || t.access_token) await google(env, 'revoke', { token: t.refresh_token || t.access_token }).catch(() => {});
      return json({ status: 'no_scope' });
    }
    if (!t.refresh_token) return err(502, 'mail_error', { google: 'no_refresh_token' });
    // Kept here (encrypted) so the hourly check can run while the app is closed; never sent back out.
    const old = await db.prepare('SELECT token_enc FROM mail_watch WHERE username = ?').bind(username).first();
    await db.prepare(`INSERT OR REPLACE INTO mail_watch (username, token_enc, pubkey, last_check, seen, problem, last_run, connected_at)
      VALUES (?, ?, ?, (SELECT last_check FROM mail_watch WHERE username = ?), COALESCE((SELECT seen FROM mail_watch WHERE username = ?), '[]'), NULL, 0, ?)`)
      .bind(username, await sealToken(env, username, t.refresh_token), JSON.stringify(b.publicKey), username, username, new Date().toISOString()).run();
    if (old) { const prev = await openToken(env, username, old.token_enc).catch(() => null); if (prev && prev !== t.refresh_token) await google(env, 'revoke', { token: prev }).catch(() => {}); }
    return json({ status: 'done' });
  }
  const watch = await db.prepare('SELECT * FROM mail_watch WHERE username = ?').bind(username).first();
  if (action === 'check') {
    if (!watch) return err(404, 'mail_not_connected');
    const r = await checkMail(env, watch, { n: 40 });
    return json({ ...r, ...await mailStatus(db, username) });
  }
  if (action === 'inbox') {
    // A few boxes at a time (each holds up to ~400 KB); ask again while `more`.
    const rows = (await db.prepare('SELECT id, box FROM mail_inbox WHERE username = ? ORDER BY id LIMIT 5').bind(username).all()).results || [];
    return json({ items: rows.map((r) => ({ id: r.id, box: JSON.parse(r.box) })), ...await mailStatus(db, username) });
  }
  if (action === 'ack') {
    const ids = Array.isArray(b.ids) ? b.ids.filter((x) => Number.isInteger(x)).slice(0, 100) : [];
    if (ids.length) await db.prepare(`DELETE FROM mail_inbox WHERE username = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(username, ...ids).run();
    return json(null, 204);
  }
  if (action === 'remove') {
    if (watch) { const tok = await openToken(env, username, watch.token_enc).catch(() => null); if (tok) await google(env, 'revoke', { token: tok }).catch(() => {}); }
    await db.batch([db.prepare('DELETE FROM mail_watch WHERE username = ?').bind(username), db.prepare('DELETE FROM mail_inbox WHERE username = ?').bind(username)]);
    return json(null, 204);
  }
  return err(404, 'not_found');
}

async function mailStatus(db, username) {
  const w = await db.prepare('SELECT last_check, problem, connected_at FROM mail_watch WHERE username = ?').bind(username).first();
  const n = await db.prepare('SELECT COUNT(*) AS n FROM mail_inbox WHERE username = ?').bind(username).first();
  return { connected: !!w, lastCheck: w?.last_check || null, problem: w?.problem || null, waiting: n?.n || 0 };
}

// The Google sign-in, encrypted at rest with a key only the Worker has (from GOOGLE_CLIENT_SECRET), and bound
// to the username, so the database alone is no use to anyone.
async function tokenKey(env) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(env.GOOGLE_CLIENT_SECRET)), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('money/mail-token/v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const b64e = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sealToken(env, username, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(username) }, await tokenKey(env), enc.encode(token)));
  return `${b64e(iv)}.${b64e(ct)}`;
}
async function openToken(env, username, sealed) {
  const [iv, ct] = String(sealed).split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(iv), additionalData: enc.encode(username) }, await tokenKey(env), b64d(ct)));
}

/** A P-256 public key (JWK) from the app: only its own key pair's devices can open what's sealed to it. */
const validPublicKey = (k) => !!k && typeof k === 'object' && k.kty === 'EC' && k.crv === 'P-256' && !('d' in k)
  && /^[A-Za-z0-9_-]{43}$/.test(k.x || '') && /^[A-Za-z0-9_-]{43}$/.test(k.y || '');

/** Seal JSON to the account's public key: ECDH (P-256, a fresh key each time) → HKDF → AES-GCM. */
async function sealBox(pubJwk, data) {
  const pub = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: pubJwk.x, y: pubJwk.y }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('money/mail-box/v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data))));
  const epk = await crypto.subtle.exportKey('jwk', eph.publicKey);
  return { v: 1, epk: { x: epk.x, y: epk.y }, iv: b64e(iv), ct: b64e(ct) };
}

const gmailBase = (env) => (googleBase(env) ? `${googleBase(env)}/gmail/v1/users/me` : 'https://gmail.googleapis.com/gmail/v1/users/me');
async function gmail(env, token, path) {
  let res;
  try { res = await fetch(`${gmailBase(env)}/${path}`, { headers: { Authorization: `Bearer ${token}` } }); } catch { throw Object.assign(new Error('mail_unreachable'), { status: 502 }); }
  if (res.status === 403) throw Object.assign(new Error('mail_forbidden'), { status: 502 });
  if (!res.ok) throw Object.assign(new Error('mail_error'), { status: 502, extra: { google: String(res.status) } });
  return res.json();
}

/**
 * The Gmail search: words money alerts use (Gmail ORs the words in braces), since the last check (or the last
 * 60 days the first time), leaving out the Promotions and Social tabs.
 */
export function alertQuery(since) {
  const words = '{transaction purchase purchased spent charged charge withdrawal withdrawn deposit deposited refund refunded debited credited "e-transfer" etransfer "sent you" "you sent" "you paid" "payment received" alert}';
  const s = since ? Date.parse(since) : NaN;
  const when = Number.isFinite(s) ? `after:${Math.floor(s / 1000) - 2 * 86400}` : 'newer_than:60d';
  return `${words} ${when} -category:promotions -category:social`;
}

/** Only what reading an alert needs: sender, subject, date and the text parts (no attachments). */
function prune(msg) {
  const keep = new Set(['from', 'subject', 'date', 'content-type', 'message-id']);
  const part = (p, depth) => {
    if (!p || depth > 8) return null;
    const out = { mimeType: p.mimeType || '', headers: (p.headers || []).filter((h) => keep.has(String(h.name).toLowerCase())) };
    if (p.parts?.length) { out.parts = p.parts.map((x) => part(x, depth + 1)).filter(Boolean); return out; }
    if (p.filename || !/^text\/(plain|html)/i.test(p.mimeType || '')) return depth ? null : out;
    out.body = { data: String(p.body?.data || '').slice(0, 200_000) };
    return out;
  };
  return { id: String(msg.id), internalDate: msg.internalDate || null, payload: part(msg.payload, 0) };
}

const BOX_BYTES = 400_000;
const INBOX_MAX = 300; // boxes waiting for the app; checks pause past this until it collects them
/**
 * Look for new alert emails for one account and seal them for its devices. budget.n: Gmail calls left in this
 * run (Workers allow 50 outside requests per run). Returns { fetched, more }.
 */
export async function checkMail(env, watch, budget) {
  const db = env.DB;
  const started = new Date().toISOString();
  const done = (fields) => db.prepare('UPDATE mail_watch SET last_run = ?, problem = ?, last_check = ?, seen = ? WHERE username = ?')
    .bind(Math.floor(Date.now() / 1000), fields.problem ?? null, fields.lastCheck ?? watch.last_check, fields.seen ?? watch.seen, watch.username).run();
  const waiting = await db.prepare('SELECT COUNT(*) AS n FROM mail_inbox WHERE username = ?').bind(watch.username).first();
  if ((waiting?.n || 0) >= INBOX_MAX) { await done({ problem: watch.problem }); return { fetched: 0, more: false, full: true }; }
  let access;
  try {
    budget.n--;
    access = (await google(env, 'token', { refresh_token: await openToken(env, watch.username, watch.token_enc), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' })).access_token;
  } catch (e) {
    if (e.message === 'mail_reconnect') { await done({ problem: 'login' }); return { fetched: 0, more: false }; }
    throw e;
  }
  let seen;
  try { seen = JSON.parse(watch.seen); } catch { seen = []; }
  const seenSet = new Set(seen);
  const q = encodeURIComponent(alertQuery(watch.last_check));
  const ids = [];
  let page = '', more = false;
  try {
    for (;;) {
      if (budget.n <= 1) { more = true; break; }
      budget.n--;
      const list = await gmail(env, access, `messages?q=${q}&maxResults=100${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      for (const m of list.messages || []) if (!seenSet.has(m.id) && !ids.includes(m.id)) ids.push(m.id);
      if (!list.nextPageToken) break;
      if (ids.length >= budget.n) { more = true; break; }
      page = list.nextPageToken;
    }
  } catch (e) {
    if (e.message === 'mail_forbidden') { await done({ problem: 'forbidden' }); return { fetched: 0, more: false }; }
    throw e;
  }
  const take = ids.slice(0, Math.max(0, budget.n));
  if (take.length < ids.length) more = true;
  budget.n -= take.length;
  // Newest first from Gmail; a few at a time.
  const msgs = [];
  const queue = [...take];
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (queue.length) { const id = queue.shift(); msgs.push(prune(await gmail(env, access, `messages/${encodeURIComponent(id)}?format=full`))); }
  }));
  const pub = JSON.parse(watch.pubkey);
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    await db.prepare('INSERT INTO mail_inbox (username, box, created) VALUES (?, ?, ?)').bind(watch.username, JSON.stringify(await sealBox(pub, batch)), Math.floor(Date.now() / 1000)).run();
    batch = []; size = 0;
  };
  for (const m of msgs) {
    const n = JSON.stringify(m).length;
    if (size + n > BOX_BYTES) await flush();
    batch.push(m); size += n;
  }
  await flush();
  // Remember which emails were handed over (Gmail's ids only), so they're never fetched twice.
  const nextSeen = JSON.stringify([...seen, ...take].slice(-4000));
  await done({ lastCheck: more ? watch.last_check : started, seen: nextSeen });
  return { fetched: take.length, more };
}

/** Every hour (Cron Trigger): check each connected account, least recently checked first. */
export async function runMailChecks(env) {
  if (!env.DB || !mailOn(env)) return;
  await ensureSchema(env.DB);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mail_inbox WHERE created < ?').bind(now - 60 * 86400),
    env.DB.prepare('DELETE FROM mail_handoff WHERE created < ?').bind(now - HANDOFF_TTL),
  ]);
  const rows = (await env.DB.prepare('SELECT * FROM mail_watch ORDER BY last_run LIMIT 20').all()).results || [];
  const budget = { n: 45 };
  for (const w of rows) {
    if (budget.n < 4) break;
    if (w.problem === 'login') continue;
    try { await checkMail(env, w, budget); } catch { /* one account's trouble doesn't stop the others */ }
  }
}

export async function handleApi(req, env, url) {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, '');
  const on = !!(db && env.INVITE_CODE);
  if (path === '/api/v1/status' && req.method === 'GET') return json({ configured: on, bank: on && bankOn(env), mail: on && mailOn(env) });
  if (path === '/api/v1/mail/callback' && req.method === 'GET') return mailCallback(req, env, url);
  if (!db || !env.INVITE_CODE) return err(503, 'not_configured');
  await ensureSchema(db);

  // Create an account
  if (path === '/api/v1/accounts' && req.method === 'POST') {
    const b = await body(req);
    if (!safeEqual(String(b.invite || '').trim(), String(env.INVITE_CODE).trim())) return err(403, 'bad_invite');
    const username = String(b.username || '').toLowerCase();
    if (!USER_RE.test(username)) return err(400, 'bad_username');
    if (!validKdf(b.kdf) || !validHash(b.authHash) || !validEnvelope(b.envelope) || b.envelope.kdf.salt !== b.kdf.salt) return err(400, 'bad_request');
    if (b.recovery != null && !validRecovery(b.recovery)) return err(400, 'bad_request');
    const now = new Date().toISOString();
    // One batch: the account and its recovery blob are written together or not at all.
    const [res] = await db.batch([
      db.prepare('INSERT OR IGNORE INTO accounts (username, salt, iterations, auth_hash, envelope, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(username, b.kdf.salt, b.kdf.iterations, b.authHash, JSON.stringify(b.envelope), b.envelope.rev, now, now),
      b.recovery
        ? db.prepare('INSERT OR REPLACE INTO recovery (username, blob, updated_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE username = ? AND auth_hash = ? AND created_at = ?)')
          .bind(username, JSON.stringify(b.recovery), now, username, b.authHash, now)
        : db.prepare('SELECT 1'),
    ]);
    if (!res?.meta || res.meta.changes !== 1) return err(409, 'username_taken');
    return json({ username, rev: b.envelope.rev }, 201);
  }

  const m = /^\/api\/v1\/accounts\/([^/]+)(\/kdf|\/vault|\/recovery|\/bank\/(?:link|finish|sync|remove)|\/mail\/(?:link|finish|check|inbox|ack|remove))?$/.exec(path);
  if (!m) return err(404, 'not_found');
  let username;
  try { username = decodeURIComponent(m[1]).toLowerCase(); } catch { return err(400, 'bad_username'); }
  if (!USER_RE.test(username)) return err(400, 'bad_username');
  const sub = m[2] || '';

  if (sub === '/kdf' && req.method === 'GET') {
    const row = await db.prepare('SELECT salt, iterations FROM accounts WHERE username = ?').bind(username).first();
    return json(row ? { salt: row.salt, iterations: row.iterations } : await fakeKdf(env, username));
  }
  if (sub === '/recovery' && req.method === 'GET') {
    const row = await db.prepare('SELECT blob FROM recovery WHERE username = ?').bind(username).first();
    return json({ recovery: row ? JSON.parse(row.blob) : await fakeRecovery(env, username) });
  }

  const auth = await authorize(req, db, username);
  if (auth.error) return auth.error;
  const row = auth.row;

  if (sub === '/vault' && req.method === 'GET') return json({ envelope: JSON.parse(row.envelope), rev: row.rev });
  if (sub.startsWith('/bank/') && req.method === 'POST') return bankRoute(sub.slice(6), req, env, url, username);
  if (sub.startsWith('/mail/') && req.method === 'POST') return mailRoute(sub.slice(6), req, env, url, username);

  if (sub === '/vault' && req.method === 'PUT') {
    const b = await body(req);
    if (!validEnvelope(b.envelope)) return err(400, 'bad_request');
    if (b.recovery != null && !validRecovery(b.recovery)) return err(400, 'bad_request');
    const changingKey = b.envelope.kdf.salt !== row.salt;
    if (changingKey && (!validKdf(b.kdf) || !validHash(b.authHash) || b.kdf.salt !== b.envelope.kdf.salt)) return err(400, 'new_key_needs_kdf');
    const kdf = changingKey ? b.kdf : { salt: row.salt, iterations: row.iterations };
    const authHash = changingKey ? b.authHash : row.auth_hash;
    const now = new Date().toISOString();
    // Compare-and-swap on rev, and on the key this request was authorised with: a slow request made
    // with the old passphrase can't undo a passphrase change that landed in between. A forced write
    // must still move the revision forward, so other devices pick it up.
    const stmt = b.force
      ? db.prepare('UPDATE accounts SET envelope = ?, rev = ?, salt = ?, iterations = ?, auth_hash = ?, updated_at = ? WHERE username = ? AND auth_hash = ? AND rev < ?')
        .bind(JSON.stringify(b.envelope), b.envelope.rev, kdf.salt, kdf.iterations, authHash, now, username, row.auth_hash, b.envelope.rev)
      : db.prepare('UPDATE accounts SET envelope = ?, rev = ?, salt = ?, iterations = ?, auth_hash = ?, updated_at = ? WHERE username = ? AND auth_hash = ? AND rev = ?')
        .bind(JSON.stringify(b.envelope), b.envelope.rev, kdf.salt, kdf.iterations, authHash, now, username, row.auth_hash, Number(b.baseRev));
    // The recovery blob changes in the same batch, and only if the vault write above went through.
    const applied = 'EXISTS (SELECT 1 FROM accounts WHERE username = ? AND rev = ? AND auth_hash = ? AND updated_at = ?)';
    const recoveryStmt = 'recovery' in b && b.recovery
      ? db.prepare(`INSERT OR REPLACE INTO recovery (username, blob, updated_at) SELECT ?, ?, ? WHERE ${applied}`).bind(username, JSON.stringify(b.recovery), now, username, b.envelope.rev, authHash, now)
      : ('recovery' in b || changingKey)
        ? db.prepare(`DELETE FROM recovery WHERE username = ? AND ${applied}`).bind(username, username, b.envelope.rev, authHash, now)
        : db.prepare('SELECT 1');
    const [res] = await db.batch([stmt, recoveryStmt]);
    if (!res?.meta || res.meta.changes !== 1) {
      const cur = await db.prepare('SELECT rev FROM accounts WHERE username = ?').bind(username).first();
      return err(409, 'conflict', { rev: cur?.rev });
    }
    return json({ rev: b.envelope.rev, updatedAt: now });
  }

  if (sub === '/recovery' && req.method === 'PUT') {
    const b = await body(req);
    if (b.recovery != null && !validRecovery(b.recovery)) return err(400, 'bad_request');
    await setRecovery(db, username, b.recovery || null, new Date().toISOString()).run();
    return json(null, 204);
  }

  if (sub === '' && req.method === 'DELETE') {
    await db.batch([
      db.prepare('DELETE FROM accounts WHERE username = ?').bind(username),
      db.prepare("DELETE FROM failures WHERE username LIKE ? ESCAPE '\\'").bind(`${username.replace(/[%_\\]/g, '\\$&')}|%`),
      db.prepare('DELETE FROM recovery WHERE username = ?').bind(username),
      db.prepare('DELETE FROM mail_handoff WHERE username = ?').bind(username),
      db.prepare('DELETE FROM mail_watch WHERE username = ?').bind(username),
      db.prepare('DELETE FROM mail_inbox WHERE username = ?').bind(username),
    ]);
    return json(null, 204);
  }
  return err(405, 'method_not_allowed');
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMailChecks(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    // Same-origin only: reject cross-site writes outright.
    const origin = req.headers.get('Origin');
    if (req.method !== 'GET' && origin && origin !== url.origin) return err(403, 'bad_origin');
    try {
      return await handleApi(req, env, url);
    } catch (e) {
      return err(e.status || 500, e.status ? e.message : 'server_error', e.extra || {});
    }
  },
};
