// Reading dates and amounts the way banks around the world print them.
// Pure functions shared by the PDF reader, the CSV/OFX/QIF readers and the tests.

const strip = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Month names and abbreviations: English, French, Spanish, German, Italian, Portuguese, Dutch.
const MONTH_WORDS = [
  'january jan janvier janv enero ene januar janner jaen gennaio gen janeiro januari',
  'february feb fevrier fevr fev febrero februar febbraio fevereiro februari',
  'march mar mars marzo marz maerz mrz marco maart mrt',
  'april apr avril avr abril abr aprile',
  'may mai mayo maggio mag maio mei',
  'june jun juin junio juni giugno giu junho jun',
  'july jul juillet juil julio juli luglio lug julho',
  'august aug aout agosto ago augustus',
  'september sep sept septembre septiembre set settembre setembro',
  'october oct octobre octubre oktober okt ottobre ott outubro out',
  'november nov novembre noviembre novembro',
  'december dec decembre diciembre dic dezember dez dicembre dezembro',
];
const MONTHS = new Map();
MONTH_WORDS.forEach((line, i) => line.split(' ').forEach((w) => MONTHS.set(w, i + 1)));
export const monthFromWord = (w) => MONTHS.get(strip(w).replace(/\.$/, '')) || null;

const MW = '([A-Za-zÀ-ÿ]{3,10})\\.?';
const ORD = '(?:st|nd|rd|th|er|e|º|ª)?';
// Each pattern is anchored at the start of the text and yields { d, m, y } (m may be a word).
const DATE_PATTERNS = [
  // 2026-01-31, 2026/01/31, 2026.01.31
  { re: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d])/, map: (m) => ({ y: m[1], a: m[2], b: m[3], iso: true }) },
  // 20260131 (only for CSV cells, where the whole cell is the date)
  { re: /^(\d{4})(\d{2})(\d{2})$/, compact: true, map: (m) => ({ y: m[1], a: m[2], b: m[3], iso: true }) },
  // 31/01/2026, 01/31/2026, 31.01.26, 31-01-2026, 1/31'26
  { re: /^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-]|'\s?)(\d{4}|\d{2})(?![\d])/, map: (m) => ({ a: m[1], b: m[2], y: m[3] }) },
  // 31 Jan 2026, 31-JAN-26, 31. Januar 2026, 31 de enero de 2026, 1st January 2026
  { re: new RegExp(`^(\\d{1,2})${ORD}\\.?[\\s\\-/]*(?:de\\s+)?${MW}[\\s\\-/,.]*(?:de\\s+)?(\\d{4}(?!\\d|[.,]\\d)|\\d{2}(?![\\d:]|[.,]\\d))?`), map: (m) => ({ d: m[1], m: m[2], y: m[3] }) },
  // Jan 31, 2026 / January 31 / Jan. 31 2026 / JAN-31-26
  { re: new RegExp(`^${MW}[\\s\\-/]*(\\d{1,2})${ORD}(?![\\d:]|[.,]\\d)(?:,?[\\s\\-/]*(\\d{4}(?!\\d|[.,]\\d)|\\d{2}(?![\\d:]|[.,]\\d)))?`), map: (m) => ({ m: m[1], d: m[2], y: m[3] }) },
  // 31/01 or 01/31 without a year (slash), and German "31.01." (dot, trailing dot)
  { re: /^(\d{1,2})\/(\d{1,2})(?![\d/.,])/, map: (m) => ({ a: m[1], b: m[2] }) },
  { re: /^(\d{1,2})\.(\d{1,2})\.(?!\d)/, map: (m) => ({ a: m[1], b: m[2] }) },
];

/**
 * Read a date at the start of `text`. Returns { len, y, m, d } or, for numeric day/month that
 * could go either way, { len, y, a, b, ambiguous: true } to be settled by resolveOrder().
 */
