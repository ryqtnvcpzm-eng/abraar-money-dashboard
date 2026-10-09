// Cloud sync client. Talks to worker/index.js on the same origin.
// The server only ever receives ciphertext and SHA-256(auth token); the token itself is derived
// from the passphrase-derived key, so only someone with the passphrase can read or write a vault.
import { b64, unb64, randomBytes, deriveKeyBits, keyFromBits, seal, openWithSession, KDF_ITERATIONS } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const API = 'api/v1';
export const USER_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const normUser = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

export class CloudError extends Error {
  constructor(code, status, extra = {}) { super(code); this.code = code; this.status = status; Object.assign(this, extra); }
}

async function call(method, path, { token, body } = {}) {
  let res;
  try {
    res = await fetch(`${API}/${path}`, {
      method,
      cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new CloudError('offline', 0);
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* not JSON (e.g. the static site answered) */ }
  if (!res.ok || !data) throw new CloudError(data?.error || 'unavailable', res.status, data || {});
  return data;
}

/** Is cloud sync deployed and configured? (false offline or when the API isn't there) */
export async function available() {
  try { return !!(await call('GET', 'status')).configured; } catch { return false; }
}

async function hex(bytes) { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join(''); }

/** Auth token from the raw vault-key bytes: HKDF(key, "money/cloud-auth/v1"). */
export async function tokenFromBits(bits) {
  const base = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
  const out = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('money/cloud-auth/v1') }, base, 256);
  return b64(new Uint8Array(out)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function hashToken(token) { return hex(await subtle.digest('SHA-256', enc.encode(token))); }

/** Derive session + token from a passphrase and KDF params. Wipes the raw bytes. */
export async function deriveAccess(passphrase, salt, iterations) {
  const bits = await deriveKeyBits(passphrase, unb64(salt), iterations);
  try {
    const key = await keyFromBits(bits);
    const token = await tokenFromBits(bits);
    return { session: { key, salt, iterations }, token };
  } finally { bits.fill(0); }
}

/** Sign in on a device that has nothing yet: fetch KDF params, derive, download, decrypt. */
export async function signIn(username, passphrase) {
  const u = normUser(username);
  const kdf = await call('GET', `accounts/${encodeURIComponent(u)}/kdf`);
  const { session, token } = await deriveAccess(passphrase, kdf.salt, kdf.iterations);
  let res;
  try { res = await call('GET', `accounts/${encodeURIComponent(u)}/vault`, { token }); } catch (e) {
    if (e.status === 401) throw new CloudError('wrong_credentials', 401);
    throw e;
  }
  const data = await openWithSession(res.envelope, session);
  return { username: u, session, token, env: res.envelope, vault: data };
}

/** Create a brand-new account with a fresh vault. */
export async function createAccount({ invite, username, passphrase, vault }) {
  const u = normUser(username);
  if (!USER_RE.test(u)) throw new CloudError('bad_username', 400);
  const salt = b64(randomBytes(16));
  const { session, token } = await deriveAccess(passphrase, salt, KDF_ITERATIONS);
  vault.sync = { mode: 'cloud', username: u, token };
  const env = await seal(session, vault, 1);
  await call('POST', 'accounts', { body: { invite, username: u, kdf: { salt, iterations: KDF_ITERATIONS }, authHash: await hashToken(token), envelope: env } });
  return { username: u, session, token, env };
}

/** Move an existing (repo / device) vault into a new cloud account. Needs the passphrase once. */
export async function adoptVault({ invite, username, passphrase, env, vault }) {
  const u = normUser(username);
  if (!USER_RE.test(u)) throw new CloudError('bad_username', 400);
  const { session, token } = await deriveAccess(passphrase, env.kdf.salt, env.kdf.iterations);
  await openWithSession(env, session); // throws WRONG_PASSPHRASE if it doesn't match
  vault.sync = { mode: 'cloud', username: u, token };
  const next = await seal(session, vault, (env.rev || 0) + 1);
  await call('POST', 'accounts', { body: { invite, username: u, kdf: { salt: env.kdf.salt, iterations: env.kdf.iterations }, authHash: await hashToken(token), envelope: next } });
  return { username: u, session, token, env: next };
}

export async function pull(username, token) {
  return call('GET', `accounts/${encodeURIComponent(username)}/vault`, { token });
}

/** Upload a new envelope. Throws CloudError('conflict') when another device saved first. */
export async function push(username, token, env, baseRev, { force = false, newToken = null } = {}) {
  const body = { envelope: env, baseRev, force };
  if (newToken) Object.assign(body, { kdf: { salt: env.kdf.salt, iterations: env.kdf.iterations }, authHash: await hashToken(newToken) });
  return call('PUT', `accounts/${encodeURIComponent(username)}/vault`, { token, body });
}

export async function deleteAccount(username, token) {
  return call('DELETE', `accounts/${encodeURIComponent(username)}`, { token });
}
