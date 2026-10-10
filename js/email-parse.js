// Reading bank alert emails: "You made a $12.50 purchase at Tim Hortons on Oct 3 with your Visa".
// Pure functions shared by the app and the tests. Everything runs on this device.
//
// It reads an email the way a person skims one: decide whether it's about money that moved (and not an
// ad, a one-time code or a "your statement is ready" note), find the sentence or table row that says
// how much, then pull out where, when and which way the money went. Each answer gets a confidence, so
// the unsure ones can be checked before they're added. Card and account numbers are never kept.
import { findDates, isoDate, validDate } from './parse-util.js';
import { cleanName, sanitizeDescription } from './categorize.js';
import { addDays, daysBetween, iso } from './format.js';

// ---------------------------------------------------------------------------
// Email files (.eml) and Gmail messages → { from, subject, date, text }
// ---------------------------------------------------------------------------

const CHARSETS = { 'us-ascii': 'utf-8', ascii: 'utf-8', latin1: 'iso-8859-1', 'iso-8859-1': 'windows-1252' };
function decodeBytes(bytes, charset = 'utf-8') {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/["']/g, '');
  try { return new TextDecoder(CHARSETS[cs] || cs).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}
const binaryBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
function base64Bytes(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/_-]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  try { return binaryBytes(atob(clean + '==='.slice((clean.length + 3) % 4))); } catch { return new Uint8Array(); }
}
function qpBytes(s) {
  const out = [];
  const t = String(s).replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else out.push(t.charCodeAt(i) & 255);
  }
  return Uint8Array.from(out);
}

/** "=?UTF-8?B?...?=" and "=?utf-8?Q?...?=" header words. */
export function decodeWords(s) {
  return String(s || '')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => decodeBytes(/b/i.test(enc) ? base64Bytes(txt) : qpBytes(txt.replace(/_/g, ' ')), cs));
}

function parseHeaders(block) {
  const h = {};
  for (const line of String(block).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m && !(m[1].toLowerCase() in h)) h[m[1].toLowerCase()] = m[2].trim();
  }
  return h;
}
const param = (value, name) => (new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value || '') || [])[1] ?? (new RegExp(`${name}\\s*=\\s*([^;\\s]+)`, 'i').exec(value || '') || [])[1] ?? null;

/** Walk one MIME entity (raw is a "binary" string: one char per byte). */
function walk(raw, out, depth = 0) {
  const cut = /\r?\n\r?\n/.exec(raw);
  const head = parseHeaders(cut ? raw.slice(0, cut.index) : raw);
  const body = cut ? raw.slice(cut.index + cut[0].length) : '';
  const type = (head['content-type'] || 'text/plain').toLowerCase();
  if (depth > 8) return head;
  if (type.startsWith('multipart/')) {
    const b = param(head['content-type'], 'boundary');
    if (b) for (const part of body.split(`--${b}`).slice(1)) { if (part.startsWith('--')) break; walk(part.replace(/^\r?\n/, ''), out, depth + 1); }
    return head;
  }
  if (type.startsWith('message/rfc822')) {
    // Forwarded as an attachment: the email inside is the one that matters.
    const inner = walk(body, out, depth + 1);
    out.inner ||= inner;
    return head;
  }
  if (/attachment/i.test(head['content-disposition'] || '') || !/^text\/(plain|html)/.test(type)) return head;
  const cte = (head['content-transfer-encoding'] || '').toLowerCase();
  const bytes = cte === 'base64' ? base64Bytes(body) : cte === 'quoted-printable' ? qpBytes(body) : binaryBytes(body);
  const text = decodeBytes(bytes, param(head['content-type'], 'charset'));
  if (type.startsWith('text/html')) out.html ??= text; else out.text ??= text;
  return head;
}

/** A .eml file (as bytes or a binary string) → { from, subject, date, text }. */
export function parseEml(input) {
  const raw = typeof input === 'string' ? input : Array.from(input instanceof Uint8Array ? input : new Uint8Array(input), (b) => String.fromCharCode(b)).join('');
  const out = {};
  const head = walk(raw, out);
  const h = out.inner?.from ? out.inner : head;
  return finish({ from: decodeWords(h.from), subject: decodeWords(h.subject), date: h.date || '', id: h['message-id'] || '', text: out.text, html: out.html });
}