export function scanDate(text, { compact = false } = {}) {
  const t = String(text);
  for (const p of DATE_PATTERNS) {
    if (p.compact && !compact) continue;
    const m = p.re.exec(t);
    if (!m) continue;
    const r = p.map(m);
    let y = r.y != null ? Number(r.y) : null;
    if (y != null && y < 100) y += y >= 70 ? 1900 : 2000;
    if (y != null && (y < 1970 || y > 2100)) continue;
    if (r.m != null) {
      const mo = monthFromWord(r.m);
      const d = Number(r.d);
      if (!mo || d < 1 || d > 31) continue;
      return { len: m[0].trimEnd().length, y, m: mo, d };
    }
    const a = Number(r.a), b = Number(r.b);
    if (r.iso) {
      if (a < 1 || a > 12 || b < 1 || b > 31) continue;
      return { len: m[0].length, y, m: a, d: b };
    }
    const dmyOk = b >= 1 && b <= 12 && a >= 1 && a <= 31;
    const mdyOk = a >= 1 && a <= 12 && b >= 1 && b <= 31;
    if (!dmyOk && !mdyOk) continue;
    // Keep the raw numbers: an unambiguous date (13/02) tells us the order of the ambiguous ones.
    if (dmyOk && mdyOk && a !== b) return { len: m[0].length, y, a, b, numeric: true, ambiguous: true };
    return dmyOk ? { len: m[0].length, y, m: b, d: a, a, b, numeric: true } : { len: m[0].length, y, m: a, d: b, a, b, numeric: true };
  }
  return null;
}

/** Find every date in a longer text (word-boundary starts). Returns [{ index, len, ...date }]. */
export function findDates(text) {
  const out = [];
  const t = String(text);
  for (let i = 0; i < t.length; i++) {
    if (i > 0 && /[\p{L}\p{N}]/u.test(t[i - 1])) continue;
    if (!/[\p{L}\p{N}]/u.test(t[i])) continue;
    const r = scanDate(t.slice(i, i + 40));
    if (r) { out.push({ index: i, ...r }); i += r.len - 1; }
  }
  return out;
}

/** Day/month order for ambiguous numeric dates: 'dmy' | 'mdy', plus whether the data alone decided it. */
export function resolveOrder(dates, hint = null) {
  let dmy = false, mdy = false;
  for (const x of dates) {
    if (!x || !x.numeric) continue;
    if (x.a > 12) dmy = true;
    if (x.b > 12) mdy = true;
  }
  if (dmy && !mdy) return { order: 'dmy', certain: true };
  if (mdy && !dmy) return { order: 'mdy', certain: true };
  if (hint) return { order: hint, certain: false };
  // Neither decides: pick the order that keeps the dates in sequence more often.
  const amb = dates.filter((x) => x && x.ambiguous);
  if (amb.length > 1) {
    const score = (order) => {
      let s = 0;
      for (let i = 1; i < amb.length; i++) {
        const k = (x) => (order === 'dmy' ? x.b * 40 + x.a : x.a * 40 + x.b);
        const d = k(amb[i]) - k(amb[i - 1]);
        if (d >= 0 && d < 80) s++;
      }
      return s;
    };
    const sd = score('dmy'), sm = score('mdy');
    if (sd !== sm) return { order: sd > sm ? 'dmy' : 'mdy', certain: false };
  }
  return { order: 'dmy', certain: false };
}

/** Apply a day/month order to a scanned date. */
export function settle(x, order) {
  if (!x) return null;
  if (!x.ambiguous) return { y: x.y, m: x.m, d: x.d };
  return order === 'mdy' ? { y: x.y, m: x.a, d: x.b } : { y: x.y, m: x.b, d: x.a };
}

export const isoDate = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

