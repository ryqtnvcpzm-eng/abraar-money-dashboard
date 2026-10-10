// Transactions from bank alert emails. Pure functions over the vault, shared with the tests.
//
// Like bank sync, alerts only fill the days after the last statement you added: a statement (or the
// bank feed) for those days replaces them. Each email is remembered by a short hash so it's never read
// in twice. Nothing from the email itself is kept beyond the date, amount, a cleaned merchant name and
// which bank sent it.
import { sanitizeDescription } from './categorize.js';
import { monthOf, iso } from './format.js';
import { lastFileDay, syncStatements, sameTxn, isMail, absorbAlert } from './bank.js';

export { sameTxn, isMail, absorbAlert };
import { KIND_NAMES, sourceOf } from './email-parse.js';

const SEEN_MAX = 5000;
const PENDING_MAX = 1000;

export function mailState(vault) {
  vault.mail ||= {};
  const m = vault.mail;
  m.seen ||= [];
  m.sources ||= {}; // "CIBC · Credit card" -> true (add these) | false (ignore these)
  m.pending ||= [];
  return m;
}

const HINTS = { transfer: (p) => (p.amount < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN'), payment: (p) => (p.amount > 0 && p.account === 'card' ? 'LOAN_PAYMENTS_CREDIT_CARD' : null) };

/** One parsed alert → a vault transaction (money out negative). */
export function fromAlert(p) {
  const hint = HINTS[p.kind]?.(p) || null;
  return {
    id: `m-${p.key}`,
    ext: `mail:${p.key}`,
    date: p.date,
    merchant: sanitizeDescription(p.merchant || KIND_NAMES[p.kind] || 'Email alert') || 'Email alert',
    name: '',
    amount: p.amount,
    category: 'other',
    statement: monthOf(p.date),
    ...(hint ? { hint } : {}),
  };
}

/** Only what the review list needs, never the email itself. */
const slim = (p) => ({ key: p.key, date: p.date, amount: p.amount, currency: p.currency || null, merchant: p.merchant || null, kind: p.kind, account: p.account, bank: p.bank || null, confidence: p.confidence });

/**
 * Add these alerts to the vault (mutates it). Returns { added, covered, duplicates }.
 * covered: days a statement file already has. duplicates: already there from a statement, the feed or another alert.
 */
export function addAlerts(vault, alerts, { today = iso(new Date()) } = {}) {
  const mail = mailState(vault);
  const seen = new Set(mail.seen);
  const fileEnd = lastFileDay(vault);
  const counts = { added: 0, covered: 0, duplicates: 0 };
  const done = new Set();
  for (const p of alerts) {
    done.add(p.key);
    if (seen.has(p.key) && !mail.pending.some((x) => x.key === p.key)) continue;
    seen.add(p.key);
    if (fileEnd && p.date <= fileEnd) { counts.covered++; continue; }
    const t = fromAlert(p);
    if (vault.transactions.some((o) => o.ext === t.ext || sameTxn(o, t))) { counts.duplicates++; continue; }
    vault.transactions.push(t);
    counts.added++;
  }
  mail.pending = mail.pending.filter((x) => !done.has(x.key));
  mail.seen = [...seen].slice(-SEEN_MAX);
  if (counts.added) {
    vault.transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    syncStatements(vault, { today });
  }
  return counts;
}

/** Leave these alerts out (and don't ask again). */
export function dismissAlerts(vault, keys) {
  const mail = mailState(vault);
  const drop = new Set(keys);
  mail.pending = mail.pending.filter((x) => !drop.has(x.key));
  mail.seen = [...new Set([...mail.seen, ...drop])].slice(-SEEN_MAX);
}

/**
 * Sort freshly read emails (parseAlert results): ones you've said to add from a source you follow are
 * added straight away when the reading is sure; the rest wait for a quick check. Mutates the vault.
 * Returns { added, waiting, ignored, notAlerts, covered, duplicates }.
 */
export function routeAlerts(vault, parsed, { today = iso(new Date()), currency = null } = {}) {
  const mail = mailState(vault);
  const seen = new Set(mail.seen);
  const waiting = new Set(mail.pending.map((x) => x.key));
  const auto = [];
  const out = { added: 0, waiting: 0, ignored: 0, notAlerts: 0, covered: 0, duplicates: 0 };
  const fileEnd = lastFileDay(vault);
  for (const p of parsed) {
    if (!p || seen.has(p.key) || waiting.has(p.key)) continue;
    if (!p.ok) { seen.add(p.key); out.notAlerts++; continue; }
    const follow = mail.sources[sourceOf(p)];
    if (follow === false) { seen.add(p.key); out.ignored++; continue; }
    if (fileEnd && p.date <= fileEnd) { seen.add(p.key); out.covered++; continue; }
    const foreign = p.currency && currency && p.currency !== currency;
    if (follow === true && p.confidence === 'high' && !foreign) auto.push(p);
    else { mail.pending.push(slim(p)); waiting.add(p.key); out.waiting++; }
  }
  mail.pending.sort((a, b) => (a.date < b.date ? 1 : -1));
  // A very long list keeps the newest; the oldest are let go (and not asked about again).
  for (const p of mail.pending.slice(PENDING_MAX)) seen.add(p.key);
  mail.pending = mail.pending.slice(0, PENDING_MAX);
  mail.seen = [...seen].slice(-SEEN_MAX);
  const r = addAlerts(vault, auto, { today });
  out.added = r.added;
  out.duplicates = r.duplicates;
  out.covered += r.covered;
  return out;
}