/** A Gmail API message (format=full) → { from, subject, date, text }. */
export function fromGmail(msg) {
  const out = {};
  const header = (p, name) => (p.headers || []).find((x) => x.name.toLowerCase() === name)?.value || '';
  const visit = (p, depth = 0) => {
    if (!p || depth > 8) return;
    const type = (p.mimeType || '').toLowerCase();
    if (p.parts?.length) { for (const c of p.parts) visit(c, depth + 1); return; }
    if (p.filename || !p.body?.data || !/^text\/(plain|html)/.test(type)) return;
    const text = decodeBytes(base64Bytes(p.body.data), param(header(p, 'content-type'), 'charset'));
    if (type === 'text/html') out.html ??= text; else out.text ??= text;
  };
  visit(msg.payload);
  const top = msg.payload || {};
  const date = header(top, 'date') || (msg.internalDate ? new Date(Number(msg.internalDate)).toUTCString() : '');
  return finish({ from: header(top, 'from'), subject: header(top, 'subject'), date, id: msg.id || header(top, 'message-id'), text: out.text, html: out.html });
}

function finish(m) {
  // Banks often send an HTML part and a stub text part ("view this email in a browser"): use the fuller one.
  const html = m.html ? htmlToText(m.html) : '';
  const text = m.text ? tidy(m.text) : '';
  return { from: m.from || '', subject: m.subject || '', date: m.date || '', id: m.id || '', text: html.length > text.length * 1.2 || !text ? html : text };
}

