// Readers for the export files online banking offers almost everywhere: CSV/TSV, OFX/QFX and QIF.
// Each returns { transactions: [{ date, description, amount, balance }], meta, warnings, opening?, closing? }
// in date order. statements.js then splits them into months.
import { scanDate, resolveOrder, settle, isoDate, validDate, parseLoose, detectCurrency, norm } from './parse-util.js';

const round2 = (n) => Math.round(n * 100) / 100;

/** Bytes → text: UTF-8 when valid, otherwise Windows-1252 (common for older bank exports). */
export function decodeText(bytes) {
  let t;
  try { t = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { t = new TextDecoder('windows-1252').decode(bytes); }
  return t.replace(/^﻿/, '');
}

export function sniff(name, text) {
  const head = text.slice(0, 2000);
  if (/OFXHEADER|<OFX>/i.test(head)) return 'ofx';
  if (/^\s*!(Type|Account|Option)/i.test(head)) return 'qif';
  if (/\.(ofx|qfx)$/i.test(name)) return 'ofx';
  if (/\.qif$/i.test(name)) return 'qif';
  return 'csv';
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

function splitRows(text, delim) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { q = true; cell = ''; }
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => splitRows(l, d)[0]?.length || 0).filter((n) => n > 1);
    if (!counts.length) continue;
    const freq = new Map();
    for (const n of counts) freq.set(n, (freq.get(n) || 0) + 1);
    const [n, k] = [...freq].sort((a, b) => b[1] - a[1])[0];
    const score = k * 10 + n;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

const H = {
  date: ['date', 'transaction date', 'trans date', 'txn date', 'posting date', 'posted date', 'post date', 'booking date', 'value date', 'datum', 'buchungstag', 'buchungsdatum', 'valutadatum', 'fecha', 'fecha operacion', 'fecha valor', 'data', 'data operazione', 'data contabile', 'date operation', 'date de l operation', 'date valeur', 'boekdatum', 'transaction date time', 'completed date', 'started date', 'date completed utc', 'created on'],
  desc: ['description', 'transaction description', 'details', 'detail', 'narrative', 'narration', 'particulars', 'payee', 'name', 'merchant', 'merchant name', 'memo', 'reference', 'transaction details', 'libelle', 'libelle operation', 'descripcion', 'concepto', 'beschreibung', 'verwendungszweck', 'buchungstext', 'auftraggeber empfanger', 'beguenstigter zahlungspflichtiger', 'empfanger', 'descrizione', 'causale', 'descricao', 'historico', 'omschrijving', 'naam omschrijving', 'mededelingen', 'counter party', 'counterparty', 'title', 'remarks', 'transaction', 'original description', 'text'],
  amount: ['amount', 'transaction amount', 'amount cad', 'amount usd', 'amount eur', 'amount gbp', 'value', 'montant', 'importe', 'monto', 'betrag', 'umsatz', 'importo', 'valor', 'bedrag', 'kwota', 'net amount', 'amount local currency'],
  debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'withdrawal amount', 'withdrawal amt', 'paid out', 'money out', 'out', 'spent', 'debit cad', 'retrait', 'debit eur', 'sortie', 'cargo', 'cargos', 'debe', 'soll', 'lastschrift', 'addebiti', 'uscite', 'dare', 'saida', 'debito', 'af'],
  credit: ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'deposit amount', 'deposit amt', 'paid in', 'money in', 'in', 'received', 'credit cad', 'depot', 'credit eur', 'entree', 'abono', 'abonos', 'haber', 'haben', 'gutschrift', 'accrediti', 'entrate', 'avere', 'entrada', 'credito', 'bij'],
  balance: ['balance', 'running balance', 'closing balance', 'available balance', 'balance cad', 'solde', 'saldo', 'kontostand', 'balans', 'saldo contable'],
  type: ['type', 'transaction type', 'dr cr', 'cr dr', 'debit credit', 'credit debit', 'af bij', 'soll haben', 'indicator', 'd c', 'c d'],
  currency: ['currency', 'devise', 'moneda', 'wahrung', 'waehrung', 'valuta', 'ccy'],
};
const ROLE_ORDER = ['date', 'balance', 'debit', 'credit', 'amount', 'type', 'currency', 'desc'];
// When several columns describe a line, the payee/merchant goes first, then the description, then memos.
const DESC_RANK = [
  ['payee', 'name', 'merchant', 'merchant name', 'counter party', 'counterparty', 'beguenstigter zahlungspflichtiger', 'auftraggeber empfanger', 'empfanger', 'naam omschrijving'],
  ['description', 'transaction description', 'details', 'detail', 'narrative', 'narration', 'particulars', 'libelle', 'libelle operation', 'descripcion', 'concepto', 'beschreibung', 'descrizione', 'descricao', 'historico', 'omschrijving', 'title', 'original description', 'text', 'transaction details', 'transaction'],
  ['memo', 'reference', 'verwendungszweck', 'causale', 'mededelingen', 'remarks'],
];
const EXACT_ANY = new Set(Object.values(H).flat());
const descRank = (h) => { const i = DESC_RANK.findIndex((g) => g.includes(h)); return i < 0 ? 3 : i; };

