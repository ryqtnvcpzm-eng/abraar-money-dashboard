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

/**
 * Never derive a key with settings weaker than our own: a tampered server could otherwise ask for
 * one iteration and get a token cheap enough to brute-force the passphrase from.
 */
function checkKdf(salt, iterations) {
  let bytes = 0;
  try { bytes = unb64(salt).length; } catch { /* invalid */ }
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000 || bytes < 16 || bytes > 64) throw new CloudError('bad_server_kdf', 0);
}

/** Derive session + token from a passphrase and KDF params. Wipes the raw bytes unless `keepBits`. */
export async function deriveAccess(passphrase, salt, iterations, { keepBits = false } = {}) {
  checkKdf(salt, iterations);
  const bits = await deriveKeyBits(passphrase, unb64(salt), iterations);
  try {
    return { ...(await accessFromBits(bits, salt, iterations)), ...(keepBits ? { bits } : {}) };
  } finally { if (!keepBits) bits.fill(0); }
}
async function accessFromBits(bits, salt, iterations) {
  checkKdf(salt, iterations);
  return { session: { key: await keyFromBits(bits), salt, iterations }, token: await tokenFromBits(bits) };
}

// ---------------------------------------------------------------------------
// Recovery key: a random code the owner saves. It wraps the vault key, so it can reset the passphrase.
// ---------------------------------------------------------------------------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
/** 120 random bits as 24 characters: "K7QM-2D9X-…" (6 groups of 4). */
export function newRecoveryKey() {
  const bytes = randomBytes(15);
  let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{4}/g).join('-');
}
function recoveryBytes(code) {
  const clean = String(code).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  if (clean.length !== 24) throw new CloudError('bad_recovery_key', 400);
  const out = new Uint8Array(15);
  let bits = 0, val = 0, i = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new CloudError('bad_recovery_key', 400);
    val = (val << 5) | v; bits += 5;
    if (bits >= 8) { out[i++] = (val >>> (bits - 8)) & 255; bits -= 8; }
  }
  return out;
}
async function recoveryKey(code, username) {
  const base = await subtle.importKey('raw', recoveryBytes(code), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('money/recovery/v1'), info: enc.encode(username) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** Wrap the raw vault-key bytes with the recovery key. The result is safe to store on the server. */
export async function wrapRecovery(code, username, bits) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(username) }, await recoveryKey(code, username), bits);
  return { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}
async function unwrapRecovery(code, username, blob) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv), additionalData: enc.encode(username) }, await recoveryKey(code, username), unb64(blob.ct)));
  } catch (e) {
    if (e instanceof CloudError) throw e;
    throw new CloudError('wrong_recovery_key', 401);
  }
}

/** Forgot passphrase, with the recovery key: returns what signIn returns, ready for resetPassphrase(). */
export async function recoverWithKey(username, code) {
  const u = normUser(username);
  const { recovery } = await call('GET', `accounts/${encodeURIComponent(u)}/recovery`);
  const bits = await unwrapRecovery(code, u, recovery);
  try {
    return await openWithBits(u, bits);
  } finally { bits.fill(0); }
}

/** Open an account from raw key bytes (recovery key or Face ID): download and decrypt the latest vault. */
export async function openWithBits(username, bits) {
  const u = normUser(username);
  const kdf = await call('GET', `accounts/${encodeURIComponent(u)}/kdf`);
  const { session, token } = await accessFromBits(bits, kdf.salt, kdf.iterations);
  let res;
  try { res = await call('GET', `accounts/${encodeURIComponent(u)}/vault`, { token }); } catch (e) {
    if (e.status === 401) throw new CloudError('wrong_recovery_key', 401);
    throw e;
  }
  const data = await openWithSession(res.envelope, session);
  return { username: u, session, token, env: res.envelope, vault: data };
}

/**
 * Set a new passphrase for an open account (after a reset, or from Settings). Re-encrypts with a
 * fresh salt, keeps the recovery key working, and uploads with the old token in one step.
 */
