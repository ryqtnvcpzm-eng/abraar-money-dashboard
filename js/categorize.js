// Merchant clean-up and categorization. Pure functions, shared with the Node tools.
import { TYPE_PREFIXES } from './cibc-parser.js';

const SMALL_WORDS = new Set(['and', 'of', 'the', 'de', 'du', 'des', 'la', 'le', 'les', 'et', 'a', 'au', 'en', 'for', 'on', 'to']);
const KEEP_UPPER = new Set(['STM', 'IGA', 'SAQ', 'SAAQ', 'RAMQ', 'IRCC', 'CRA', 'CIBC', 'RBC', 'TD', 'BMO', 'KFC', 'H&M', 'A&W', 'JR', 'UPS', 'USA', 'IKEA', 'ABM', 'ATM', 'GST', 'HST', 'TFSA', 'RRSP', 'NSF', 'DQ', 'BP', 'CN', 'VIA', 'PC']);
const PROVINCES = 'QC|ON|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU|CA|CAN|CANADA|US|USA|JP|JPN|FR';
const CITIES = 'MONTREAL|MONTRÉAL|MTL|LAVAL|LONGUEUIL|BROSSARD|TORONTO|OTTAWA|GATINEAU|QUEBEC|VANCOUVER|CALGARY|ST-LAURENT|SAINT-LAURENT|VERDUN|WESTMOUNT|OUTREMONT|LASALLE|ANJOU|DORVAL|POINTE-CLAIRE|TOKYO|OSAKA|KYOTO|NEW YORK';

/**
 * Remove anything that could identify an account or card: masked card numbers,
 * long reference/account numbers, "acct"/"transit" fragments. Applied before
 * anything is stored.
 */