function headerMap(row) {
  const map = {};
  const used = new Set();
  const cells = row.map((c) => norm(c));
  const claim = (role, i) => {
    if (role === 'desc') (map.desc ||= []).push(i);
    else if (map[role] == null) map[role] = i;
    else return;
    used.add(i);
  };
  // Exact names first, then looser ones ("Amount (CAD)", "Original amount").
  const sortDesc = () => { if (map.desc) map.desc.sort((a, b) => descRank(cells[a]) - descRank(cells[b]) || a - b); };
  for (const exact of [true, false]) {
    for (const role of ROLE_ORDER) {
      if (!exact && (role === 'desc' || role === 'type')) continue;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (!c || used.has(i)) continue;
        // Loose names ("Amount (CHF)") never claim a cell that is exactly another column's name ("Value Date").
        const hit = exact ? H[role].includes(c) : !EXACT_ANY.has(c) && H[role].some((w) => w.length > 2 && (c.startsWith(w + ' ') || c.endsWith(' ' + w)));
        if (hit) claim(role, i);
      }
    }
  }
  sortDesc();
  return map;
}

/** Parse a CSV/TSV export. options: { dateOrder, flip } */
export function parseCsv(text, options = {}) {
  const delim = detectDelimiter(text);
  const rows = splitRows(text, delim);
  const warnings = [];
  // Header: the first row (within the first 25) that names a date column and a money column.
  let hi = -1, map = null;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const m = headerMap(rows[i]);
    if (m.date != null && (m.amount != null || m.debit != null || m.credit != null)) { hi = i; map = m; break; }
  }
  let body = hi >= 0 ? rows.slice(hi + 1) : rows;
  if (!map) map = inferColumns(rows);
  if (!map || map.date == null || (map.amount == null && map.debit == null && map.credit == null)) {
    throw new Error('Couldn’t find the date and amount columns in this file.');
  }
  const width = Math.max(...body.map((r) => r.length));
  if (!map.desc || !map.desc.length) {
    // Pick the column with the most letters.
    let best = null;
    for (let c = 0; c < width; c++) {
      if (Object.values(map).flat().includes(c)) continue;
      const letters = body.slice(0, 50).reduce((s, r) => s + ((r[c] || '').match(/\p{L}/gu) || []).length, 0);
      if (!best || letters > best.letters) best = { c, letters };
    }
    map.desc = best ? [best.c] : [];
  }

  // Decimal separator: ";" files are usually comma-decimal; check the numbers themselves.
  const numCols = [map.amount, map.debit, map.credit, map.balance].filter((c) => c != null);
  let comma = 0, dot = 0;
  for (const r of body.slice(0, 200)) for (const c of numCols) {
    const v = (r[c] || '').replace(/\s/g, '');
    if (/\d,\d{1,2}(\D*)$/.test(v) && !/\d\.\d{1,2}(\D*)$/.test(v)) comma++;
    else if (/\d\.\d{1,2}(\D*)$/.test(v)) dot++;
  }
  const decimal = comma > dot || (comma === dot && delim === ';') ? ',' : '.';

  // Dates
  const scans = body.map((r) => scanDate(r[map.date] || '', { compact: true }));
  const ord = resolveOrder(scans, options.dateOrder);
  const order = options.dateOrder || ord.order;
  const currency = detectCurrency(rows.slice(0, hi + 1).flat().join(' ') + ' ' + (map.currency != null ? body.slice(0, 20).map((r) => r[map.currency]).join(' ') : ''));

  const out = [];
  let skipped = 0;
  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    const s = scans[i];
    if (!s) { skipped++; continue; }
    const d = settle(s, order);
    if (!d.y || !validDate(d.y, d.m, d.d)) { skipped++; continue; }
    const desc = map.desc.map((c) => r[c]).filter(Boolean).filter((v, k, a) => a.indexOf(v) === k).join(' · ').replace(/\s+/g, ' ').trim();
    let amount = null;
    const deb = map.debit != null ? parseLoose(r[map.debit], decimal) : null;
    const cre = map.credit != null ? parseLoose(r[map.credit], decimal) : null;
    if (deb && deb.abs) amount = -deb.abs;
    if (cre && cre.abs) amount = (amount || 0) + cre.abs;
    if (amount == null && map.amount != null) {
      const a = parseLoose(r[map.amount], decimal);
      if (a) amount = a.value;
    }
    if (amount == null) { skipped++; continue; }
    if (map.type != null) {
      const t = norm(r[map.type] || '');
      // Whole values only: a type like "Credit Card Payment" says nothing about the direction.
      if (/^(d|dr|debit|debito|af|s|soll|withdrawal|out|sale|purchase|payment out)$/.test(t)) amount = -Math.abs(amount);
      else if (/^(c|cr|credit|credito|bij|h|haben|deposit|in|refund)$/.test(t)) amount = Math.abs(amount);
    }
    const bal = map.balance != null ? parseLoose(r[map.balance], decimal) : null;
    out.push({ date: isoDate(d.y, d.m, d.d), description: desc || '(no description)', amount: round2(amount), balance: bal ? round2(bal.value) : null, row: i });
  }
  if (skipped) warnings.push(`${skipped} row(s) without a readable date or amount were skipped.`);
  return finish(out, { format: 'csv', currency, decimal, dateOrder: order, dateOrderCertain: !!options.dateOrder || ord.certain || !scans.some((x) => x?.ambiguous) }, warnings, options);
}