export async function setPassphrase({ username, oldToken, vault, env, baseRev, passphrase, newRecoveryKey: rotate = false }) {
  const salt = b64(randomBytes(16));
  const access = await deriveAccess(passphrase, salt, KDF_ITERATIONS, { keepBits: true });
  try {
    // Changing the passphrase on purpose also replaces the recovery key: anyone who could open the
    // vault before (and so could read the old key inside it) is locked out too.
    const code = rotate || !vault.recovery?.code ? newRecoveryKey() : vault.recovery.code;
    const recovery = { code, createdAt: code === vault.recovery?.code ? vault.recovery.createdAt : new Date().toISOString() };
    const next = { ...vault, recovery, sync: { ...(vault.sync || {}), mode: 'cloud', username, token: access.token } };
    const nextEnv = await seal(access.session, next, (env.rev || 0) + 1);
    await push(username, oldToken, nextEnv, baseRev, { newToken: access.token, recovery: await wrapRecovery(code, username, access.bits) });
    return { session: access.session, token: access.token, env: nextEnv, vault: next, recoveryKey: code, rotated: code !== vault.recovery?.code };
  } finally { access.bits.fill(0); }
}

/**
 * Turn on (or replace) the recovery key. Needs the raw key bytes, so the caller asks for the passphrase.
 * The new key goes into the vault and its wrapped copy to the server in one compare-and-swap write,
 * so they can never disagree.
 */
export async function enableRecovery({ username, token, bits, vault, env, session, baseRev }) {
  const code = newRecoveryKey();
  const next = { ...vault, recovery: { code, createdAt: new Date().toISOString() } };
  const nextEnv = await seal(session, next, (env.rev || 0) + 1);
  await push(username, token, nextEnv, baseRev, { recovery: await wrapRecovery(code, username, bits) });
  return { code, vault: next, env: nextEnv };
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
  const { session, token, bits } = await deriveAccess(passphrase, salt, KDF_ITERATIONS, { keepBits: true });
  try {
    const code = newRecoveryKey();
    vault.sync = { mode: 'cloud', username: u, token };
    vault.recovery = { code, createdAt: new Date().toISOString() };
    const env = await seal(session, vault, 1);
    const recovery = await wrapRecovery(code, u, bits);
    await call('POST', 'accounts', { body: { invite, username: u, kdf: { salt, iterations: KDF_ITERATIONS }, authHash: await hashToken(token), envelope: env, recovery } });
    return { username: u, session, token, env, recoveryKey: code };
  } finally { bits.fill(0); }
}

/** Move an existing (repo / device) vault into a new cloud account. Needs the passphrase once. */
export async function adoptVault({ invite, username, passphrase, env, vault }) {
  const u = normUser(username);
  if (!USER_RE.test(u)) throw new CloudError('bad_username', 400);
  const { session, token, bits } = await deriveAccess(passphrase, env.kdf.salt, env.kdf.iterations, { keepBits: true });
  try {
    await openWithSession(env, session); // throws WRONG_PASSPHRASE if it doesn't match
    const code = newRecoveryKey();
    vault.sync = { mode: 'cloud', username: u, token };
    vault.recovery = { code, createdAt: new Date().toISOString() };
    const next = await seal(session, vault, (env.rev || 0) + 1);
    const recovery = await wrapRecovery(code, u, bits);
    await call('POST', 'accounts', { body: { invite, username: u, kdf: { salt: env.kdf.salt, iterations: env.kdf.iterations }, authHash: await hashToken(token), envelope: next, recovery } });
    return { username: u, session, token, env: next, recoveryKey: code };
  } finally { bits.fill(0); }
}

export async function pull(username, token) {
  return call('GET', `accounts/${encodeURIComponent(username)}/vault`, { token });
}

/** Upload a new envelope. Throws CloudError('conflict') when another device saved first. */
export async function push(username, token, env, baseRev, { force = false, newToken = null, recovery } = {}) {
  const body = { envelope: env, baseRev, force };
  if (newToken) Object.assign(body, { kdf: { salt: env.kdf.salt, iterations: env.kdf.iterations }, authHash: await hashToken(newToken) });
  if (recovery !== undefined) body.recovery = recovery;
  return call('PUT', `accounts/${encodeURIComponent(username)}/vault`, { token, body });
}

export async function deleteAccount(username, token) {
  return call('DELETE', `accounts/${encodeURIComponent(username)}`, { token });
}

/** What the server offers: { configured, bank, mail }. Never throws. */
export async function serverStatus() {
  try { return await call('GET', 'status'); } catch { return { configured: false, bank: false, mail: false }; }
}

/** Bank sync through the Worker (it adds the Plaid secret and keeps nothing). action: link | finish | sync | remove */
export function bank(username, token, action, body = {}) {
  return call('POST', `accounts/${encodeURIComponent(username)}/bank/${action}`, { token, body });
}

/** Gmail sign-in through the Worker (it adds the Google secret; email never goes through it). action: link | finish | token | remove */
export function mail(username, token, action, body = {}) {
  return call('POST', `accounts/${encodeURIComponent(username)}/mail/${action}`, { token, body });
}
