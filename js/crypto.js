// Vault encryption: AES-256-GCM with a key derived from the passphrase (PBKDF2-SHA-256).
// Works in browsers and Node 20+ (both expose WebCrypto as globalThis.crypto).
//
// Envelope (this is the only thing ever written to the repo):
// {
//   "format": "abraar-money-vault", "v": 1, "rev": 7, "savedAt": "2026-10-07T12:00:00.000Z",
//   "kdf":    { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<b64>" },
//   "cipher": { "name": "AES-GCM", "iv": "<b64>" },
//   "ct": "<b64 ciphertext + tag>"
// }
// The header fields are bound to the ciphertext as AES-GCM additional data, so
// editing any of them makes decryption fail.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const FORMAT = 'abraar-money-vault';
export const KDF_ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256

export function b64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Derive a non-extractable AES-GCM key. The passphrase itself is never stored. */
export async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS) {
  const base = await subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * The same key as deriveKey(), but as raw bytes — used only to enrol Face ID / Touch ID,
 * which keeps a biometric-protected copy on the device. Callers must wipe the bytes after use.
 */
export async function deriveKeyBits(passphrase, salt, iterations = KDF_ITERATIONS) {
  const base = await subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
}
/** Import raw key bytes as the (non-extractable) vault key. */
export function keyFromBits(bits) {
  return subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function aad(h) {
  return enc.encode([h.format, h.v, h.rev, h.savedAt, h.kdf.iterations, h.kdf.salt].join('|'));
}

/** A fresh vault session: new salt + derived key. */
export async function createSession(passphrase) {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  return { key, salt: b64(salt), iterations: KDF_ITERATIONS };
}

/** Encrypt the vault object with an existing session. Returns a new envelope. */
export async function seal(session, data, rev) {
  const header = {
    format: FORMAT, v: 1, rev, savedAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: session.iterations, salt: session.salt },
  };
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(header) }, session.key, enc.encode(JSON.stringify(data)));
  return { ...header, cipher: { name: 'AES-GCM', iv: b64(iv) }, ct: b64(ct) };
}

export function isEnvelope(x) {
  return !!x && x.format === FORMAT && x.v === 1 && x.kdf?.salt && x.cipher?.iv && typeof x.ct === 'string';
}

/** Unlock an envelope with a passphrase. Throws Error('WRONG_PASSPHRASE') on a bad passphrase. */
export async function open(envelope, passphrase) {
  if (!isEnvelope(envelope)) throw new Error('NOT_A_VAULT');
  const salt = unb64(envelope.kdf.salt);
  const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);
  const session = { key, salt: envelope.kdf.salt, iterations: envelope.kdf.iterations };
  const data = await openWithSession(envelope, session);
  return { session, data };
}

export async function openWithSession(envelope, session) {
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(envelope.cipher.iv), additionalData: aad(envelope) },
      session.key,
      unb64(envelope.ct),
    );
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error('WRONG_PASSPHRASE');
  }
}

/** Small secrets kept on this device only (e.g. the GitHub token), sealed with the vault key. */
export async function sealString(session, str) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, session.key, enc.encode(str));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function openString(session, box) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, session.key, unb64(box.ct));
  return dec.decode(pt);
}

/** Rough passphrase strength (bits), for the setup hint only. */
export function strength(p) {
  if (!p) return 0;
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/\d/.test(p)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(p)) pool += 33;
  const words = p.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3).length;
  const charBits = p.length * Math.log2(Math.max(pool, 1)) * 0.6; // discount: humans aren't random
  const wordBits = words >= 3 ? words * 11 : 0;
  return Math.round(Math.max(charBits, wordBits));
}
