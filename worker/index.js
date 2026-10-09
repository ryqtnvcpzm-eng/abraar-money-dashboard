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
//
// Recovery: the browser can wrap the vault key with a random recovery key the owner saves
// (AES-GCM, key from HKDF of the recovery key). The server only stores that wrapped blob, which is
// useless without the recovery key, so it can hand it to anyone who asks.
//
// Bindings: DB (D1). Secret: INVITE_CODE (needed to create accounts).

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MAX_ENVELOPE = 1_800_000; // D1 rows top out around 2 MB
const MAX_FAILS = 10; // wrong tokens per account per window
const FAIL_WINDOW = 15 * 60; // seconds
const enc = new TextEncoder();

const json = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: HEADERS });
const err = (status, error, extra = {}) => json({ error, ...extra }, status);

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS accounts (
      username TEXT PRIMARY KEY, salt TEXT NOT NULL, iterations INTEGER NOT NULL, auth_hash TEXT NOT NULL,
      envelope TEXT NOT NULL, rev INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare('CREATE TABLE IF NOT EXISTS failures (username TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS recovery (username TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at TEXT NOT NULL)'),
  ]);
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
  const key = await crypto.subtle.importKey('raw', enc.encode(`money-${label}|${env.INVITE_CODE || 'unset'}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
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

async function authorize(req, db, username) {
  const now = Math.floor(Date.now() / 1000);
  const fail = await db.prepare('SELECT count, window_start FROM failures WHERE username = ?').bind(username).first();
  if (fail && now - fail.window_start < FAIL_WINDOW && fail.count >= MAX_FAILS) return { error: err(429, 'too_many_attempts', { retryAfter: FAIL_WINDOW - (now - fail.window_start) }) };
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const row = await db.prepare('SELECT * FROM accounts WHERE username = ?').bind(username).first();
  if (row && token && safeEqual(await sha256hex(token), row.auth_hash)) {
    if (fail) await db.prepare('DELETE FROM failures WHERE username = ?').bind(username).run();
    return { row };
  }
  // Count failures per username (whether or not it exists, so behaviour is the same).
  if (!fail || now - fail.window_start >= FAIL_WINDOW) await db.prepare('INSERT OR REPLACE INTO failures (username, count, window_start) VALUES (?, 1, ?)').bind(username, now).run();
  else await db.prepare('UPDATE failures SET count = count + 1 WHERE username = ?').bind(username).run();
  return { error: err(401, 'unauthorized') };
}

export async function handleApi(req, env, url) {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/api/v1/status' && req.method === 'GET') return json({ configured: !!(db && env.INVITE_CODE) });
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
    const res = await db.prepare('INSERT OR IGNORE INTO accounts (username, salt, iterations, auth_hash, envelope, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(username, b.kdf.salt, b.kdf.iterations, b.authHash, JSON.stringify(b.envelope), b.envelope.rev, now, now).run();
    if (!res.meta || res.meta.changes !== 1) return err(409, 'username_taken');
    await setRecovery(db, username, b.recovery || null, now).run();
    return json({ username, rev: b.envelope.rev }, 201);
  }

  const m = /^\/api\/v1\/accounts\/([^/]+)(\/kdf|\/vault|\/recovery)?$/.exec(path);
  if (!m) return err(404, 'not_found');
  const username = decodeURIComponent(m[1]).toLowerCase();
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

  if (sub === '/vault' && req.method === 'PUT') {
    const b = await body(req);
    if (!validEnvelope(b.envelope)) return err(400, 'bad_request');
    if (b.recovery != null && !validRecovery(b.recovery)) return err(400, 'bad_request');
    const changingKey = b.envelope.kdf.salt !== row.salt;
    if (changingKey && (!validKdf(b.kdf) || !validHash(b.authHash) || b.kdf.salt !== b.envelope.kdf.salt)) return err(400, 'new_key_needs_kdf');
    const kdf = changingKey ? b.kdf : { salt: row.salt, iterations: row.iterations };
    const authHash = changingKey ? b.authHash : row.auth_hash;
    const now = new Date().toISOString();
    // Compare-and-swap on rev: refuses to overwrite a newer save from another device.
    const stmt = b.force
      ? db.prepare('UPDATE accounts SET envelope = ?, rev = ?, salt = ?, iterations = ?, auth_hash = ?, updated_at = ? WHERE username = ?')
        .bind(JSON.stringify(b.envelope), b.envelope.rev, kdf.salt, kdf.iterations, authHash, now, username)
      : db.prepare('UPDATE accounts SET envelope = ?, rev = ?, salt = ?, iterations = ?, auth_hash = ?, updated_at = ? WHERE username = ? AND rev = ?')
        .bind(JSON.stringify(b.envelope), b.envelope.rev, kdf.salt, kdf.iterations, authHash, now, username, Number(b.baseRev));
    const res = await stmt.run();
    if (!res.meta || res.meta.changes !== 1) {
      const cur = await db.prepare('SELECT rev FROM accounts WHERE username = ?').bind(username).first();
      return err(409, 'conflict', { rev: cur?.rev });
    }
    // A new key makes the old recovery blob useless (it wraps the old key): replace or drop it.
    if ('recovery' in b) await setRecovery(db, username, b.recovery, now).run();
    else if (changingKey) await setRecovery(db, username, null, now).run();
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
      db.prepare('DELETE FROM failures WHERE username = ?').bind(username),
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
      return err(e.status || 500, e.status ? e.message : 'server_error');
    }
  },
};
