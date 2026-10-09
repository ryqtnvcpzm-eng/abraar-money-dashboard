// Merchant clean-up and categorization. Pure functions, shared with the Node tools.
import { TYPE_PREFIXES } from './cibc-parser.js';

const SMALL_WORDS = new Set(['and', 'of', 'the', 'de', 'du', 'des', 'la', 'le', 'les', 'et', 'a', 'au', 'en', 'for', 'on', 'to']);
const KEEP_UPPER = new Set(['STM', 'IGA', 'SAQ', 'SAAQ', 'RAMQ', 'IRCC', 'CRA', 'CIBC', 'RBC', 'TD', 'BMO', 'KFC', 'H&M', 'A&W', 'JR', 'UPS', 'USA', 'IKEA', 'ABM', 'ATM', 'GST', 'HST', 'TFSA', 'RRSP', 'NSF', 'DQ', 'BP', 'CN', 'VIA', 'PC']);
const PROVINCES = 'QC|ON|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU|CA|CAN|CANADA|US|USA|JP|JPN|FR|GB|UK|DE|ES|IT|NL|AU|NZ|IN|SG|AE|ZA|MX|BR|AL|AK|AZ|AR|CO|CT|DE|FL|GA|HI|ID|IL|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|NSW|VIC|QLD|WA|TAS|ACT';
// Other cities: only stripped from the end of a name ("Atelier Paris" is a shop, "PRET LONDON" is Pret).
const WORLD_CITIES = 'LONDON|MANCHESTER|BIRMINGHAM|GLASGOW|EDINBURGH|DUBLIN|PARIS|LYON|MARSEILLE|BERLIN|MUNCHEN|MUENCHEN|MUNICH|HAMBURG|FRANKFURT|KOLN|ZURICH|ZÜRICH|GENEVE|GENEVA|BASEL|WIEN|VIENNA|MADRID|BARCELONA|VALENCIA|SEVILLA|LISBOA|LISBON|PORTO|ROMA|ROME|MILANO|MILAN|TORINO|NAPOLI|AMSTERDAM|ROTTERDAM|BRUXELLES|BRUSSELS|STOCKHOLM|OSLO|COPENHAGEN|KOBENHAVN|HELSINKI|WARSZAWA|PRAHA|NEW YORK|BROOKLYN|LOS ANGELES|SAN FRANCISCO|SEATTLE|CHICAGO|BOSTON|AUSTIN|HOUSTON|DALLAS|MIAMI|ATLANTA|DENVER|PHOENIX|SYDNEY|MELBOURNE|BRISBANE|PERTH|AUCKLAND|WELLINGTON|SINGAPORE|HONG KONG|SHINJUKU|SHIBUYA|GINZA|DUBAI|ABU DHABI|DOHA|RIYADH|MUMBAI|DELHI|NEW DELHI|BANGALORE|BENGALURU|HYDERABAD|CHENNAI|PUNE|KOLKATA|CAPE TOWN|JOHANNESBURG|NAIROBI|LAGOS|MEXICO|CDMX|SAO PAULO|RIO DE JANEIRO|BUENOS AIRES|SANTIAGO|BOGOTA|LIMA';
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