/** No header row: find the date column and number columns by what's in them. */
function inferColumns(rows) {
  const sample = rows.slice(0, 80);
  const width = Math.max(...sample.map((r) => r.length));
  const isNum = (v) => /^[-−(]?[^\p{L}]{0,4}\d[\d.,\s']*[)]?(\s?(CR|DR))?$/u.test(v.trim());
  let date = null;
  const nums = [];
  for (let c = 0; c < width; c++) {
    const vals = sample.map((r) => (r[c] || '').trim());
    const filled = vals.filter(Boolean);
    if (filled.length < sample.length * 0.1) continue;
    if (date == null && filled.filter((v) => scanDate(v, { compact: true })).length > filled.length * 0.7) { date = c; continue; }
    if (filled.filter(isNum).length <= filled.length * 0.8) continue;
    // Whole numbers that are all different (reference numbers, IDs) aren't money.
    const withCents = filled.filter((v) => /[.,]\d{1,2}\)?\s*$/.test(v) || /^[-−(]/.test(v)).length;
    if (withCents < filled.length * 0.3 && new Set(filled).size === filled.length) continue;
    nums.push({ c, fill: filled.length / sample.length, rows: new Set(vals.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)) });
  }
  if (date == null || !nums.length) return null;
  // Two half-empty columns that are never filled on the same row: withdrawals and deposits.
  for (let i = 0; i + 1 < nums.length; i++) {
    const a = nums[i], b = nums[i + 1];
    const overlap = [...a.rows].filter((r) => b.rows.has(r)).length;
    if (a.fill < 0.95 && b.fill < 0.95 && overlap <= Math.min(a.rows.size, b.rows.size) * 0.05) {
      const rest = nums.slice(i + 2);
      return { date, debit: a.c, credit: b.c, ...(rest.length ? { balance: rest[rest.length - 1].c } : {}) };
    }
  }
  if (nums.length >= 2) return { date, amount: nums[0].c, balance: nums[nums.length - 1].c };
  return { date, amount: nums[0].c };
}

// ---------------------------------------------------------------------------
// OFX / QFX (SGML or XML)
// ---------------------------------------------------------------------------

const tag = (block, name) => {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? m[1].trim() : null;
};
const ofxDate = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s || '');
  return m && validDate(+m[1], +m[2], +m[3]) ? isoDate(+m[1], +m[2], +m[3]) : null;
};
const ofxNum = (s) => (s == null ? null : Number(String(s).replace(',', '.')));
const unescapeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

