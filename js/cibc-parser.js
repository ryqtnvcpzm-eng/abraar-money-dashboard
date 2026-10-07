// CIBC chequing/savings statement parser.
//
// Input is the positioned text pdf.js gives us (one array of items per page):
//   [{ str, x, y, w }]   (PDF user-space units; y grows upwards)
// Output is a plain statement object. This file has no DOM or pdf.js dependency,
// so the browser importer and the Node tools share it.
//
// How it reads a statement:
//   1. Summary  - "For Jan 1 to Jan 31, 2026", "Opening balance on …", "Withdrawals - …",
//                 "Deposits + …", "Closing balance on … = …".
//   2. Table    - finds the "Date | Description | Withdrawals | Deposits | Balance" header on
//                 each page and uses its x-positions to put every amount in the right column.
//   3. Grouping - a transaction can span several lines (type + reference, then the merchant).
//                 Lines are grouped into blocks that each carry exactly one amount.
//   4. Checks   - running balance where CIBC prints it, totals vs the summary, and
//                 opening + deposits − withdrawals = closing.

const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = (s) => MONTH_INDEX[String(s).toLowerCase().slice(0, 3)];

const AMOUNT_RE = /^\(?[-−]?\$?\s?[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?[-−]?(?:\s?(?:CR|DR))?$/;
const DATE_RE = /^([A-Za-z]{3,4})\.?\s*(\d{1,2})$/;

/** Transaction-type words CIBC prints at the start of a transaction. */
export const TYPE_PREFIXES = [
  'INTL VISA DEB RETAIL PURCHASE', 'INTL VISA DEB PURCHASE', 'INTL VISA DEB', 'VISA DEBIT MERCHANDISE RET REV', 'VISA DEBIT MERCHANDISE RETURN',
  'MERCHANDISE RETURN',
  'VISA DEBIT RETAIL PURCHASE', 'VISA DEBIT PURCHASE REVERSAL', 'VISA DEBIT AUTH REVERSAL', 'VISA DEBIT PURCHASE',
  'VISA DEBIT CORRECTION', 'VISA DEBIT REFUND', 'VISA DEBIT', 'RETAIL PURCHASE REVERSAL', 'RETAIL PURCHASE',
  'POINT OF SALE PURCHASE', 'PURCHASE REVERSAL', 'INTERNET BILL PAY', 'INTERNET BILL PAYMENT', 'TELEPHONE BILL PAY',
  'INTERNET BANKING TRANSFER', 'INTERNET TRANSFER', 'MOBILE TRANSFER', 'E-TRANSFER RECLAIM', 'E-TRANSFER STOP',
  'E-TRANSFER', 'INTERAC E-TRANSFER', 'SEND E-TFR', 'RECEIVE E-TFR', 'E-TFR', 'PREAUTHORIZED DEBIT',
  'PRE-AUTHORIZED DEBIT', 'PREAUTHORIZED CREDIT', 'ELECTRONIC FUNDS TRANSFER DEPOSIT', 'ELECTRONIC FUNDS TRANSFER',
  'EFT DEPOSIT', 'EFT CREDIT', 'PAYROLL DEPOSIT', 'PAY DEPOSIT', 'DIRECT DEPOSIT', 'DEPOSIT', 'BRANCH DEPOSIT',
  'BRANCH TRANSACTION', 'ABM WITHDRAWAL', 'ABM DEPOSIT', 'ATM WITHDRAWAL', 'AUTOMATED BANKING MACHINE',
  'SHARED ABM WITHDRAWAL', 'NETWORK TRANSACTION FEE', 'SERVICE CHARGE DISCOUNT', 'SERVICE CHARGE', 'MONTHLY FEE',
  'MONTHLY ACCOUNT FEE', 'FEE REBATE', 'E-TRANSFER FEE', 'NSF FEE', 'OVERDRAFT', 'INTEREST', 'CORRECTION',
  'REVERSAL', 'REFUND', 'CHEQUE', 'MISC PAYMENT', 'BILL PAYMENT', 'WIRE TRANSFER', 'INTERNATIONAL',
  'FOREIGN CURRENCY', 'CREDIT MEMO', 'DEBIT MEMO', 'TRANSFER',
];

export function parseAmount(s) {
  const t = String(s).replace(/\s/g, '');
  const neg = /^\(|[-−]|DR$/i.test(t) && !/CR$/i.test(t);
  const v = Number(t.replace(/CR$|DR$/i, '').replace(/[^\d.]/g, ''));
  return Number.isFinite(v) ? (neg ? -v : v) : NaN;
}
const isAmount = (s) => AMOUNT_RE.test(String(s).trim());
const round2 = (n) => Math.round(n * 100) / 100;

/** Group positioned items into visual lines, then into cells (runs of touching text). */
export function groupLines(items, tol = 2.6) {
  const its = items
    .filter((i) => i && typeof i.str === 'string' && i.str.trim() !== '')
    .map((i) => ({ str: i.str, x: i.x, y: i.y, w: i.w || 0 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of its) {
    let line = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 3; k--) {
      if (Math.abs(lines[k].y - it.y) <= tol) { line = lines[k]; break; }
    }
    if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
    line.items.push(it);
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    const cells = [];
    for (const it of line.items) {
      const last = cells[cells.length - 1];
      const gap = last ? it.x - last.right : Infinity;
      // Touching runs (gap < ~1pt) belong to one cell; a normal word space starts a new one.
      if (last && gap < 1.2 && !(isAmount(last.text.trim()) || isAmount(it.str.trim()))) {
        last.text += it.str;
        last.right = Math.max(last.right, it.x + it.w);
      } else {
        cells.push({ text: it.str, x: it.x, right: it.x + it.w });
      }
    }
    // Split cells that contain several space-separated amounts or a date followed by text.
    line.cells = cells.flatMap(splitCell).filter((c) => c.text.trim() !== '');
    line.text = line.cells.map((c) => c.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
  }
  return lines;
}

function splitCell(c) {
  const parts = c.text.split(/(\s{2,})/);
  if (parts.length === 1) return [{ ...c, text: c.text.trim() }];
  // Approximate x-position of each part from its character offset.
  const out = [];
  let off = 0;
  const per = (c.right - c.x) / Math.max(c.text.length, 1);
  for (const p of parts) {
    if (p.trim()) out.push({ text: p.trim(), x: c.x + off * per, right: c.x + (off + p.length) * per });
    off += p.length;
  }
  return out;
}

function wordCenter(cells, word) {
  const re = new RegExp(word, 'i');
  for (const c of cells) {
    const m = re.exec(c.text);
    if (!m) continue;
    const per = (c.right - c.x) / Math.max(c.text.length, 1);
    if (c.text.trim().length <= word.length + 4) return { center: (c.x + c.right) / 2, left: c.x };
    return { center: c.x + (m.index + m[0].length / 2) * per, left: c.x + m.index * per };
  }
  return null;
}

function headerColumns(line) {
  const t = line.text;
  if (!/\bdate\b/i.test(t) || !/description/i.test(t) || !/(withdrawals|deposits)/i.test(t)) return null;
  const w = wordCenter(line.cells, 'withdrawals');
  const d = wordCenter(line.cells, 'deposits');
  const b = wordCenter(line.cells, 'balance');
  const desc = wordCenter(line.cells, 'description');
  if (!w || !d) return null;
  return { w: w.center, d: d.center, b: b ? b.center : null, desc: desc ? desc.left : null };
}

const FOOTER_RE = /(page\s+\d+\s+(of|de)\s+\d+|continued on next page|suite à la page|trademark|marque de commerce|®|important:|\bcibc\.com\b|free transactions|transaction count|^\s*\*|please check this statement)/i;

/** Parse one statement. `pages` is an array of item arrays. */
export function parseCibcStatement(pages) {
  const pageLines = pages.map((items) => groupLines(items));
  const fullText = pageLines.map((ls) => ls.map((l) => l.text).join('\n')).join('\n');
  const summary = parseSummary(fullText);
  const warnings = [];

  // ---- rows of the transaction table ----
  const rows = [];
  let tableOpening = null;
  let tableClosing = null;
  pageLines.forEach((lines, pageIdx) => {
    let cols = null;
    let inTable = false;
    for (const line of lines) {
      const hc = headerColumns(line);
      if (hc) { cols = hc; inTable = true; continue; }
      if (!inTable || line.y < 36) continue;
      if (FOOTER_RE.test(line.text)) { inTable = false; continue; }
      const row = parseRow(line, cols);
      if (!row) continue;
      if (/^opening balance/i.test(row.desc)) { tableOpening = row.bal ?? row.amounts[0] ?? tableOpening; if (row.date) row.isDateOnly = true; continue; }
      if (/^balance forward|^solde report/i.test(row.desc)) continue;
      if (/^closing balance/i.test(row.desc)) { tableClosing = row.bal ?? row.amounts[0] ?? tableClosing; inTable = false; continue; }
      if (/^transaction details|^account summary|^date\b/i.test(row.desc) && !row.hasAmt) continue;
      row.page = pageIdx + 1;
      rows.push(row);
    }
  });

  const opening = summary.opening ?? tableOpening;
  const closing = summary.closing ?? tableClosing;

  // ---- group rows into transactions ----
  // A transaction can span several lines. CIBC puts the amount either on the first line
  // (type + reference, then merchant underneath) or on the last one. Work out which from the
  // dated rows: when the amount is on the last line, multi-line transactions leave dated rows
  // without an amount.
  const dated = rows.filter((r) => r.date);
  const datedNoAmt = dated.filter((r) => !r.hasAmt).length;
  const amountLast = dated.length > 0 && datedNoAmt / dated.length > 0.1;
  const blocks = [];
  let cur = null;
  const startBlock = (row) => ({ rows: [row], date: row.date, w: row.w, d: row.d, bal: row.bal, unknown: row.unknown, page: row.page });
  const hasAmt = (b) => b.w != null || b.d != null || b.unknown != null;
  for (const row of rows) {
    if (amountLast) {
      if (!cur) cur = startBlock(row);
      else if (row.date && !hasAmt(cur) && cur.rows.length && cur.date) { blocks.push(cur); cur = startBlock(row); }
      else {
        cur.rows.push(row);
        if (row.date && !cur.date) cur.date = row.date;
        if (row.hasAmt) { cur.w = row.w; cur.d = row.d; cur.unknown = row.unknown; }
        if (row.bal != null) cur.bal = row.bal;
      }
      if (row.hasAmt) { blocks.push(cur); cur = null; }
    } else if (row.hasAmt || row.date || !cur) {
      if (cur) blocks.push(cur);
      cur = startBlock(row);
    } else {
      cur.rows.push(row);
      if (row.bal != null) cur.bal = row.bal;
    }
  }
  if (cur) blocks.push(cur);

  // ---- dates, signs, running balance ----
  const period = summary.period;
  const txns = [];
  let lastDate = period ? period.start : null;
  let running = opening;
  const balanceIssues = [];
  for (const b of blocks) {
    const desc = b.rows.map((r) => r.desc).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (b.w == null && b.d == null && b.unknown == null) {
      if (desc && !/^(date|description|withdrawals|deposits|balance)\b/i.test(desc)) warnings.push(`Skipped a line with no amount: “${desc.slice(0, 60)}”`);
      continue;
    }
    if (b.date) lastDate = resolveDate(b.date, period) || lastDate;
    let amount;
    if (b.w != null) amount = -Math.abs(b.w);
    else if (b.d != null) amount = Math.abs(b.d);
    else {
      // No column info: use the printed balance to decide the sign, then keywords.
      const v = Math.abs(b.unknown);
      if (b.bal != null && running != null) amount = Math.abs(round2(running - v) - b.bal) < 0.005 ? -v : v;
      else amount = /deposit|credit|payroll|refund|received|rebate|interest/i.test(desc) ? v : -v;
    }
    if (running != null) {
      running = round2(running + amount);
      if (b.bal != null && Math.abs(running - b.bal) >= 0.005) {
        balanceIssues.push({ date: lastDate, description: desc, expected: running, printed: b.bal });
        running = b.bal;
      }
    }
    txns.push({ date: lastDate, description: desc, amount: round2(amount), balance: b.bal ?? null, page: b.page });
  }

  return { period, opening, closing, summaryTotals: { withdrawals: summary.withdrawals, deposits: summary.deposits }, transactions: txns, balanceIssues, warnings };
}

function parseRow(line, cols) {
  const cells = line.cells;
  if (!cells.length) return null;
  let date = null;
  let rest = cells;
  // Date column: leading cells left of the description column (or a leading "Mon D" token).
  const descLeft = cols?.desc ?? null;
  const lead = [];
  for (const c of cells) {
    if (descLeft != null ? c.right <= descLeft + 1.5 : lead.length < 2) lead.push(c); else break;
  }
  for (let n = Math.min(2, lead.length); n >= 1; n--) {
    const t = lead.slice(0, n).map((c) => c.text.trim()).join(' ');
    if (DATE_RE.test(t) && monthNum(DATE_RE.exec(t)[1])) { date = t; rest = cells.slice(n); break; }
  }
  if (!date) {
    // "Jan 2 RETAIL PURCHASE …" packed into one cell
    const m = /^([A-Za-z]{3,4})\.?\s+(\d{1,2})\s+(.*)$/.exec(cells[0].text.trim());
    if (m && monthNum(m[1]) && (descLeft == null || cells[0].x < descLeft - 1)) {
      date = `${m[1]} ${m[2]}`;
      rest = [{ ...cells[0], text: m[3] }, ...cells.slice(1)];
    }
  }

  const amountCells = [];
  const textCells = [];
  const rightZone = cols ? cols.desc != null ? cols.desc + (cols.w - cols.desc) * 0.55 : cols.w - 40 : null;
  rest.forEach((c, i) => {
    const t = c.text.trim();
    const isRightmost = i >= rest.length - 3;
    const center = (c.x + c.right) / 2;
    if (isAmount(t) && (rightZone != null ? center >= rightZone : isRightmost)) amountCells.push({ v: parseAmount(t), center, raw: t });
    else textCells.push(t);
  });

  const row = { date, desc: textCells.join(' ').replace(/\s+/g, ' ').trim(), w: null, d: null, bal: null, unknown: null, amounts: amountCells.map((a) => a.v) };
  if (cols) {
    const centers = [['w', cols.w], ['d', cols.d]];
    if (cols.b != null) centers.push(['bal', cols.b]);
    for (const a of amountCells) {
      let best = null;
      for (const [k, cx] of centers) if (!best || Math.abs(a.center - cx) < best.dist) best = { k, dist: Math.abs(a.center - cx) };
      row[best.k] = row[best.k] == null ? a.v : row[best.k];
    }
  } else if (amountCells.length >= 2) {
    row.unknown = amountCells[0].v;
    row.bal = amountCells[amountCells.length - 1].v;
  } else if (amountCells.length === 1) {
    row.unknown = amountCells[0].v;
  }
  row.hasAmt = row.w != null || row.d != null || row.unknown != null;
  if (!row.desc && !row.hasAmt && row.bal == null && !date) return null;
  return row;
}

function resolveDate(token, period) {
  const m = DATE_RE.exec(token.trim());
  if (!m) return null;
  const mo = monthNum(m[1]);
  const day = Number(m[2]);
  if (!mo) return null;
  const pad = (n) => String(n).padStart(2, '0');
  if (!period) return null;
  const years = [...new Set([Number(period.end.slice(0, 4)), Number(period.start.slice(0, 4))])];
  for (const y of years) {
    const d = `${y}-${pad(mo)}-${pad(day)}`;
    if (d >= shift(period.start, -7) && d <= shift(period.end, 7)) return d;
  }
  return `${years[0]}-${pad(mo)}-${pad(day)}`;
}
function shift(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

const MON = '([A-Za-z]{3,9})\\.?';
function isoFrom(mon, day, year) {
  const mo = monthNum(mon);
  if (!mo) return null;
  return `${year}-${String(mo).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
}

export function parseSummary(text) {
  const flat = text.replace(/\s+/g, ' ');
  const out = { period: null, opening: null, closing: null, withdrawals: null, deposits: null };
  const AMT = '(\\(?[-−]?\\s?\\$?\\s?[-−]?[\\d,]+\\.\\d{2}\\)?)';

  const p = new RegExp(`For ${MON} (\\d{1,2}),? ?(\\d{4})? to ${MON} (\\d{1,2}),? (\\d{4})`, 'i').exec(flat);
  if (p) {
    const endY = p[6];
    let startY = p[3] || endY;
    if (!p[3] && monthNum(p[1]) > monthNum(p[4])) startY = String(Number(endY) - 1);
    out.period = { start: isoFrom(p[1], p[2], startY), end: isoFrom(p[4], p[5], endY) };
  }
  const o = new RegExp(`Opening balance on ${MON} (\\d{1,2}),? (\\d{4}) ?=? ?${AMT}`, 'i').exec(flat);
  if (o) { out.opening = parseAmount(o[4]); out.openingDate = isoFrom(o[1], o[2], o[3]); }
  const c = new RegExp(`Closing balance on ${MON} (\\d{1,2}),? (\\d{4}) ?=? ?${AMT}`, 'i').exec(flat);
  if (c) { out.closing = parseAmount(c[4]); out.closingDate = isoFrom(c[1], c[2], c[3]); }
  const w = new RegExp(`Withdrawals ?[-−–] ?\\$? ?([\\d,]+\\.\\d{2})`, 'i').exec(flat);
  if (w) out.withdrawals = parseAmount(w[1]);
  const d = new RegExp(`Deposits ?\\+ ?\\$? ?([\\d,]+\\.\\d{2})`, 'i').exec(flat);
  if (d) out.deposits = parseAmount(d[1]);
  if (!out.period && out.openingDate && out.closingDate) out.period = { start: out.openingDate, end: out.closingDate };
  return out;
}

/**
 * Reconcile a parsed statement against its own printed numbers.
 * Returns { ok, checks: [{label, statement, computed, ok}], issues: [string] }.
 */
export function reconcile(st) {
  const cents = (n) => Math.round(n * 100);
  let wd = 0;
  let dep = 0;
  for (const t of st.transactions) { if (t.amount < 0) wd += cents(-t.amount); else dep += cents(t.amount); }
  const checks = [];
  const issues = [];
  const add = (label, statement, computed) => {
    const ok = statement == null ? null : cents(statement) === computed;
    checks.push({ label, statement, computed: computed / 100, ok });
    if (ok === false) issues.push(`${label}: statement says ${statement.toFixed(2)}, transactions add up to ${(computed / 100).toFixed(2)} (off by ${((computed - cents(statement)) / 100).toFixed(2)})`);
  };
  if (st.opening == null) issues.push('Could not find the opening balance.');
  if (st.closing == null) issues.push('Could not find the closing balance.');
  if (!st.period) issues.push('Could not find the statement period.');
  add('Withdrawals', st.summaryTotals?.withdrawals, wd);
  add('Deposits', st.summaryTotals?.deposits, dep);
  if (st.opening != null) add('Closing balance', st.closing, cents(st.opening) + dep - wd);
  for (const b of st.balanceIssues || []) issues.push(`Running balance differs on ${b.date} (“${b.description.slice(0, 40)}”): expected ${b.expected.toFixed(2)}, statement shows ${b.printed.toFixed(2)}`);
  if (!st.transactions.length) issues.push('No transactions found.');
  const ok = issues.length === 0 && checks.every((c) => c.ok !== false);
  return { ok, checks, issues, totals: { withdrawals: wd / 100, deposits: dep / 100 } };
}