// Transaction-type words other banks print before the merchant (UK, US, India, Europe).
const WORLD_PREFIXES = [
  'CARD PAYMENT TO', 'CARD PAYMENT', 'CARD PURCHASE', 'DEBIT CARD PURCHASE', 'DEBIT CARD', 'POS PURCHASE', 'POS DEBIT', 'POS',
  'CONTACTLESS PAYMENT', 'DIRECT DEBIT', 'STANDING ORDER', 'BANK GIRO CREDIT', 'FASTER PAYMENT RECEIVED', 'FASTER PAYMENT', 'BILL PAYMENT TO', 'TRANSFER TO',
  'PAY', 'ACH DEBIT', 'ACH CREDIT', 'ACH DEPOSIT', 'ACH', 'CHECKCARD', 'PURCHASE AUTHORIZED ON', 'RECURRING PAYMENT', 'VISA PURCHASE', 'VISA', 'MASTERCARD', 'EFTPOS',
  'UPI', 'NEFT CR', 'NEFT DR', 'NEFT', 'IMPS', 'RTGS',
  'KARTENZAHLUNG', 'LASTSCHRIFT', 'GUTSCHRIFT', 'UBERWEISUNG', 'ÜBERWEISUNG', 'DAUERAUFTRAG', 'TWINT ZAHLUNG AN', 'TWINT',
  'PAIEMENT PAR CARTE', 'PAIEMENT CB', 'ACHAT CB', 'CB', 'PRLV SEPA', 'PRLV', 'PRELEVEMENT', 'PRÉLÈVEMENT', 'VIR SEPA', 'VIR INST RECU DE', 'VIR INST', 'VIREMENT', 'VIR', 'CARTE',
  'COMPRA CON TARJETA', 'COMPRA TARJ', 'COMPRA EN', 'COMPRA CARTAO', 'COMPRA', 'PAGO CON TARJETA', 'PAGO', 'RECIBO', 'TRANSFERENCIA', 'BIZUM ENVIADO A', 'PIX ENVIADO',
  'PAGAMENTO POS', 'PAGAMENTO', 'ADDEBITO', 'BONIFICO', 'BEA', 'BETAALAUTOMAAT', 'KORTKOP', 'KORTKÖP', 'CARD TXN', 'PURCHASE',
];
const CIBC_RE = new RegExp('^(?:' + TYPE_PREFIXES.map((p) => p.replace(/[-]/g, '[- ]?').replace(/\s+/g, '\\s*')).join('|') + ')\\b', 'i');
const PREFIX_RE = new RegExp('^(?:' + [...TYPE_PREFIXES, ...WORLD_PREFIXES].sort((a, b) => b.length - a.length).map((p) => p.replace(/[-]/g, '[- ]?').replace(/\s+/g, '\\s*')).join('|') + ')\\b\\.?[\\s:/-]*(?:\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?\\s+|\\d{4}\\s+(?=[A-Z]))?', 'i');

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
  // CSV exports join several columns with " · ", payee first: name after the first part that has letters.
  const parts = String(description).split(' · ').filter((p) => /\p{L}{2}/u.test(p));
  if (parts.length > 1) description = parts[0];
  // UPI: "UPI/412345678901/SWIGGY/swiggy@icici" or "UPI-BIGBASKET-BIGBASKET@YBL": the merchant is the named part.
  const upi = /^UPI[/-](?:\d+[/-])?([^/@-]+)/i.exec(String(description).trim());
  if (upi) description = upi[1];
  // CIBC cuts merchant names at 15 characters; only trim half-words for descriptions in its format.
  const cibcStyle = CIBC_RE.test(String(description).trim());
  let s = sanitizeDescription(description).toUpperCase()
    .replace(/\bMCC\s*[:#-]?\s*\d{4}\b/g, ' ')
    .replace(/\bON \d{1,2} [A-Z]{3}\b/g, ' ')
    .replace(/\s\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\/?(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const typeOnly = s;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(PREFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  const truncated = cibcStyle && s.trim().length >= 14 && s.trim().length <= 15;
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
    .replace(new RegExp(`(?<=\\S)\\s(${WORLD_CITIES})\\s*$`), ' ')
    .replace(/\b\d{1,4}\b\s*$/g, ' ')
    .replace(/(?<=\S )\d{3,4}(?= \S)/g, ' ') // store numbers in the middle ("WOOLWORTHS 1234 SYDNEY")
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

/** Lower-case, accents off, punctuation to spaces: the form the lexicon is matched in. */
export function normText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9&]+/g, ' ').trim();
}

/**
 * The lexicon in rules.json: brands and words by category, matched token by token.
 * An entry ending in "*" matches the start of a word ("restaurant*" → "restaurante").
 */
function compileLexicon(lex = {}) {
  const tiers = {};
  for (const [tier, byCat] of Object.entries(lex)) {
    const index = new Map();
    const prefixes = [];
    for (const [category, words] of Object.entries(byCat || {})) {
      for (const raw of words) {
        const prefix = raw.endsWith('*');
        const tokens = normText(prefix ? raw.slice(0, -1) : raw).split(' ').filter(Boolean);
        if (!tokens.length) continue;
        const e = { category, tokens, prefix, len: tokens.join(' ').length };
        if (prefix && tokens.length === 1) prefixes.push(e);
        else { if (!index.has(tokens[0])) index.set(tokens[0], []); index.get(tokens[0]).push(e); }
      }
    }
    tiers[tier] = { index, prefixes };
  }
  return tiers;
}

/** Earliest (then longest) lexicon entry in a list of tokens: { category, at (char offset), len }. */
function lexMatch(tokens, offsets, tier) {
  if (!tier) return null;
  let best = null;
  const fits = (e, i) => {
    if (i + e.tokens.length > tokens.length) return false;
    for (let k = 0; k < e.tokens.length; k++) {
      const last = k === e.tokens.length - 1;
      if (last && e.prefix ? !tokens[i + k].startsWith(e.tokens[k]) : tokens[i + k] !== e.tokens[k]) return false;
    }
    return true;
  };
  for (let i = 0; i < tokens.length; i++) {
    for (const e of tier.index.get(tokens[i]) || []) if (fits(e, i) && (!best || e.len > best.len)) best = { category: e.category, at: offsets[i], len: e.len };
    for (const e of tier.prefixes) if (tokens[i].startsWith(e.tokens[0]) && (!best || e.len > best.len)) best = { category: e.category, at: offsets[i], len: e.len };
    if (best) return best;
  }
  return null;
}

/** Compile rules.json into something fast to apply. */
export function compileRules(doc) {
  const cats = new Map(doc.categories.map((c) => [c.id, c]));
  const rules = doc.rules.map((r, i) => ({ ...r, i, re: new RegExp(r.pattern, 'i') }));
  return {
    cats, categories: doc.categories, rules, planTemplate: doc.planTemplate,
    typeRules: rules.filter((r) => r.stage === 'type'),
    merchantRules: rules.filter((r) => r.stage !== 'type' && !r.weak),
    weakRules: rules.filter((r) => r.weak),
    lexicon: compileLexicon(doc.lexicon),
  };
}

// Merchant category codes (ISO 18245), when a bank prints them ("MCC 5812").
const MCC = [
  [[5411, 5411], [5422, 5422], [5441, 5441], [5451, 5451], [5499, 5499]], 'groceries',
  [[5812, 5814]], 'dining',
  [[5462, 5462]], 'coffee',
  [[5541, 5542], [4111, 4131], [4784, 4784], [7523, 7523], [5172, 5172], [5983, 5983], [4121, 4121]], 'transport',
  [[3000, 3350], [3351, 3500], [3501, 3999], [4511, 4511], [4722, 4722], [7011, 7012], [7512, 7519], [4411, 4411]], 'travel',
  [[5912, 5912], [8011, 8099], [5975, 5976], [7230, 7230], [7297, 7298], [8041, 8043]], 'health',
  [[7997, 7997], [7941, 7941], [7911, 7911]], 'fitness',
  [[5815, 5818], [7832, 7841], [7922, 7929], [7991, 7996], [7998, 7999], [5735, 5735], [4899, 4899]], 'entertainment',
  [[4812, 4814], [4900, 4900]], 'bills',
  [[4816, 4816]], 'internet',
  [[8211, 8299]], 'education',
  [[9211, 9402]], 'government',
  [[6010, 6011]], 'cash',
  [[4829, 4829]], 'transfers',
  [[6513, 6513], [6300, 6300]], 'housing',
  [[5200, 5399], [5400, 5410], [5600, 5699], [5700, 5799], [5900, 5999], [5940, 5949]], 'shopping',
];
export function mccCategory(code) {
  const n = Number(code);
  for (let i = 0; i < MCC.length; i += 2) if (MCC[i].some(([a, b]) => n >= a && n <= b)) return MCC[i + 1];
  return null;
}
const MCC_RE = /\bMCC\s*[:#-]?\s*(\d{4})\b/i;

/** Strip the transaction-type words and payment-processor tags in front of the merchant. */
function merchantPart(desc) {
  let body = desc;
  for (let k = 0; k < 3; k++) { const next = body.replace(PREFIX_RE, ''); if (next === body) break; body = next; }
  return body.replace(/^(SQ|TST|SP|PP|PAYPAL|FS|IC|CKO|ZTL|PY|VESTA|TOAST)\s?\*\s?/i, '');
}

/**
 * What kind of spending is this? Returns { category, in?, name? } or null. In order:
 *   1. rules.json "type" rules, then the lexicon's type words (pay, cash, transfers, investing);
 *   2. a merchant category code printed by the bank;
 *   3. merchant rules and world brands: the one named earliest in the merchant part wins
 *      ("BOUSTAN MCGILL" is Boustan), then the longest;
 *   4. generic words in many languages ("pharmacie", "supermercado", "tankstelle");
 *   5. hints: a Toast receipt is a restaurant; then weak rules (a campus named in passing).
 */
export function matchRule(desc, compiled) {
  const typeRule = compiled.typeRules.find((r) => r.re.test(desc));
  if (typeRule) return typeRule;
  const lex = compiled.lexicon || {};
  const ntext = normText(desc);
  const tokens = ntext.split(' ');
  const offsets = [];
  for (let i = 0, at = 0; i < tokens.length; i++) { offsets.push(at); at += tokens[i].length + 1; }
  const typed = lexMatch(tokens, offsets, lex.type);
  if (typed) return { category: typed.category, in: IN_FOR[typed.category], name: typed.category === 'cash' ? 'Cash Withdrawal' : undefined, source: 'type' };

  const mcc = MCC_RE.exec(desc);
  if (mcc && mccCategory(mcc[1])) return { category: mccCategory(mcc[1]), source: 'mcc' };

  const body = merchantPart(desc);
  const nbody = normText(body);
  const shift = ntext.length - nbody.length; // where the merchant part starts in the normalized text
  const btokens = nbody.split(' ');
  const boffsets = offsets.slice(tokens.length - btokens.length);
  let best = null;
  for (const r of compiled.merchantRules) {
    const m = r.re.exec(body);
    if (!m) continue;
    const at = normText(body.slice(0, m.index)).length + (m.index ? 1 : 0) + shift;
    if (!best || at < best.at || (at === best.at && m[0].length > best.len)) best = { r, at, len: m[0].length };
  }
  const brand = lexMatch(btokens, boffsets, lex.brands);
  if (brand && (!best || brand.at < best.at || (brand.at === best.at && brand.len > best.len))) best = { r: { category: brand.category, source: 'brand' }, at: brand.at, len: brand.len };
  if (!best) {
    // Rules can also match inside the type words (e.g. "INTERNET BILL PAY"); try the whole text.
    for (const r of compiled.merchantRules) if (r.re.test(desc)) { best = { r }; break; }
  }
  if (best) return best.r;
  const word = lexMatch(btokens, boffsets, lex.keywords) || lexMatch(tokens, offsets, lex.keywords);
  if (word) return { category: word.category, in: IN_FOR[word.category], source: 'keyword' };
  if (/^(TST|TOAST)\s?\*/i.test(desc.replace(PREFIX_RE, ''))) return { category: 'dining', source: 'hint' };
  return compiled.weakRules.find((r) => r.re.test(desc)) || null;
}
// Money coming in under these categories means something else.
const IN_FOR = { transfers: 'transfer_in', cash: 'transfer_in', own: 'own', fees: 'fees', interest: 'interest', income: 'income' };

const GENERIC_NAMES = new Set(['cafe', 'restaurant', 'bar', 'store', 'shop', 'market', 'the', 'pharmacy', 'hotel', 'taxi', 'parking', 'payment', 'purchase', 'transfer', 'deposit', 'withdrawal']);
/** A saved rule for "Blue Heron" also covers "Blue Heron Main St" (the same place, another branch). */
function userRuleMatches(rule, name, sign) {
  if (rule.sign != null && rule.sign !== sign) return false;
  const a = rule.name.toLowerCase(), b = name.toLowerCase();
  if (a === b) return true;
  const ra = a.split(/\s+/), nb = b.split(/\s+/);
  if (ra.length > nb.length || a.length < 4) return false;
  if (ra.length === 1 && GENERIC_NAMES.has(ra[0])) return false;
  return ra.every((w, i) => w === nb[i]);
}

/**
 * Decide { name, category } for one transaction.
 * Priority: a locked manual choice > your saved merchant rules > rules.json + world lexicon > fallback.
 */
// Paid in another currency ("5000 JPY @ 0.0093"): out-and-about spending abroad counts as travel.
const FOREIGN_RE = /\b([A-Z]{3})\s*@\s*[\d.]/;
const TRAVEL_WHEN_ABROAD = new Set(['transport', 'coffee', 'dining', 'groceries']);

export function categorize(txn, compiled, userRules = [], home = 'CAD') {
  const desc = txn.merchant || '';
  const rule = matchRule(desc, compiled);
  const name = rule?.name || cleanName(desc);
  if (txn.locked && txn.category && compiled.cats.has(txn.category)) return { name: txn.name || name, category: txn.category };

  const sign = Math.sign(txn.amount) || -1;
  const user = userRules.find((u) => u.name.toLowerCase() === name.toLowerCase() && (u.sign == null || u.sign === sign))
    || userRules.find((u) => userRuleMatches(u, name, sign));
  if (user && compiled.cats.has(user.category)) return { name, category: user.category };

  let category;
  if (rule) {
    category = txn.amount > 0 && rule.in ? rule.in : rule.category;
    // Interest you pay is a cost, not income.
    if (category === 'interest' && txn.amount < 0) category = 'fees';
    const fx = FOREIGN_RE.exec(desc);
    if (fx && home && fx[1] !== home && TRAVEL_WHEN_ABROAD.has(category) && compiled.cats.has('travel')) category = 'travel';
  } else {
    category = txn.amount > 0 ? 'transfer_in' : 'other';
  }
  if (!compiled.cats.has(category)) category = txn.amount > 0 ? 'transfer_in' : 'other';
  // Money in that matched a spending merchant is a refund and reduces that category.
  return { name, category };
}

/** Rule key for "apply to all from this merchant": same clean name, same direction of money. */
export function userRuleFor(txn, category) {
  return { name: txn.name, category, sign: Math.sign(txn.amount) || -1, createdAt: new Date().toISOString() };
}
