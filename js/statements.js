// One entry point for every kind of statement file. Everything runs on this device.
//
//   readStatementFile({ name, bytes }, { pdfjs, options })  →  { kind, statements: [parsed…], pages? }
//
// PDFs: CIBC statements go through the exact CIBC reader; anything else (or a CIBC file it can't
// reconcile) goes through the general reader in generic-parser.js.
// CSV / OFX / QFX / QIF exports can span several months, so they're split into one statement per month.
import { pdfToPages } from './pdf-text.js';
import { parseCibcStatement, reconcile } from './cibc-parser.js';
import { parseGenericStatement } from './generic-parser.js';
import { decodeText, sniff, parseCsv, parseOfx, parseQif } from './file-formats.js';
import { daysInMonth } from './format.js';

const round2 = (n) => Math.round(n * 100) / 100;
export const ACCEPT = 'application/pdf,.pdf,.csv,.tsv,.txt,.ofx,.qfx,.qif,text/csv,text/plain,application/x-ofx,application/vnd.intu.qfx';
export const isStatementFile = (f) => /\.(pdf|csv|tsv|txt|ofx|qfx|qif)$/i.test(f.name) || /pdf|csv|ofx|qfx|text\/plain/i.test(f.type || '');

export class StatementError extends Error {}

/** Read PDF pages once, so the importer can re-run the parser with different options cheaply. */
export async function loadFile({ name, bytes }, { pdfjs } = {}) {
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  if (isPdf || /\.pdf$/i.test(name)) {
    if (!pdfjs) throw new StatementError('Couldn’t load the PDF reader. Connect to the internet once so it can be cached.');
    let pages;
    try { pages = await pdfToPages(pdfjs, bytes); } catch (e) {
      if (e?.name === 'PasswordException') throw new StatementError('This PDF is password-protected. Open it once and save an unprotected copy.');
      throw new StatementError('Couldn’t read this PDF.');
    }
    const chars = pages.reduce((s, p) => s + p.reduce((k, it) => k + it.str.trim().length, 0), 0);
    if (chars < 40) throw new StatementError('This PDF is a scanned image with no text to read. Download the statement from online banking as a PDF, CSV or OFX instead.');
    return { kind: 'pdf', name, pages };
  }
  const text = decodeText(bytes);
  return { kind: sniff(name, text), name, text };
}

/** Parse a loaded file. options: { dateOrder: 'dmy'|'mdy', flip: boolean } */
export function parseLoaded(file, options = {}) {
  if (file.kind === 'pdf') return [parsePdfPages(file.pages, options)];
  const res = file.kind === 'ofx' ? parseOfx(file.text, options) : file.kind === 'qif' ? parseQif(file.text, options) : parseCsv(file.text, options);
  if (!res.transactions.length) throw new StatementError('No transactions found in this file.');
  return splitMonths(res);
}

export async function readStatementFile(input, { pdfjs, options } = {}) {
  const file = await loadFile(input, { pdfjs });
  return { ...file, statements: parseLoaded(file, options) };
}

function parsePdfPages(pages, options) {
  const text = pages.map((p) => p.map((i) => i.str).join(' ')).join(' ');
  const looksCibc = /\bCIBC\b/.test(text);
  let cibc = null;
  if (looksCibc && !options.flip && !options.dateOrder) {
    try { cibc = parseCibcStatement(pages); } catch { cibc = null; }
    if (cibc?.period && cibc.transactions.length) {
      cibc.meta = { parser: 'cibc', format: 'pdf', bank: 'CIBC', currency: 'CAD', dateOrderCertain: true, signSource: 'columns' };
      if (reconcile(cibc).ok) return cibc;
    }
  }
  const gen = parseGenericStatement(pages, options);
  markUnverified(gen);
  if (cibc?.period && cibc.transactions.length) {
    // Both tried: keep whichever reconciles (the CIBC one when neither does — it knows the layout).
    return reconcile(gen).ok ? gen : cibc;
  }
  if (!gen.transactions.length) throw new StatementError('Couldn’t find any transactions in this PDF. If your bank offers a CSV or OFX download, try that instead.');
  return gen;
}

/** No balances anywhere means nothing to check against: say "not checked" rather than "doesn't match". */
function markUnverified(st) {
  const anyBalance = st.opening != null || st.closing != null || st.transactions.some((t) => t.balance != null);
  if (!anyBalance && st.summaryTotals?.withdrawals == null && st.summaryTotals?.deposits == null) st.meta.unverified = true;
}

/** Split an export into calendar months, with balances where the file has them. */
function splitMonths(res) {
  const { transactions: all, meta } = res;
  const byMonth = new Map();
  for (const t of all) {
    const ym = t.date.slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(t);
  }
  const months = [...byMonth.keys()].sort();
  const fileStart = res.range?.start && res.range.start <= all[0].date ? res.range.start : all[0].date;
  const fileEnd = res.range?.end && res.range.end >= all[all.length - 1].date ? res.range.end : all[all.length - 1].date;

  // Closing balance per month.
  const closings = new Map();
  const openings = new Map();
  const hasBal = all.some((t) => t.balance != null);
  if (hasBal) {
    for (const ym of months) {
      const list = byMonth.get(ym);
      const firstB = list.findIndex((t) => t.balance != null);
      const lastB = list.length - 1 - [...list].reverse().findIndex((t) => t.balance != null);
      if (firstB >= 0) {
        openings.set(ym, round2(list[firstB].balance - list.slice(0, firstB + 1).reduce((s, t) => s + t.amount, 0)));
        closings.set(ym, round2(list[lastB].balance + list.slice(lastB + 1).reduce((s, t) => s + t.amount, 0)));
      }
    }
  } else if (res.closing != null && Number.isFinite(res.closing)) {
    // OFX: walk back from the ledger balance at the end of the file.
    let close = res.closing;
    const after = res.closingDate ? all.filter((t) => t.date > res.closingDate).reduce((s, t) => s + t.amount, 0) : 0;
    close = round2(close + after);
    for (const ym of [...months].reverse()) {
      const sum = byMonth.get(ym).reduce((s, t) => s + t.amount, 0);
      closings.set(ym, close);
      openings.set(ym, round2(close - sum));
      close = round2(close - sum);
    }
  }

  return months.map((ym) => {
    const list = byMonth.get(ym);
    const monthStart = `${ym}-01`, monthEnd = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
    const start = fileStart > monthStart ? fileStart : monthStart;
    const end = fileEnd < monthEnd ? fileEnd : monthEnd;
    const issues = (res.balanceIssues || []).filter((b) => b.date.slice(0, 7) === ym);
    return {
      period: { start, end },
      opening: openings.get(ym) ?? null,
      closing: closings.get(ym) ?? null,
      summaryTotals: { withdrawals: null, deposits: null },
      transactions: list.map((t) => ({ date: t.date, description: t.description, amount: t.amount, balance: t.balance ?? null })),
      balanceIssues: issues,
      warnings: res.warnings,
      meta: { ...meta, partial: start !== monthStart || end !== monthEnd, unverified: !hasBal, derivedBalances: !hasBal && openings.has(ym) },
    };
  });
}

/** One line for the importer card: what kind of file it was and how it was read. */
export function describeSource(meta = {}) {
  const fmt = { pdf: 'PDF', csv: 'CSV', ofx: 'OFX', qif: 'QIF' }[meta.format] || 'File';
  if (meta.parser === 'cibc') return 'CIBC statement';
  if (meta.format === 'pdf') return meta.card ? 'Credit card statement' : 'Bank statement';
  return `${fmt} export${meta.card ? ' · credit card' : ''}`;
}
