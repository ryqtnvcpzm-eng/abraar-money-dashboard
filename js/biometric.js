// Face ID / Touch ID unlock with passkeys (WebAuthn + the PRF extension).
//
// Enrolling creates a passkey in iCloud Keychain for this site. Every time Face ID / Touch ID
// approves it, the passkey returns the same 32-byte secret (PRF). That secret encrypts a copy
// of the vault key, which is kept in this browser only. Without the face or finger the copy
// is useless, and the passphrase itself is never stored anywhere.
//
// Needs iOS / iPadOS 18+ or macOS 15+ (Safari, or the home-screen app). Each device enrols
// separately; changing the passphrase turns it off until it's enrolled again.
import { b64, unb64, randomBytes } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
// One enrolment per person: the repo-file vault uses 'money.bio', cloud accounts 'money.bio@<username>'.
const keyFor = (id) => (!id || id === 'legacy' ? 'money.bio' : `money.bio@${id}`);
const PRF_INPUT = enc.encode('abraar-money/biometric-unlock/v1');

const ls = {
  get(id) { try { return JSON.parse(localStorage.getItem(keyFor(id)) || 'null'); } catch { return null; } },
  set(id, v) { try { localStorage.setItem(keyFor(id), JSON.stringify(v)); return true; } catch { return false; } },
  del(id) { try { localStorage.removeItem(keyFor(id)); } catch { /* ignore */ } },
};

/** "Face ID" on iPhone, "Touch ID" on Mac/iPad, a generic name elsewhere. */
export function label() {
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'Face ID';
  if (/Macintosh|iPad/.test(ua)) return 'Touch ID';
  return 'Biometrics';
}

/** Is a built-in biometric authenticator available (and PRF not known to be missing)? */
export async function isSupported() {
  try {
    if (!window.PublicKeyCredential || !window.isSecureContext) return false;
    if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false;
    if (PublicKeyCredential.getClientCapabilities) {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps && caps['extension:prf'] === false) return false;
    }
    return true;
  } catch { return false; }
}

export const enrollment = (id) => ls.get(id);
export const disable = (id) => ls.del(id);

/** Usable for this vault? (A passphrase change gives the vault a new salt and retires the old copy.) */
export function isEnrolledFor(env, id) {
  const e = ls.get(id);
  return !!(e && env && e.salt === env.kdf.salt);
}

async function wrapKey(prfOutput) {
  const base = await subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('money vault key wrap') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function evaluate(credentialId) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: PRF_INPUT } } },
    },
  });
  const out = assertion?.getClientExtensionResults()?.prf?.results?.first;
  if (!out) throw new Error('PRF_UNSUPPORTED');
  return new Uint8Array(out);
}

/**
 * Turn on biometric unlock. `keyBits` are the raw vault-key bytes (from crypto.deriveKeyBits)
 * and `env` the current vault envelope. May show Face ID / Touch ID twice on first setup.
 */
export async function enroll(keyBits, env, who) {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Money' },
      user: { id: randomBytes(16), name: who && who !== 'legacy' ? `Money · ${who}` : 'Money vault', displayName: who && who !== 'legacy' ? `Money · ${who}` : 'Money vault' },
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
      timeout: 60_000,
      extensions: { prf: { eval: { first: PRF_INPUT } } },
    },
  });
  const ext = cred.getClientExtensionResults()?.prf;
  if (!ext || (!ext.enabled && !ext.results)) throw new Error('PRF_UNSUPPORTED');
  const id = new Uint8Array(cred.rawId);
  // Some browsers only return the PRF secret on sign-in, not on creation.
  const out = ext.results?.first ? new Uint8Array(ext.results.first) : await evaluate(id);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(env.kdf.salt) }, await wrapKey(out), keyBits);
  out.fill(0);
  ls.set(who, { v: 1, credentialId: b64(id), iv: b64(iv), ct: b64(ct), salt: env.kdf.salt, createdAt: new Date().toISOString() });
}

/** Ask for Face ID / Touch ID and return the raw vault-key bytes (the caller wipes them). */
export async function unlockBits(env, id) {
  const e = ls.get(id);
  if (!e || e.salt !== env.kdf.salt) throw new Error('NOT_ENROLLED');
  const out = await evaluate(unb64(e.credentialId));
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv), additionalData: enc.encode(e.salt) }, await wrapKey(out), unb64(e.ct)));
  } catch {
    throw new Error('WRAP_INVALID');
  } finally {
    out.fill(0);
  }
}

/** Ask for Face ID / Touch ID and return a vault session { key, salt, iterations }. */
export async function unlock(env, id) {
  const bits = await unlockBits(env, id);
  const key = await subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  bits.fill(0);
  return { key, salt: env.kdf.salt, iterations: env.kdf.iterations };
}
