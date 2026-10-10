// Gmail, browser side. The sync server checks Gmail every hour and seals any alert emails it finds to this
// account's public key; the private key lives only in the encrypted vault, so only your own devices can
// open them. This file makes the key pair, opens what the server sealed, and reads the emails.
import { fromGmail, parseAlert } from './email-parse.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const EC = { name: 'ECDH', namedCurve: 'P-256' };

/** PKCE pair for Google sign-in: the verifier stays in this tab, Google gets the challenge. */
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await subtle.digest('SHA-256', enc.encode(verifier))));
  return { verifier, challenge };
}

/** A new key pair for sealed email. The private half goes into the vault (as JWK). */
export async function newMailKey() {
  const pair = await subtle.generateKey(EC, true, ['deriveBits']);
  const { kty, crv, x, y, d } = await subtle.exportKey('jwk', pair.privateKey);
  return { kty, crv, x, y, d };
}
export const publicOf = (key) => ({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y });

/** Open one sealed box from the server (ECDH with its one-off key → HKDF → AES-GCM). Returns its JSON. */
export async function openBox(key, box) {
  if (box?.v !== 1) throw new Error('bad_box');
  const priv = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, d: key.d }, EC, false, ['deriveBits']);
  const pub = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: box.epk.x, y: box.epk.y }, EC, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const aes = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('money/mail-box/v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, aes, unb64(box.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Gmail messages (as the server passed them on) → parsed alerts. */
export function readMessages(messages, { today } = {}) {
  return messages.map((m) => parseAlert({ ...fromGmail(m), id: `gmail:${m.id}` }, today ? { today } : {}));
}
