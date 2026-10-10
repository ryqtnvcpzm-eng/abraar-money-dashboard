// Reading bank alert emails from Gmail, in the browser. The app asks Gmail itself (read-only), so no
// email passes through the sync server; only the parsed date, amount and merchant are kept, in the vault.
import { fromGmail, parseAlert, mailKey } from './email-parse.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE pair for Google sign-in: the verifier stays in this tab, Google gets the challenge. */
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/**
 * The Gmail search: words money alerts use (Gmail ORs words in braces), since the last check
 * (or the last 60 days the first time), leaving out the Promotions and Social tabs.
 */
export function alertQuery(since) {
  const words = '{transaction purchase purchased spent charged charge withdrawal withdrawn deposit deposited refund refunded debited credited "e-transfer" etransfer "sent you" "you sent" "you paid" "payment received" alert}';
  const s = since ? Date.parse(since) : NaN;
  const when = Number.isFinite(s) ? `after:${Math.floor(s / 1000) - 2 * 86400}` : 'newer_than:60d';
  return `${words} ${when} -category:promotions -category:social`;
}

export class GmailError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

async function get(token, path) {
  let res;
  try {
    res = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch { throw new GmailError('offline', 0); }
  if (res.status === 401) throw new GmailError('expired', 401);
  if (res.status === 403) throw new GmailError('forbidden', 403); // Gmail API not switched on, or no permission
  if (res.status === 429) throw new GmailError('busy', 429);
  if (!res.ok) throw new GmailError('gmail_error', res.status);
  return res.json();
}

/** Gmail's message id → the key Money remembers it by. */
export const gmailKey = (id) => mailKey({ id: `gmail:${id}` });

/**
 * Find and read new alert emails. seen: keys already handled. Returns { parsed: [parseAlert results], scanned, more }
 * (more: there were more than `max` new ones; ask again and the next batch comes, since these are now seen).
 * onProgress(done, total) while reading.
 */
export async function readAlerts(token, { since = null, seen = new Set(), max = 250, today, onProgress } = {}) {
  const q = encodeURIComponent(alertQuery(since));
  const ids = [];
  let page = '';
  let more = false;
  for (let pages = 0; ; pages++) {
    const list = await get(token, `messages?q=${q}&maxResults=100${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    for (const m of list.messages || []) if (!seen.has(gmailKey(m.id))) ids.push(m.id);
    if (!list.nextPageToken) break;
    if (ids.length >= max || pages >= 40) { more = true; break; }
    page = list.nextPageToken;
  }
  if (ids.length > max) more = true;
  const todo = ids.slice(0, max);
  const parsed = [];
  let done = 0;
  // A few at a time: quick, and well inside Gmail's limits.
  const worker = async () => {
    while (todo.length) {
      const id = todo.shift();
      const msg = await get(token, `messages/${encodeURIComponent(id)}?format=full`);
      const m = fromGmail(msg);
      parsed.push(parseAlert({ ...m, id: `gmail:${id}` }, today ? { today } : {}));
      done++;
      onProgress?.(done, done + todo.length);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return { parsed, scanned: done, more };
}
