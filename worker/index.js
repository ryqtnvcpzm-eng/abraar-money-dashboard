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
//
// Bank sync (optional, Plaid): the browser keeps the Plaid access token inside its encrypted vault and
// sends it with each sync. The Worker adds the Plaid secret, relays the call and keeps nothing:
// transactions pass through in memory only. Account numbers (even Plaid's last-4 "mask") are dropped.
//
// Recovery: the browser can wrap the vault key with a random recovery key the owner saves
// (AES-GCM, key from HKDF of the recovery key). The server only stores that wrapped blob, which is
// useless without the recovery key, so it can hand it to anyone who asks.
//
// Bindings: DB (D1). Secret: INVITE_CODE (needed to create accounts).
// Optional, for bank sync: PLAID_CLIENT_ID, PLAID_SECRET (secret), PLAID_ENV ("production" or "sandbox"),
// PLAID_COUNTRIES (default "CA,US").

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

export async function handleApi(req, env, url) {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/api/v1/status' && req.method === 'GET') return json({ configured: !!(db && env.INVITE_CODE), bank: !!(db && env.INVITE_CODE) && bankOn(env) });
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

  const m = /^\/api\/v1\/accounts\/([^/]+)(\/kdf|\/vault|\/recovery|\/bank\/(?:link|finish|sync|remove))?$/.exec(path);
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
    ]);
    return json(null, 204);
  }
  return err(405, 'method_not_allowed');
}

export default {
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
