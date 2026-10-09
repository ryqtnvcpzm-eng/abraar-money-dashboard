// Bank sync: turn what the bank feed (Plaid, through the Worker) sends into vault transactions
// and monthly statements. Pure functions, shared with the tests.
//
// Statement files stay the record: synced transactions only fill the days after the last statement
// you added, and a statement added later for those days replaces them (commitImport does that).
// Balances for synced days are worked out back from the balance the bank reports now.
import { sanitizeDescription } from './categorize.js';
import { addDays, daysInMonth, monthOf, nextMonth, toCents, fromCents, iso } from './format.js';

/** The last day covered by a statement you added (PDF, CSV…), or null. */
export function lastFileDay(vault) {
  let end = null;
  for (const s of vault.statements) {
    const fileEnd = s.source === 'sync' ? null : s.fileEnd || s.end;
    if (fileEnd && (!end || fileEnd > end)) end = fileEnd;
  }
  return end;
}

/** What a statement would print: the bank's own text, with the store name the feed adds in front. */
function description(t) {
  const original = (t.original || t.name || '').trim();
  const merchant = (t.merchant || '').trim();
  if (merchant && !original.toUpperCase().includes(merchant.toUpperCase())) return `${merchant} · ${original || merchant}`;
  return original || merchant || 'Unknown';
}

/** One feed transaction → a vault transaction (money out negative, like a statement). */
export function fromFeed(t) {
  return {
    id: `b-${t.id}`,
    ext: t.id,
    date: t.date,
    merchant: sanitizeDescription(description(t)),
    name: '',
    amount: Math.round(-t.amount * 100) / 100, // Plaid: positive = money leaving the account
    category: 'other',
    statement: monthOf(t.date),
    ...(t.pfc ? { hint: t.pfc } : {}),
  };
}

/**
 * Apply one sync result to the vault (mutates it). res: { added, modified, removed, cursor, accounts }.
 * Returns { added, updated, removed, skipped } counts.
 */
export function applyBankSync(vault, res, { today = iso(new Date()) } = {}) {
  const bank = vault.bank;
  const fileEnd = lastFileDay(vault);
  const mine = (t) => !bank.accountId || t.account === bank.accountId;
  const byExt = new Map(vault.transactions.filter((t) => t.ext).map((t) => [t.ext, t]));
  const counts = { added: 0, updated: 0, removed: 0, skipped: 0 };

  const gone = new Set(res.removed || []);
  if (gone.size) {
    const before = vault.transactions.length;
    vault.transactions = vault.transactions.filter((t) => !t.ext || !gone.has(t.ext));
    counts.removed = before - vault.transactions.length;
  }
  for (const t of [...(res.added || []), ...(res.modified || [])]) {
    if (!mine(t) || t.pending || gone.has(t.id)) continue;
    // Days a statement file covers belong to that file.
    if (fileEnd && t.date <= fileEnd) { counts.skipped++; continue; }
    const next = fromFeed(t);
    const old = byExt.get(t.id);
    if (old) {
      // Keep your own changes (category, one-off, splits) on a transaction the bank corrected.
      Object.assign(old, { date: next.date, merchant: next.merchant, amount: next.amount, statement: next.statement, hint: next.hint });
      if (!next.hint) delete old.hint;
      counts.updated++;
    } else {
      vault.transactions.push(next);
      byExt.set(t.id, next);
      counts.added++;
    }
  }
  vault.transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));

  const account = (res.accounts || []).find((a) => a.id === bank.accountId) || null;
  if (account) {
    bank.balance = account.current;
    bank.balanceDate = today;
    if (account.currency && !vault.statements.length && vault.account) vault.account.currency = account.currency;
  }
  if (res.cursor) bank.cursor = res.cursor;
  bank.lastSync = new Date().toISOString();
  syncStatements(vault, { today });
  return counts;
}

/**
 * Monthly statements for the synced days. A month a statement file only partly covers is extended
 * (and remembers where the file ended); later months get a statement of their own, marked as synced.
 */
export function syncStatements(vault, { today = iso(new Date()) } = {}) {
  const synced = vault.transactions.filter((t) => t.ext);
  // Drop synced statements that no longer have anything in them (e.g. a file replaced them).
  vault.statements = vault.statements.filter((s) => s.source !== 'sync' || synced.some((t) => t.statement === s.id));
  if (!synced.length) return;
  const bank = vault.bank || {};
  const credit = bank.type === 'credit';
  // The bank's balance now, as this account sees it (a card's balance owed is money you're down).
  const now = bank.balance == null ? null : toCents(credit ? -bank.balance : bank.balance);
  const asOf = bank.balanceDate && bank.balanceDate >= synced[synced.length - 1].date ? bank.balanceDate : today;
  const fileEnd = lastFileDay(vault);
  // Balance at the end of a day = balance now − everything synced after that day.
  const after = (day) => synced.reduce((s, t) => (t.date > day ? s + toCents(t.amount) : s), 0);
  const balAt = (day) => (now == null ? null : fromCents(now - after(day)));

  const first = monthOf(synced[0].date);
  const last = monthOf(asOf);
  for (let ym = first; ym <= last; ym = nextMonth(ym)) {
    const monthEnd = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
    const end = ym === last ? asOf : monthEnd;
    const inMonth = vault.transactions.filter((t) => t.statement === ym);
    let wd = 0, dep = 0;
    for (const t of inMonth) { if (t.amount < 0) wd -= toCents(t.amount); else dep += toCents(t.amount); }
    const file = vault.statements.find((s) => s.id === ym && s.source !== 'sync');
    if (file) {
      // The file covers the start of this month; the feed carries on from where it stopped.
      if (!(file.fileEnd || file.end) || (file.fileEnd || file.end) >= end) continue;
      file.fileEnd ||= file.end;
      Object.assign(file, { end, closing: balAt(end) ?? file.closing, count: inMonth.length, withdrawals: fromCents(wd), deposits: fromCents(dep), synced: true });
      continue;
    }
    const firstDay = fileEnd && monthOf(fileEnd) === ym ? addDays(fileEnd, 1) : ym === first && !vault.statements.some((s) => s.source !== 'sync') ? synced[0].date : `${ym}-01`;
    const st = {
      id: ym, start: firstDay < `${ym}-01` ? `${ym}-01` : firstDay, end,
      opening: balAt(addDays(firstDay, -1)), closing: balAt(end),
      withdrawals: fromCents(wd), deposits: fromCents(dep), count: inMonth.length,
      reconciled: null, source: 'sync', checks: [], issues: [], importedAt: new Date().toISOString(),
    };
    vault.statements = vault.statements.filter((s) => s.id !== ym).concat(st);
  }
  vault.statements.sort((a, b) => (a.start < b.start ? -1 : 1));
}

/** Accounts a vault can follow: chequing, savings and credit cards (not loans or investments). */
export const followable = (accounts) => (accounts || []).filter((a) => a.type === 'depository' || a.type === 'credit');