export function parseOfx(text, options = {}) {
  // A file can hold several accounts (chequing + savings): read each and import the one with the most activity.
  const parts = text.split(/<(?=(?:STMTRS|CCSTMTRS)>)/i).slice(1).map((p) => '<' + p);
  if (parts.length > 1) {
    const read = parts.map((p) => { try { return parseOfxAccount(p, options); } catch { return null; } }).filter(Boolean);
    if (!read.length) throw new Error('No transactions found in this OFX file.');
    read.sort((a, b) => b.transactions.length - a.transactions.length);
    read[0].warnings.push(`This file has ${read.length} accounts. Imported the one with the most transactions (${read[0].transactions.length}); export the others separately if you want them.`);
    return read[0];
  }
  return parseOfxAccount(text, options);
}

function parseOfxAccount(text, options = {}) {
  const warnings = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]);
  const card = /<CCSTMTRS>|<CREDITCARDMSGSRSV1>/i.test(text);
  const out = [];
  for (const b of blocks) {
    const date = ofxDate(tag(b, 'DTPOSTED')) || ofxDate(tag(b, 'DTUSER'));
    const amt = ofxNum(tag(b, 'TRNAMT'));
    if (!date || !Number.isFinite(amt)) continue;
    const name = tag(b, 'NAME') || tag(b, 'PAYEE') || '';
    const memo = tag(b, 'MEMO') || '';
    const desc = unescapeXml([name, memo && memo !== name ? memo : ''].filter(Boolean).join(' · '));
    out.push({ date, description: desc || tag(b, 'TRNTYPE') || '(no description)', amount: round2(amt), balance: null });
  }
  if (!out.length) throw new Error('No transactions found in this OFX file.');
  const currency = tag(text, 'CURDEF');
  const ledger = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>)/i.exec(text);
  const closing = ledger ? ofxNum(tag(ledger[1], 'BALAMT')) : null;
  const closingDate = ledger ? ofxDate(tag(ledger[1], 'DTASOF')) : null;
  const range = { start: ofxDate(tag(text, 'DTSTART')), end: ofxDate(tag(text, 'DTEND')) };
  return finish(out, { format: 'ofx', currency, card }, warnings, options, { closing, closingDate, range });
}

// ---------------------------------------------------------------------------
// QIF
// ---------------------------------------------------------------------------