const CUR_SYM = '(?:[A-Z]{3}|US\\$|CA\\$|C\\$|A\\$|NZ\\$|HK\\$|S\\$|R\\$|[$€£¥₹₩₦₱₫฿₺₪₴₽]|kr\\.?|zł|Kč|Fr\\.?|CHF|R(?=\\s?\\d))';
const NUM = "\\d{1,3}(?:[,.\\u00a0\\u202f '’]\\d{3})+[.,]\\d{2}|\\d+[.,]\\d{2}";
const SIGN = '[-−–+]';
/** One printed amount, with optional currency, sign, parentheses and CR/DR markers. */
export const AMOUNT_TOKEN = new RegExp(
  `^\\(?${SIGN}?\\s?(?:${CUR_SYM}\\s?)?${SIGN}?\\s?(?:${NUM})\\s?(?:${CUR_SYM})?\\)?\\s?${SIGN}?\\s?(?:CR|DR|Cr|Dr|cr|dr|C|D|H|S)?$`,
);
/** Amounts at the end of a longer text cell ("COFFEE 4.50" or "COFFEE 4.50 1,234.56"). */
const TRAILING_AMOUNT = new RegExp(`(?:^|\\s)(\\(?${SIGN}?\\s?(?:${CUR_SYM}\\s?)?${SIGN}?(?:${NUM})\\)?${SIGN}?(?:\\s?(?:CR|DR|Cr|Dr))?)$`);

export const isAmountToken = (s) => {
  const t = String(s).trim();
  return t.length > 0 && t.length < 40 && AMOUNT_TOKEN.test(t) && !/^\d{1,2}[.]\d{2}[.]/.test(t);
};

/** Split trailing amounts off a text cell: returns { text, amounts: [string] }. */
export function splitTrailingAmounts(text) {
  let t = String(text).trim();
  const amounts = [];
  for (let k = 0; k < 3; k++) {
    const m = TRAILING_AMOUNT.exec(t);
    if (!m) break;
    const before = t.slice(0, m.index).trim();
    // Don't eat a date ("12.05") or a year-ish number that belongs to the text.
    if (!before && amounts.length === 0 && !isAmountToken(m[1])) break;
    amounts.unshift(m[1].trim());
    t = before;
  }
  return { text: t, amounts };
}

/** Which character is the decimal separator in this document: '.' or ','. */
export function detectDecimal(tokens) {
  let dot = 0, comma = 0;
  for (const raw of tokens) {
    const s = String(raw).replace(/\s?(CR|DR|Cr|Dr|[A-Z]{3})$/,'').replace(/[)\-−–]+$/, '').trim();
    if (/\d\.\d{3},\d{2}$/.test(s)) comma += 3;
    else if (/\d,\d{3}\.\d{2}$/.test(s)) dot += 3;
    else if (/\d,\d{2}$/.test(s)) comma++;
    else if (/\d\.\d{2}$/.test(s)) dot++;
  }
  return comma > dot ? ',' : '.';
}

/**
 * Parse a printed amount. Returns { value, abs, explicit, marker }:
 *   marker  'minus' | 'paren' | 'dr' | 'cr' | 'plus' | null  — what the text itself says
 *   explicit -1 / +1 / 0, reading the marker the way a bank account does (DR and minus are money out)
 */
export function parseMoney(raw, decimal = '.') {
  let s = String(raw).trim();
  if (!s) return null;
  let marker = null;
  const suffix = /\s?(CR|DR|Cr|Dr|cr|dr|C|D|H|S)$/.exec(s);
  if (suffix && /\d|\)/.test(s.slice(0, suffix.index).slice(-1))) {
    const k = suffix[1].toUpperCase();
    marker = k === 'CR' || k === 'C' || k === 'H' ? 'cr' : 'dr';
    s = s.slice(0, suffix.index);
  }
  if (/^\(.*\)$/.test(s.trim())) marker = 'paren';
  else if (/^\s*[-−–]|[-−–]\s*$/.test(s) || /^[^\d]*[-−–]\s?\d/.test(s)) marker = 'minus';
  else if (/^\s*\+/.test(s) && !marker) marker = 'plus';
  let n = s.replace(/[^\d.,]/g, '');
  // A lone separator followed by two digits is the decimal point, whatever the document guess was.
  let dec = decimal;
  if (/^\d+,\d{2}$/.test(n)) dec = ',';
  if (/^\d+\.\d{2}$/.test(n)) dec = '.';
  n = dec === ',' ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
  const v = Number(n);
  if (!Number.isFinite(v) || n === '') return null;
  const explicit = marker === 'cr' || marker === 'plus' ? 1 : marker ? -1 : 0;
  return { value: explicit < 0 ? -v : v, abs: v, explicit, marker };
}