export function sanitizeDescription(s) {
  return String(s || '')
    .replace(/\b\d{4}[*xX•#]{3,}\d{0,4}\b/g, ' ')
    .replace(/[*xX•]{4,}\d{2,4}\b/g, ' ')
    .replace(/\b(acct|account|compte|transit|branch|succursale|card|carte)\b\s*(no\.?|number|#)?\s*[:#]?\s*[\d\- ]{3,}/gi, ' ')
    .replace(/\b\d{2,5}-\d{3,}\b/g, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    // Alphanumeric terminal/reference codes such as 3JM0QY020000 or R6846617 (7+ chars, 3+ digits, letters)
    .replace(/\b(?=[A-Z0-9]*[A-Z])(?=(?:[A-Z]*\d){3})[A-Z0-9]{7,}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PREFIX_RE = new RegExp('^(?:' + TYPE_PREFIXES.map((p) => p.replace(/[-]/g, '[- ]?').replace(/\s+/g, '\\s*')).join('|') + ')\\b[\\s:-]*', 'i');

function titleCase(s) {
  return s
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((w, i) => {
      if (!w.trim() || w === '-' || w === '/') return w;
      if (KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('')
    .replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase())
    .replace(/'S\b/g, "'s")
    .replace(/’S\b/g, '’s');
}

/** "VISA DEBIT RETAIL PURCHASE DOLLARAMA #123 MONTREAL QC" -> "Dollarama" */
export function cleanName(description) {
  let s = sanitizeDescription(description).toUpperCase();
  const typeOnly = s;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(PREFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  const truncated = s.trim().length >= 14 && s.trim().length <= 15; // CIBC cuts merchant names at 15 characters
  s = s
    // Foreign-currency purchases end with "5000 JPY @ 0." / "1.39 CAD @ 1."
    .replace(/\s+(?:[\d.,]+\s*)?[A-Z]{3}\s*@\s*[\d.]*\s*$/, '')
    // Payment processors that put the merchant after them: "SQ *CAFE", "IC* INSTACART", "LS Time Out"
    .replace(/^(SQ|TST|SP|PP|PAYPAL|GOOGLE|FS|IC|CKO|DD|ZTL|PY|VESTA)\s?\*\s?/i, '')
    .replace(/^LS\s+/, '')
    // "DISCORD* TEMPOR", "LYFT *TEMP AU": the merchant is before the asterisk
    .replace(/^([A-Z0-9&'. -]{3,}?)\s?\*.*$/, '$1')
    .replace(/\s?\*\s?/g, ' ')
    // CIBC cuts names at 15 characters: drop a dangling "(…" fragment
    .replace(/\s*\([^)]*$/, '')
    .replace(/#\s?\w*/g, ' ')
    .replace(/\b(NO|STORE|MAGASIN|SUCC)\.?\s?\d+\b/g, ' ')
    .replace(new RegExp(`\\b(${CITIES})\\b`, 'g'), ' ')
    .replace(new RegExp(`\\s(${PROVINCES})\\s*$`), ' ')
    .replace(/\b\d{1,4}\b\s*$/g, ' ')
    .replace(/\b(INC|LTD|LTEE|LTÉE|CORP|CO|LLC|ENR|S\.?E\.?N\.?C\.?)\b\.?/g, ' ')
    .replace(/\b(WWW\.|HTTPS?:\/\/)/g, '')
    .replace(/\.(COM|CA|NET)\b(\/\S*)?/g, (m, tld) => (tld === 'COM' || tld === 'CA' ? '' : m))
    .replace(/[_|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-–,.:;]+$/, '')
    .trim();
  if (truncated && s.includes(' ')) {
    // Drop the half-word CIBC's cut left behind ("NIKE CANADA MAR" -> "NIKE CANADA"), then trailing joiners.
    const words = s.split(' ');
    const last = words[words.length - 1];
    if (last.length <= 3 && !KEEP_UPPER.has(last)) words.pop();
    while (words.length > 1 && (SMALL_WORDS.has(words[words.length - 1].toLowerCase()) || /^[-–&]$/.test(words[words.length - 1]))) words.pop();
    s = words.join(' ');
  }
  if (!s) {
    // Only a transaction type (e.g. "SERVICE CHARGE"): use the type itself.
    const m = PREFIX_RE.exec(typeOnly);
    s = (m ? m[0] : typeOnly).replace(/[\s:-]+$/, '');
  }
  return titleCase(s).slice(0, 48) || 'Unknown';
}

/** Compile rules.json into something fast to apply. */
export function compileRules(doc) {
  const cats = new Map(doc.categories.map((c) => [c.id, c]));
  const rules = doc.rules.map((r) => ({ ...r, re: new RegExp(r.pattern, 'i') }));
  return { cats, categories: doc.categories, rules, planTemplate: doc.planTemplate };
}

/**
 * Decide { name, category } for one transaction.
 * Priority: a locked manual choice > a saved merchant rule (by clean name) > rules.json > fallback.
 */
export function categorize(txn, compiled, userRules = []) {
  const desc = txn.merchant || '';
  const rule = compiled.rules.find((r) => r.re.test(desc));
  const name = rule?.name || cleanName(desc);
  if (txn.locked && txn.category && compiled.cats.has(txn.category)) return { name: txn.name || name, category: txn.category };

  const user = userRules.find((u) => u.name.toLowerCase() === name.toLowerCase() && (u.sign == null || u.sign === Math.sign(txn.amount)));
  if (user && compiled.cats.has(user.category)) return { name, category: user.category };

  let category;
  if (rule) {
    category = txn.amount > 0 && rule.in ? rule.in : rule.category;
  } else {
    category = txn.amount > 0 ? 'transfer_in' : 'other';
  }
  // Money in that matched an income rule while negative (e.g. a payroll correction) stays where it is;
  // money in that matched a spending merchant is a refund and reduces that category.
  return { name, category };
}

/** Rule key for "apply to all from this merchant": same clean name, same direction of money. */
export function userRuleFor(txn, category) {
  return { name: txn.name, category, sign: Math.sign(txn.amount) || -1, createdAt: new Date().toISOString() };
}