export function parseQif(text, options = {}) {
  const warnings = [];
  const recs = [];
  let cur = {};
  let card = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (/^!Type:CCard/i.test(line)) card = true;
    if (line[0] === '!') continue;
    if (line[0] === '^') { if (cur.D) recs.push(cur); cur = {}; continue; }
    const k = line[0], v = line.slice(1).trim();
    if (k === 'D') cur.D = v;
    else if (k === 'T' || k === 'U') cur.T ??= v;
    else if (k === 'P') cur.P = v;
    else if (k === 'M') cur.M = v;
  }
  if (cur.D) recs.push(cur);
  const scans = recs.map((r) => scanDate(r.D.replace(/'\s?/, '/').replace(/\s+/g, '')));
  const ord = resolveOrder(scans, options.dateOrder || 'mdy'); // QIF comes from Quicken: month first unless the data says otherwise
  const order = options.dateOrder || ord.order;
  const out = [];
  recs.forEach((r, i) => {
    const d = settle(scans[i], order);
    const a = parseLoose(r.T, /,\d{2}$/.test(r.T || '') ? ',' : '.');
    if (!d || !d.y || !validDate(d.y, d.m, d.d) || !a) return;
    out.push({ date: isoDate(d.y, d.m, d.d), description: [r.P, r.M && r.M !== r.P ? r.M : ''].filter(Boolean).join(' · ') || '(no description)', amount: round2(a.value), balance: null });
  });
  if (!out.length) throw new Error('No transactions found in this QIF file.');
  return finish(out, { format: 'qif', currency: null, card, dateOrder: order, dateOrderCertain: !!options.dateOrder || ord.certain }, warnings, options);
}

// ---------------------------------------------------------------------------
// Shared clean-up
// ---------------------------------------------------------------------------

const PAYMENT_RE = /\b(payment|thank you|autopay|paiement|pago|zahlung|pagamento)\b/i;

function finish(list, meta, warnings, options, extra = {}) {
  let txns = list;
  // Newest first? Put it in date order, keeping same-day lines in their (reversed) order so balances chain.
  if (txns.length > 1 && txns[0].date > txns[txns.length - 1].date) txns = txns.slice().reverse();
  txns = txns.map((t, i) => ({ ...t, _i: i })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a._i - b._i)).map(({ _i, row, ...t }) => t);

  // Card exports that show charges as positive: payments come out negative while most lines are positive.
  if (meta.format === 'csv' && !txns.some((t) => t.balance != null)) {
    const pays = txns.filter((t) => PAYMENT_RE.test(t.description));
    const posShare = txns.filter((t) => t.amount > 0).length / Math.max(1, txns.length);
    if (pays.length && pays.every((t) => t.amount < 0) && posShare > 0.6) { txns.forEach((t) => { t.amount = -t.amount; }); meta.flippedCard = true; }
  }
  if (options.flip) txns.forEach((t) => { t.amount = -t.amount; if (t.balance != null) t.balance = -t.balance; });

  // Running balance: does each line's balance follow from the previous one?
  const check = () => {
    const out = [];
    let prev = null;
    for (const t of txns) {
      if (t.balance == null) { if (prev != null) prev = round2(prev + t.amount); continue; }
      if (prev != null && Math.round((prev + t.amount) * 100) !== Math.round(t.balance * 100)) out.push({ t, expected: round2(prev + t.amount) });
      prev = t.balance;
    }
    return out;
  };
  const withBal = txns.filter((t) => t.balance != null);
  let issues = withBal.length > 1 ? check() : [];
  if (issues.length > withBal.length / 3) {
    // Unsigned amounts: let the balance say which way each line went.
    const saved = txns.map((t) => t.amount);
    let prev = null;
    for (const t of txns) {
      if (t.balance != null && prev != null) {
        if (Math.round((prev - Math.abs(t.amount)) * 100) === Math.round(t.balance * 100)) t.amount = -Math.abs(t.amount);
        else if (Math.round((prev + Math.abs(t.amount)) * 100) === Math.round(t.balance * 100)) t.amount = Math.abs(t.amount);
      }
      if (t.balance != null) prev = t.balance;
    }
    const again = check();
    if (again.length <= withBal.length / 10) { issues = again; meta.signsFromBalance = true; }
    else {
      txns.forEach((t, i) => { t.amount = saved[i]; t.balance = null; });
      warnings.push('The balance column doesn’t follow the amounts, so it was ignored.');
      issues = [];
    }
  }
  return { transactions: txns, meta, warnings, balanceIssues: issues.map(({ t, expected }) => ({ date: t.date, description: t.description, expected, printed: t.balance })), ...extra };
}