/**
 * Signed value for our model (money in +, money out −). On a credit card a plain number is a charge
 * and a minus/CR is a payment or refund; on a bank account it's the other way round.
 * `plain` is the sign to use when the text has no marker (0 = unknown).
 */
export function signed(m, { card = false, plain = 0 } = {}) {
  if (!m) return null;
  if (!m.marker) return plain ? plain * m.abs : null;
  const inward = card ? ['minus', 'paren', 'cr'].includes(m.marker) : ['cr', 'plus'].includes(m.marker);
  return inward ? m.abs : -m.abs;
}

/** Lenient number for CSV cells: "1234.5", "-12", "1.234,56", "(45.00)", "45.00 DR". */
export function parseLoose(raw, decimal = '.') {
  const s = String(raw ?? '').trim();
  if (!s || !/\d/.test(s)) return null;
  if (/[A-Za-z]{4,}/.test(s.replace(/\b(CR|DR|Cr|Dr)\b/, ''))) return null;
  return parseMoney(s, decimal);
}

// ---------------------------------------------------------------------------
// Currency and words
// ---------------------------------------------------------------------------

const SYMBOL_CURRENCY = [['€', 'EUR'], ['£', 'GBP'], ['₹', 'INR'], ['¥', 'JPY'], ['₩', 'KRW'], ['₦', 'NGN'], ['₱', 'PHP'], ['₫', 'VND'], ['฿', 'THB'], ['₺', 'TRY'], ['₪', 'ILS'], ['₴', 'UAH'], ['R$', 'BRL'], ['zł', 'PLN'], ['Kč', 'CZK']];
const CODES = 'CAD USD EUR GBP AUD NZD INR JPY CNY HKD SGD CHF SEK NOK DKK ZAR MXN BRL AED SAR PKR BDT LKR NGN KES GHS EGP MAD TRY PLN CZK HUF RON ILS KRW PHP THB MYR IDR VND TWD ARS CLP COP PEN QAR KWD BHD OMR JOD'.split(' ');

/** Best guess at the statement's currency (ISO code), or null. */
export function detectCurrency(text) {
  const t = String(text);
  const counts = new Map();
  const bump = (c, n = 1) => counts.set(c, (counts.get(c) || 0) + n);
  for (const c of CODES) {
    const n = (t.match(new RegExp(`\\b${c}\\b`, 'g')) || []).length;
    if (n) bump(c, n * 2);
  }
  for (const [sym, c] of SYMBOL_CURRENCY) { const n = t.split(sym).length - 1; if (n) bump(c, n); }
  if (/\b(CA\$|C\$)/.test(t)) bump('CAD', 3);
  if (/\bUS\$/.test(t)) bump('USD', 3);
  if (/\bA\$/.test(t)) bump('AUD', 3);
  let best = null;
  for (const [c, n] of counts) if (!best || n > best[1]) best = [c, n];
  return best ? best[0] : null;
}

/** Does the text contain any of these phrases (accent- and case-insensitive, whole words)? */
export function hasWord(text, phrases) {
  const t = ` ${strip(text).replace(/[^a-z0-9]+/g, ' ')} `;
  return phrases.some((p) => t.includes(` ${p} `));
}
export const norm = (s) => strip(s).replace(/[^a-z0-9]+/g, ' ').trim();
