// Formatting + small pure helpers shared by the app and the Node tools.

const LOCALE = 'en-CA';
let money2, money0, symbol;
/** Show money in the account's currency (ISO code). Defaults to Canadian dollars. */
export function setCurrency(code = 'CAD') {
  let c = String(code || 'CAD').toUpperCase();
  try { new Intl.NumberFormat(LOCALE, { style: 'currency', currency: c }); } catch { c = 'CAD'; }
  money2 = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: c, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  money0 = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: c, minimumFractionDigits: 0, maximumFractionDigits: 0 });
  symbol = money0.formatToParts(0).find((p) => p.type === 'currency')?.value || '$';
}
setCurrency('CAD');

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Dollars -> integer cents. All arithmetic happens in cents. */
export const toCents = (n) => Math.round(Number(n) * 100);
export const fromCents = (c) => Math.round(c) / 100;

/** "$1,234.56"; sign: true -> "+$1.00" / "−$1.00" (true minus sign). */
export function money(n, { sign = false, cents = true } = {}) {
  const v = Number(n) || 0;
  const s = (cents ? money2 : money0).format(Math.abs(v));
  if (v < 0 && Math.abs(v) >= (cents ? 0.005 : 0.5)) return '−' + s;
  return sign && v > 0 ? '+' + s : s;
}

/** Compact for chart labels: $950, $1.2k, $17.8k */
export function moneyShort(n) {
  const v = Math.abs(n);
  const sgn = n < 0 ? '−' : '';
  if (v >= 1000) return sgn + symbol + (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return sgn + symbol + Math.round(v);
}

export const pct = (n, d = 0) => (Number.isFinite(n) ? (n * 100).toFixed(d) : '0') + '%';

// ---- dates (all ISO 'YYYY-MM-DD' strings, treated as local calendar dates) ----
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d || 1);
}
export function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const monthOf = (isoDate) => isoDate.slice(0, 7);
export function addDays(isoDate, n) { const d = parseISO(isoDate); d.setDate(d.getDate() + n); return iso(d); }
export function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 864e5); }
export function monthLabel(ym, style = 'long') {
  const [y, m] = ym.split('-').map(Number);
  if (style === 'short') return MONTHS[m - 1];
  if (style === 'shortYear') return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
  if (style === 'month') return MONTHS_LONG[m - 1];
  return `${MONTHS_LONG[m - 1]} ${y}`;
}
export function dateLabel(isoDate, style = 'medium') {
  const d = parseISO(isoDate);
  if (style === 'day') return `${DAYS_LONG[d.getDay()]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}`;
  if (style === 'short') return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (style === 'long') return `${MONTHS_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
export function nextMonth(ym, n = 1) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function daysInMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }

/** HTML-escape anything that came from a statement or the user. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function plural(n, one, many = one + 's') { return `${n.toLocaleString(LOCALE)} ${n === 1 ? one : many}`; }