// ---------------------------------------------------------------------------
// HTML → text that keeps table rows together ("Merchant | Tim Hortons")
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', dollar: '$', euro: '€', pound: '£', yen: '¥', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', zwnj: '', zwj: '', shy: '' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    const v = ENTITIES[e.toLowerCase()];
    return v == null ? m : v;
  });
}
function tidy(s) {
  return String(s)
    .replace(/[​-‍⁠﻿­͏]/g, '')
    .replace(/[\u00a0\u2007\u202f\t]/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .split(/\r?\n/).map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export function htmlToText(html) {
  const s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|header|footer|blockquote|center)\s*>/gi, '\n')
    .replace(/<(p|div|tr|li|h[1-6]|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t\u00a0]*\|[ \t\u00a0|]*(?=\n|$)/g, '');
  return tidy(decodeEntities(s).split('\n').map((l) => l.replace(/^[\s|]+/, '').replace(/(\s*\|\s*)+/g, ' | ')).join('\n'));
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

// Who sends money alerts (domain → name). Anything else still counts if the email reads like one.
const BANKS = [
  ['cibc.com', 'CIBC'], ['cibc.ca', 'CIBC'], ['td.com', 'TD'], ['tdbank.com', 'TD'], ['rbc.com', 'RBC'], ['rbcroyalbank.com', 'RBC'],
  ['scotiabank.com', 'Scotiabank'], ['bmo.com', 'BMO'], ['nbc.ca', 'National Bank'], ['bnc.ca', 'National Bank'], ['tangerine.ca', 'Tangerine'],
  ['simplii.com', 'Simplii'], ['desjardins.com', 'Desjardins'], ['interac.ca', 'Interac'], ['eqbank.ca', 'EQ Bank'], ['pcfinancial.ca', 'PC Financial'],
  ['neofinancial.com', 'Neo'], ['koho.ca', 'KOHO'], ['wealthsimple.com', 'Wealthsimple'], ['rogersbank.com', 'Rogers Bank'], ['mbna.ca', 'MBNA'],
  ['atb.com', 'ATB'], ['hsbc.ca', 'HSBC'], ['americanexpress.com', 'American Express'], ['aexp.com', 'American Express'], ['welcome.aexp.com', 'American Express'],
  ['capitalone.com', 'Capital One'], ['chase.com', 'Chase'], ['bankofamerica.com', 'Bank of America'], ['wellsfargo.com', 'Wells Fargo'],
  ['citi.com', 'Citi'], ['citibank.com', 'Citi'], ['discover.com', 'Discover'], ['usbank.com', 'U.S. Bank'], ['pnc.com', 'PNC'], ['ally.com', 'Ally'],
  ['sofi.com', 'SoFi'], ['chime.com', 'Chime'], ['venmo.com', 'Venmo'], ['cash.app', 'Cash App'], ['square.com', 'Cash App'], ['paypal.com', 'PayPal'],
  ['monzo.com', 'Monzo'], ['revolut.com', 'Revolut'], ['wise.com', 'Wise'], ['starlingbank.com', 'Starling'], ['barclays.co.uk', 'Barclays'],
  ['barclaycard.co.uk', 'Barclaycard'], ['natwest.com', 'NatWest'], ['lloydsbank.co.uk', 'Lloyds'], ['halifax.co.uk', 'Halifax'], ['hsbc.co.uk', 'HSBC'],
  ['santander.co.uk', 'Santander'], ['nationwide.co.uk', 'Nationwide'], ['hsbc.com', 'HSBC'], ['commbank.com.au', 'CommBank'], ['anz.com', 'ANZ'],
  ['westpac.com.au', 'Westpac'], ['nab.com.au', 'NAB'], ['hdfcbank.net', 'HDFC Bank'], ['hdfcbank.com', 'HDFC Bank'], ['icicibank.com', 'ICICI Bank'],
  ['axisbank.com', 'Axis Bank'], ['sbi.co.in', 'SBI'], ['kotak.com', 'Kotak'], ['n26.com', 'N26'], ['ing.com', 'ING'],
];
function senderOf(from) {
  const addr = (/<([^>]+)>/.exec(from) || [, from])[1].trim().toLowerCase();
  const domain = addr.split('@')[1] || '';
  const known = BANKS.find(([d]) => domain === d || domain.endsWith(`.${d}`));
  const display = String(from).replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  return {
    bank: known ? known[1] : display.replace(/\b(alerts?|notifications?|notify|no-?reply|service|customer|online|banking|e-?mail|team)\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 30) || null,
    known: !!known,
    alerty: /\b(alert|notif|notify|transaction|security)/i.test(addr + ' ' + display),
  };
}

const CUR = String.raw`(?:CA\$|C\$|US\$|A\$|NZ\$|HK\$|S\$|R\$|CDN\$|\$|£|€|¥|₹|Rs\.?|INR|CAD|USD|EUR|GBP|AUD|NZD|CHF|MXN|JPY)`;
// "1,234.56" · "1.234,56" / "1 234,56" · "12,50" · "1 234.56" · "45" / "45.00". A plain number never stops just before ",5".
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?(?![\d,])|\d{1,3}(?:[.\u00a0 ]\d{3})+,\d{2}(?!\d)|\d+,\d{2}(?![\d,])|\d{1,3}(?:[\u00a0 ]\d{3})+(?:\.\d{1,2})?(?![\d,])|\d+(?:\.\d{1,2})?(?![\d,]|\.\d)`;
// "$1,234.56", "CAD 45.00", "45.00 USD", "Rs.499", "€12,50"
const AMOUNT = new RegExp(String.raw`(?:(${CUR})\s?([-−]?)\s?(${NUMBER})(?:\s?(CAD|USD|EUR|GBP|AUD|INR))?|(?<![\w.,])(${NUMBER})\s?(CAD|USD|EUR|GBP|AUD|INR|\$|€|£)(?![A-Za-z]))`, 'g');

function readAmount(m) {
  const sym = m[1] || m[6] || '';
  let n = m[3] || m[5];
  // A comma before the last two digits is the decimal point when no comma groups thousands.
  if (/,\d{2}$/.test(n) && !/,\d{3}/.test(n)) n = n.replace(/[.\u00a0 ]/g, '').replace(',', '.');
  else n = n.replace(/[,\u00a0 ]/g, '');
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0 || v > 1e7) return null;
  const code = m[4] || ({ '$': null, 'CA$': 'CAD', 'C$': 'CAD', 'CDN$': 'CAD', 'US$': 'USD', 'A$': 'AUD', 'NZ$': 'NZD', 'HK$': 'HKD', 'S$': 'SGD', 'R$': 'BRL', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR', 'Rs': 'INR', 'Rs.': 'INR' }[sym] ?? (/^[A-Z]{3}$/.test(sym) ? sym : null));
  return { value: v, currency: code, minus: !!m[2] };
}

// What money did. Order matters: the first group that matches decides the direction.
const INWARD = /\b(refund(?:ed)?|reversal|reversed|credited|cash ?back|deposit(?:ed)?|direct deposit|sent you|you(?:'ve| have)? received|received (?:an? )?(?:interac )?e-?transfer|has been (?:deposited|credited)|autodeposit(?:ed)?|money (?:is )?in|payment (?:has been |was )?received|received your payment|we(?:'ve| have)? received your payment|thank you for your payment|salary|payroll|paid you)\b/i;
const OUTWARD = /\b(purchase[ds]?|spent|spend|charged?|charges|withdrawal|withdrawn|withdrew|debited|debit|paid|payment|sent|transfer(?:red)? to|e-?transfer|bill pay(?:ment)?|pre-?authori[sz]ed|authori[sz]ation|authori[sz]ed|transaction|bought|card was used|used your card|money out)\b/i;
const TXN_WORDS = new RegExp(`${INWARD.source}|${OUTWARD.source}`, 'i');

// Emails that mention money but aren't a transaction.
const NOT_TXN = [
  ['code', /\b(verification|security|one[- ]time|login|sign[- ]in|authentication|confirmation) (code|passcode|pin)\b|\bOTP\b|\bpasscode\b/i],
  ['declined', /\b(was|has been|were) declined\b|\bdeclined (transaction|purchase)\b|\btransaction declined\b/i],
  ['statement', /\b(e-?statement|statement) (is|are) (now )?(ready|available)\b|\byour (new |latest )?(e-?)?statement\b|\bview your statement\b/i],
  ['reminder', /\b(payment|bill) (is )?(due|reminder)\b|\bminimum payment\b|\bdue date\b|\bpayment due\b|\bupcoming (payment|bill|withdrawal)\b|\bscheduled (payment|transfer)\b(?![\s\S]{0,40}\b(was|has been) (sent|processed|completed)\b)/i],
  ['balance', /\b(available |account |current |low |daily )?balance (is|alert|has|fell|dropped|went|below|above|update|summary)\b|\bbalance of\b|\blow balance\b/i],
  ['security', /\b(password|security question|new device|signed in|sign-in|unusual sign|profile|contact information|email address) (was |has been )?(changed|updated|added|detected|reset)\b/i],
  ['order', /\b(has shipped|was shipped|out for delivery|was delivered|has been delivered|track (your )?package|your order (has|is)|order confirmation|shipping confirmation)\b/i],
  ['promo', /\b(\d+% off|limited[- ]time|special offer|exclusive offer|pre-?approved|apply now|earn up to|bonus points|sale ends|shop now|win a|sweepstakes|refer a friend|introducing)\b/i],
];
// Promo words alone aren't enough to drop an email: a real alert can carry an ad in the footer.
const STRONG_TXN = /\b(you (made|have made) a|a (purchase|transaction|charge|withdrawal|payment|debit) (of|for)|(was|has been) (charged|debited|withdrawn|spent|authori[sz]ed|approved|made|posted|sent|deposited|credited|refunded)|you(?:'ve| have)? (spent|sent|paid|received)|sent you|transaction alert|purchase alert|spend(ing)? alert|withdrawal alert|deposit alert|charged to your|(card|account) (was|has been) used|used your card)\b/i;
const RECEIPT = /\b(subtotal|sub-total|order (number|#|no\.?)|items? ordered|qty|quantity|shipping (address|&|and handling)|estimated tax|your receipt)\b/i;

const LABELS = {
  merchant: /^(merchant(?: name)?|where|at|retailer|store|vendor|payee(?: name)?|paid to|recipient(?: name)?|sent to|to|description|transaction description|details|merchant\/description|location|merchant location)$/i,
  from: /^(from|sender(?: name)?|sent by|deposited from)$/i,
  amount: /^((transaction |purchase |charge |payment |transfer |withdrawal |deposit )?amount|amount (charged|spent|paid|sent|received|debited|credited)|total|amount \(\w+\))$/i,
  date: /^((transaction |purchase |posted |posting |payment |transfer )?date|date (and|&) time|when|date of (transaction|purchase)|transaction date and time|time)$/i,
  type: /^((transaction|payment) type|type)$/i,
};
const BAD_MERCHANT = /^(?:a\/c|acc(?:oun)?t|your|you|the|this|that|our|a|an|it|us|we|account|card|chequing|checking|savings|visa|mastercard|master card|amex|debit|credit|bank|online|mobile|app|an? (?:atm|merchant|store))(?=\s|$)|^(?:\d|https?:)|\b(account|card) (ending|number|no)\b|\bending (in|with)\b|^[\W\d]+$/i;

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

function mailDay(date, today) {
  const d = date ? new Date(date) : null;
  return d && !Number.isNaN(d.getTime()) ? iso(d) : today;
}

/** A short, stable id for an email (FNV-1a), so the same alert is never added twice. */
export function mailKey(m) {
  const s = m.id ? String(m.id) : `${m.from}|${m.subject}|${m.date}|${String(m.text).slice(0, 400)}`;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return h1.toString(36) + h2.toString(36);
}

/** "---------- Forwarded message ---------" blocks: the forwarded email's own sender, date and subject. */
function unforward(msg) {
  const t = msg.text || '';
  const fw = /(?:^|\n)[-_ ]{0,40}(?:forwarded message|original message|begin forwarded message)[ \t:-]{0,40}\n/i.exec(t);
  if (!fw) return msg;
  const rest = t.slice(fw.index + fw[0].length);
  const lines = rest.split('\n');
  const head = {};
  let i = 0;
  for (; i < Math.min(lines.length, 12); i++) {
    const m = /^\**\s*(from|date|sent|subject|to|cc)\s*:\**\s*(.*)$/i.exec(lines[i]);
    if (m) head[m[1].toLowerCase()] = m[2].trim();
    else if (lines[i].trim() && Object.keys(head).length) break;
  }
  return { ...msg, from: head.from || msg.from, subject: head.subject || msg.subject, date: head.date || head.sent || msg.date, text: lines.slice(i).join('\n').trim() };
}

/** A text email with no headers (pasted) may start with them anyway: "From: …", "Subject: …". */
function pastedHeaders(msg) {
  if (msg.from || msg.subject) return msg;
  const lines = String(msg.text).split('\n');
  const head = {};
  let i = 0;
  for (; i < Math.min(lines.length, 10); i++) {
    const m = /^(from|date|sent|subject|to)\s*:\s*(.*)$/i.exec(lines[i]);
    if (m) head[m[1].toLowerCase()] = m[2].trim();
    else if (lines[i].trim()) break;
  }
  if (!Object.keys(head).length) return msg;
  return { ...msg, from: head.from || '', subject: head.subject || '', date: head.date || head.sent || '', text: lines.slice(i).join('\n').trim() };
}

/** Label/value pairs from "Label: value", "Label | value" rows and labels stacked over their values. */
function fields(lines) {
  const out = {};
  const put = (k, v, i) => { if (v && !(k in out)) out[k] = { value: v.trim(), line: i }; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z][A-Za-z /&()]{1,40}?)\s*(?::|\|)\s*(.+)$/.exec(line);
    const key = (m ? m[1] : line.replace(/[:|]\s*$/, '')).trim();
    for (const [k, re] of Object.entries(LABELS)) {
      if (!re.test(key)) continue;
      if (m) put(k, m[2].split(' | ')[0], i);
      else if (/[:|]\s*$/.test(line) || line.length < 40) {
        const j = lines.findIndex((l, n) => n > i && l.trim());
        const next = j > 0 ? lines[j] : null;
        if (next && !Object.values(LABELS).some((r) => r.test(next.replace(/[:|]\s*$/, '').trim()))) put(k, next.split(' | ')[0], j);
      }
      break;
    }
  }
  return out;
}

/** Where the money went, from the words after the amount: "… at TIM HORTONS #123 on Oct 3 with your card". */
function merchantNear(sentence, from) {
  // UPI alerts name a payment address before the payee: "to VPA shop@bank SHOP".
  const tail = sentence.slice(from, from + 160).replace(/\bVPA\s+\S+@\S+\s*/gi, '').replace(AMOUNT, ' | ');
  const PREP = /\b(at|with|to|from|by|for)\s+(?!your\b|you\b|the account\b|an? (?:atm|account)\b|a\/c\b|acc(?:oun)?t\b)/gi;
  let pre;
  while ((pre = PREP.exec(tail))) {
    let s = tail.slice(pre.index + pre[0].length).split(/\s+(?:on|using|via|by|with your|was|has|have|is|in the amount|from your|to your|into your|ending|through|for your|for the|for a|at \d|at the time|as of|today|yesterday|this|has been|with|card)\b|\s[-–—]\s|[.,;!|](?:\s|$)|\s\(|\n/i)[0];
    s = s.trim().replace(/[.,;:!]+$/, '').replace(/\s+(?:for|of|in|at|to|with)$/i, '').trim();
    if (s && !BAD_MERCHANT.test(s) && s.length >= 2 && s.length <= 60 && /\p{L}/u.test(s)) return { name: s, prep: pre[1].toLowerCase() };
  }
  return null;
}

/** Words that could be part of a card or account number: "x1234", "(1234)", "4512-34XX", "7890". */
const NUMBERISH = (w) => (w.match(/\d/g) || []).length >= 3 || (/\d{2}/.test(w) && /[x*•#]/i.test(w)) || /^[(\[]?[x*•#]+\d+[)\]]?$/i.test(w) || /^\(\d+\)$/.test(w);
function cleanMerchant(raw) {
  const cut = String(raw)
    .replace(/\s*\b(?:in|at) [A-Z][a-z]+,? [A-Z]{2}\b.*$/, '')
    .replace(/\s+(?:with|using|on)\s+(?:your\s+)?(?:visa|mastercard|amex|card|debit|credit)\b.*$/i, '');
  const s = sanitizeDescription(cut.split(/\s+/).filter((w) => !NUMBERISH(w)).join(' '));
  if (!s || BAD_MERCHANT.test(s)) return null;
  const name = cleanName(s).split(' ').filter((w) => !NUMBERISH(w)).join(' ').trim();
  return name && name !== 'Unknown' && !BAD_MERCHANT.test(name) ? name : null;
}

/** A date written in the email near the amount, read against the day the email was sent. */
function dateFrom(text, sent) {
  const found = [];
  for (const d of findDates(text)) {
    const opts = d.ambiguous ? [[d.b, d.a], [d.a, d.b]] : [[d.m, d.d]];
    for (const [mo, day] of opts) {
      let y = d.y ?? Number(sent.slice(0, 4));
      if (!validDate(y, mo, day)) continue;
      let s = isoDate(y, mo, day);
      if (d.y == null && s > addDays(sent, 1)) { y -= 1; if (!validDate(y, mo, day)) continue; s = isoDate(y, mo, day); }
      const gap = daysBetween(s, sent);
      if (gap >= -1 && gap <= 45) found.push({ s, gap, index: d.index });
    }
  }
  found.sort((a, b) => a.index - b.index || a.gap - b.gap);
  return found[0]?.s || null;
}

function accountKind(text) {
  if (/\b(visa debit|debit card|debit mastercard|chequing|checking|savings|bank account|interac|e-?transfer|direct deposit|atm|pre-?authori[sz]ed debit|account ending)\b/i.test(text)) return 'bank';
  if (/\b(credit card|visa|mastercard|amex|american express|card ?member|credit limit|available credit)\b/i.test(text)) return 'card';
  return /\bcard\b/i.test(text) ? 'card' : 'bank';
}

/**
 * Read one email. msg: { from, subject, date, text }. Returns either
 *   { ok: true, key, date, amount (money out negative), currency, merchant, kind, account, bank, confidence: 'high' | 'check', score }
 * or { ok: false, key, reason }.
 */
export function parseAlert(input, { today = iso(new Date()) } = {}) {
  // Alerts are short; a long email is read only as far as its first 20,000 characters.
  const msg = unforward(pastedHeaders({ from: '', subject: '', date: '', ...input, text: tidy(String(input.text || '').slice(0, 60000)).slice(0, 20000) }));
  const key = input.key || mailKey(input);
  const sender = senderOf(msg.from);
  const subject = String(msg.subject || '').trim();
  const body = msg.text;
  const all = `${subject}\n${body}`;
  const no = (reason) => ({ ok: false, key, reason, bank: sender.bank });
  const sent = ((d) => (d > today ? today : d))(mailDay(msg.date, today));

  // 1. Is it about money that moved? A table with an amount and a merchant or date counts as saying so.
  const lines = all.split('\n').filter((l) => l.trim());
  const f = fields(lines);
  const strong = STRONG_TXN.test(all) || !!(f.amount && (f.merchant || f.date) && sender.known);
  for (const [reason, re] of NOT_TXN) {
    if (!re.test(all)) continue;
    if (reason === 'declined' || reason === 'code') return no(reason);
    if (reason === 'promo' && strong) continue;
    if (reason === 'balance' && strong) continue;
    if (reason === 'reminder' && strong && !/\bminimum payment\b|\bpayment (is )?due\b/i.test(all)) continue;
    return no(reason);
  }
  if (RECEIPT.test(all) && !strong) return no('receipt');

  // 2. Every amount, scored by the words around it.
  const cands = [];
  lines.forEach((line, li) => {
    // Sentences inside the line (a full stop before a capital or the end, not "$4.50" or "Inc.").
    const parts = line.split(/(?<=[a-z0-9)][.!?])\s+(?=[A-Z])/);
    let offset = 0;
    for (const sentence of parts) {
      AMOUNT.lastIndex = 0;
      const words = (TXN_WORDS.test(sentence) ? 3 : 0) + (STRONG_TXN.test(sentence) ? 2 : 0);
      let m;
      while ((m = AMOUNT.exec(sentence))) {
        const a = readAmount(m);
        if (!a) continue;
        const before = sentence.slice(Math.max(0, m.index - 40), m.index);
        const after = sentence.slice(m.index + m[0].length, m.index + m[0].length + 40);
        let score = words;
        if (f.amount && f.amount.line === li) score += 4;
        if (li === 0 && subject) score += 1; // the subject line
        if (/\b(balance|available|limit|credit available|minimum|points|rewards?|fee waived|up to|save|earn|over|exceed(?:s|ing|ed)?|threshold|more than|greater than|above)\s*(?:is|of|:)?\s*$/i.test(before)) score -= 6;
        if (/^\s*(or more|and above|threshold|limit)/i.test(after)) score -= 6;
        if (/\b(fee|interest)\b/i.test(before) && !/\b(charged|paid)\b/i.test(sentence)) score -= 1;
        cands.push({ ...a, score, sentence, start: m.index, at: m.index + m[0].length, line: li, index: offset + m.index });
      }
      offset += sentence.length + 1;
    }
  });
  if (!cands.length) return no('no amount');
  cands.sort((x, y) => y.score - x.score || x.line - y.line || x.index - y.index);
  const best = cands[0];
  if (best.score < 3) return no('no transaction');

  // 3. Which way, and what kind.
  const sentence = best.sentence;
  const typeText = `${f.type?.value || ''} ${sentence} ${subject}`;
  const inward = INWARD.test(typeText) && !/\byou(?:'ve| have)? (?:sent|paid)\b|\bsent (?:an? )?(?:interac )?e-?transfer to\b|\b(?:money |e-?)?transfer to\b|\bsent to\b|\bpayment to\b/i.test(`${sentence} ${subject}`);
  let kind = /refund|reversal|reversed|cash ?back/i.test(typeText) ? 'refund'
    : /e-?transfer|sent you|you(?:'ve| have)? sent|transfer/i.test(typeText) ? 'transfer'
      : /withdrawal|withdrawn|withdrew|\batm\b/i.test(typeText) ? 'withdrawal'
        : /deposit|salary|payroll/i.test(typeText) ? 'deposit'
          : /payment (?:has been |was )?received|received your payment|thank you for your payment|bill pay|pre-?authori[sz]ed debit/i.test(typeText) ? 'payment'
            : 'purchase';
  if (kind === 'purchase' && inward) kind = 'deposit';

  // 4. Where.
  let merchant = null;
  const label = inward ? (f.from || f.merchant) : (f.merchant || null);
  if (label && !/^(your|you)\b/i.test(label.value)) merchant = label.value;
  if (!merchant) {
    const sentBy = /(?:^|:\s*|\.\s+)([A-Z][\p{L}&.'’ -]{1,48}?)\s+(?:has\s+)?(?:sent you|paid you)\b/u.exec(sentence) || /(?:^|:\s*)([A-Z][\p{L}&.'’ -]{1,48}?)\s+(?:has\s+)?(?:sent you|paid you)\b/u.exec(subject);
    if (sentBy && !BAD_MERCHANT.test(sentBy[1].trim())) merchant = sentBy[1].trim();
  }
  if (!merchant) {
    // "You paid Chris Lee $15.00", "You sent Sam $20"
    const paid = /\b(?:paid|sent|pay)\s+([A-Z][\p{L}&.'’ -]{1,40}?)\s*$/u.exec(sentence.slice(0, best.start));
    if (paid && !BAD_MERCHANT.test(paid[1])) merchant = paid[1];
  }
  if (!merchant) {
    const near = merchantNear(sentence, best.at) || merchantNear(sentence, 0);
    if (near && !(inward && near.prep === 'to')) merchant = near.name;
  }
  if (!merchant) {
    // "TIM HORTONS charged $4.50 to your card" / "Starbucks: $5.25"
    const lead = /^([A-Z][\p{L}0-9&.'’* -]{2,40}?)\s+(?:charged|billed)\b/u.exec(sentence);
    if (lead && !BAD_MERCHANT.test(lead[1])) merchant = lead[1];
  }
  if (!merchant) {
    // Subject like "Your $45.67 transaction with STARBUCKS" or "Purchase at UBER EATS".
    for (const c of cands.filter((c) => c.line === 0)) { const near = merchantNear(c.sentence, c.at); if (near) { merchant = near.name; break; } }
  }
  const name = merchant ? cleanMerchant(merchant) : null;

  // 5. When.
  let date = null;
  if (f.date) date = dateFrom(f.date.value, sent);
  if (!date) { const on = /\b(?:on|dated?)\s+(.{4,40})/i.exec(sentence.slice(best.at)); if (on) date = dateFrom(on[1], sent); }
  if (!date) date = dateFrom(sentence, sent);
  for (const c of cands) { if (date) break; if (c !== best && Math.abs(c.value - best.value) < 0.005) date = dateFrom(c.sentence.slice(Math.max(0, c.at - 80)), sent); }
  if (!date) {
    const days = new Set(lines.map((l) => dateFrom(l, sent)).filter(Boolean));
    if (days.size === 1) date = [...days][0];
  }
  if (!date || date > today) date = sent;

  // 6. How sure.
  let score = best.score;
  if (sender.known) score += 3; else if (sender.alerty) score += 1;
  if (name) score += 2;
  if (f.amount || f.merchant) score += 1;
  if (!sender.known && !sender.alerty && !/\b(your (card|account)|card ending|account ending|interac|e-?transfer|visa|mastercard|amex)\b/i.test(all)) score -= 3;
  if (score < 4) return no('not sure');
  const confidence = score >= 9 && name && cands.filter((c) => c.score >= best.score - 1 && Math.abs(c.value - best.value) > 0.004).length === 0 ? 'high' : 'check';

  const cents = Math.round(best.value * 100);
  return {
    ok: true, key, date, amount: (inward ? cents : -cents) / 100, currency: best.currency, merchant: name,
    kind, account: accountKind(all), bank: sender.bank, confidence, score,
  };
}

/** Group label for a parsed alert: which bank and which kind of account it came from. */
export function sourceOf(p) {
  return `${p.bank || 'Email'} · ${p.account === 'card' ? 'Credit card' : 'Bank account'}`;
}

/** Words for a parsed alert that has no merchant ("Transfer", "Deposit"…). */
export const KIND_NAMES = { purchase: 'Purchase', refund: 'Refund', transfer: 'e-Transfer', withdrawal: 'Withdrawal', deposit: 'Deposit', payment: 'Payment' };

export const _test = { htmlToText, fields, merchantNear, dateFrom, senderOf, unforward };
