// Reads a bank statement PDF from any bank, without knowing its layout in advance.
//
// It works the way a person skims a statement:
//   1. Finds the table header ("Date  Description  Debit  Credit  Balance", in several languages)
//      and remembers where each column sits.
//   2. Reads every line that starts with a date, in whatever format the bank uses, and pulls the
//      amounts off the right-hand side. Lines without a date continue the previous description.
//   3. Works out money in vs out: from the column, from a printed sign (−, (), CR/DR), and above all
//      from the running balance. Where only some lines show a balance it solves for the signs that
//      make the balance add up.
//   4. Finds the opening/closing balance and the statement period, so the result can be reconciled.
//
// Input: positioned text from pdf.js (see pdf-text.js). Output: the same shape as parseCibcStatement.
import { groupLines } from './cibc-parser.js';
import {
  scanDate, findDates, resolveOrder, settle, isoDate, validDate, isAmountToken, splitTrailingAmounts,
  detectDecimal, parseMoney, signed, detectCurrency, hasWord, norm,
} from './parse-util.js';

const ROLE_WORDS = {
  date: ['date', 'dates', 'datum', 'fecha', 'data', 'transaction date', 'trans date', 'txn date', 'tran date', 'posting date', 'post date', 'posted', 'value date', 'valuta', 'buchungstag', 'buchung', 'wertstellung', 'date operation', 'date de l operation', 'date valeur', 'fecha operacion', 'fecha valor', 'data operazione', 'data valuta', 'data movimento', 'boekdatum', 'day'],
  desc: ['description', 'descriptions', 'details', 'detail', 'transaction details', 'particulars', 'narrative', 'narration', 'transaction', 'transactions', 'memo', 'payee', 'merchant', 'reference', 'remarks', 'libelle', 'libelles', 'operation', 'operations', 'nature de l operation', 'descripcion', 'concepto', 'movimiento', 'beschreibung', 'verwendungszweck', 'buchungstext', 'umsatz', 'descrizione', 'causale', 'descricao', 'historico', 'omschrijving', 'mededelingen', 'opis', 'activity', 'transaction description'],
  debit: ['withdrawal', 'withdrawals', 'debit', 'debits', 'paid out', 'money out', 'payments', 'withdrawal amount', 'withdrawal amt', 'debit amount', 'withdrawals debits', 'cheques debits', 'charges', 'retrait', 'retraits', 'debit', 'debits', 'sortie', 'sorties', 'cargo', 'cargos', 'retiros', 'debe', 'soll', 'lastschrift', 'belastung', 'ausgang', 'addebiti', 'addebito', 'uscite', 'dare', 'saidas', 'saida', 'debito', 'debitos', 'af', 'uitgaven', 'spent'],
  credit: ['deposit', 'deposits', 'credit', 'credits', 'paid in', 'money in', 'receipts', 'deposit amount', 'deposit amt', 'credit amount', 'deposits credits', 'depot', 'depots', 'credit', 'credits', 'entree', 'entrees', 'abono', 'abonos', 'depositos', 'haber', 'haben', 'gutschrift', 'eingang', 'accrediti', 'accredito', 'entrate', 'avere', 'entradas', 'credito', 'creditos', 'bij', 'inkomsten', 'received'],
  amount: ['amount', 'amounts', 'transaction amount', 'amt', 'montant', 'importe', 'monto', 'betrag', 'importo', 'valor', 'bedrag', 'kwota', 'value', 'sum'],
  balance: ['balance', 'running balance', 'solde', 'saldo', 'kontostand', 'balans', 'saldo contable', 'available balance', 'ledger balance'],
};
const CURRENCY_WORDS = new Set('cad usd eur gbp aud nzd inr jpy chf sek nok dkk zar mxn brl aed sgd hkd in out of'.split(' '));
const EXACT_ONLY = { credit: ['in'], debit: ['out'] }; // only when the whole cell is this word

const OPENING = ['opening balance', 'previous balance', 'starting balance', 'beginning balance', 'balance at start', 'last statement balance', 'previous statement balance', 'balance last statement', 'solde d ouverture', 'solde precedent', 'ancien solde', 'solde anterieur', 'solde initial', 'saldo inicial', 'saldo anterior', 'saldo iniziale', 'saldo precedente', 'anfangssaldo', 'alter kontostand', 'alter saldo', 'saldo vorher', 'vorsaldo', 'beginsaldo', 'oud saldo', 'saldo de abertura', 'saldo anterior'];
const OPENING_WEAK = ['balance brought forward', 'brought forward', 'balance forward', 'balance b f', 'b f', 'solde reporte', 'report de solde', 'saldo riportato', 'ubertrag', 'saldo transportado', 'opening'];
const CLOSING = ['closing balance', 'ending balance', 'new balance', 'statement balance', 'balance at end', 'final balance', 'solde de cloture', 'nouveau solde', 'solde final', 'solde de fin', 'saldo final', 'saldo actual', 'saldo finale', 'saldo al', 'endsaldo', 'neuer kontostand', 'neuer saldo', 'eindsaldo', 'nieuw saldo', 'saldo de fecho'];
const CLOSING_WEAK = ['balance carried forward', 'carried forward', 'balance c f', 'c f', 'a reporter', 'saldo da riportare', 'closing'];
const TOTAL = ['total', 'totals', 'totaux', 'summe', 'gesamt', 'totale', 'totaal', 'sous total', 'subtotal'];
const CARD_HINTS = ['credit card', 'card statement', 'minimum payment', 'payment due', 'credit limit', 'available credit', 'minimum amount due', 'carte de credit', 'paiement minimum', 'limite de credit', 'tarjeta de credito', 'pago minimo', 'kreditkarte', 'carta di credito', 'cartao de credito'];
const FOOTER = /(\bpage\s*\d+\s*(of|de|von|di|sur|\/)\s*\d+\b|\bseite\s*\d+|\bpagina\s*\d+|continued on|suite au verso|\bcontinued\b|^\s*\d+\s*\/\s*\d+\s*$)/i;
const IN_WORDS = /\b(deposit|salary|salaire|payroll|wage|wages|pay\s?roll|refund|reimburse|interest (earned|paid|credit)|dividend|cash ?back|rebate|credit|transfer from|from savings|received|receive|incoming|inward|autodeposit|direct dep|e-?transfer (received|in)|remboursement|virement re[cç]u|d[ée]p[ôo]t|n[óo]mina|abono|ingreso|devoluci[óo]n|gehalt|lohn|gutschrift|eingang|stipendio|accredito|rimborso|sal[áa]rio|dep[óo]sito|reembolso|salaris|storting)\b/i;
const CARD_IN_WORDS = /\b(payment|paiement|pago|zahlung|pagamento|betaling|credit|refund|return|reversal|remboursement|cashback|rebate)\b/i;

const round2 = (n) => Math.round(n * 100) / 100;
const cents = (n) => Math.round(n * 100);

/** Locate the words of a phrase inside a line's cells and return x-centers per role. */
function headerRoles(line) {
  const words = [];
  for (const c of line.cells) {
    const per = (c.right - c.x) / Math.max(c.text.length, 1);
    const re = /[\p{L}\p{N}]+/gu;
    let m;
    while ((m = re.exec(c.text))) words.push({ w: norm(m[0]), x: c.x + m.index * per, right: c.x + (m.index + m[0].length) * per, cell: c });
  }
  if (!words.length || words.length > 18) return null;
  const roles = [];
  let used = 0;
  for (let i = 0; i < words.length;) {
    let hit = null;
    for (let n = Math.min(4, words.length - i); n >= 1 && !hit; n--) {
      const phrase = words.slice(i, i + n).map((w) => w.w).join(' ');
      for (const [role, list] of Object.entries(ROLE_WORDS)) {
        if (list.includes(phrase)) { hit = { role, n }; break; }
      }
      if (!hit && n === 1) {
        for (const [role, list] of Object.entries(EXACT_ONLY)) {
          if (list.includes(phrase) && norm(words[i].cell.text) === phrase) { hit = { role, n }; break; }
        }
      }
    }
    if (hit) {
      const span = words.slice(i, i + hit.n);
      roles.push({ role: hit.role, left: span[0].x, right: span[span.length - 1].right, center: (span[0].x + span[span.length - 1].right) / 2 });
      used += hit.n;
      i += hit.n;
    } else i++;
  }
  const has = (r) => roles.some((x) => x.role === r);
  const numeric = roles.filter((x) => ['debit', 'credit', 'amount', 'balance'].includes(x.role));
  if (!(has('date') || has('desc')) || !numeric.length || roles.length < 2) return null;
  // Mostly header words (filters out sentences like "the balance on this date"). Currency codes don't count.
  const noise = words.filter((w) => CURRENCY_WORDS.has(w.w)).length;
  if (used / Math.max(1, words.length - noise) < 0.6) return null;
  const cols = { date: null, desc: null, numeric: [] };
  for (const r of roles) {
    if (r.role === 'date' && !cols.date) cols.date = r;
    else if (r.role === 'desc' && !cols.desc) cols.desc = r;
    else if (r.role !== 'date' && r.role !== 'desc' && !cols.numeric.some((x) => x.role === r.role)) cols.numeric.push(r);
  }
  return cols;
}

/** Split a line into { date, desc, amounts: [{ raw, center }], descX } using cell positions. */
function readLine(line, decimal) {
  const cells = line.cells.map((c) => ({ ...c }));
  let date = null;
  let date2 = null;
  const takeDate = () => {
    const joined = cells.map((c) => c.text).join(' ');
    const d = scanDate(joined);
    if (!d) return null;
    let need = d.len;
    while (need > 0 && cells.length) {
      const c = cells[0];
      if (c.text.length <= need) { need -= c.text.length + 1; cells.shift(); } else {
        const per = (c.right - c.x) / Math.max(c.text.length, 1);
        const cut = c.text.slice(need).replace(/^[\s,.:;-]+/, '');
        c.x += (c.text.length - cut.length) * per;
        c.text = cut;
        need = 0;
        if (!cut) cells.shift();
      }
    }
    return d;
  };
  date = takeDate();
  // A second date right after the first (transaction date + posting date): keep the first.
  if (date && cells.length && scanDate(cells.map((c) => c.text).join(' '))) date2 = takeDate();
  const amounts = [];
  const text = [];
  for (const c of cells) {
    const t = c.text.trim();
    if (!t) continue;
    if (isAmountToken(t)) { amounts.push({ raw: t, center: (c.x + c.right) / 2, right: c.right }); continue; }
    const s = splitTrailingAmounts(t);
    if (s.amounts.length && s.text) {
      const per = (c.right - c.x) / Math.max(t.length, 1);
      let off = t.length;
      const found = [];
      for (let k = s.amounts.length - 1; k >= 0; k--) {
        const a = s.amounts[k];
        const idx = t.lastIndexOf(a, off);
        off = idx;
        found.unshift({ raw: a, center: c.x + (idx + a.length / 2) * per, right: c.x + (idx + a.length) * per, inline: true });
      }
      text.push(s.text);
      amounts.push(...found);
    } else text.push(t);
  }
  const descX = cells.find((c) => c.text.trim() && !isAmountToken(c.text.trim()))?.x ?? null;
  return { date, date2, desc: text.join(' ').replace(/\s+/g, ' ').trim(), amounts, descX, x0: line.cells[0]?.x ?? 0, y: line.y };
}

/** Assign each amount on a row to a column role using the header positions. */
function assignColumns(row, cols, decimal) {
  const out = { debit: null, credit: null, amount: null, balance: null };
  const parsed = row.amounts.map((a) => ({ ...a, m: parseMoney(a.raw, decimal) })).filter((a) => a.m);
  if (cols && cols.numeric.length) {
    const minCenter = Math.min(...cols.numeric.map((c) => c.left)) - 45;
    const taken = new Set();
    for (const a of parsed) {
      if (a.inline && a.right < minCenter) continue; // e.g. an exchange rate inside the description
      if (a.center < minCenter && cols.numeric.length > 1) continue;
      const ranked = cols.numeric.map((c) => ({ c, d: Math.min(Math.abs(a.center - c.center), Math.abs(a.right - c.right)) })).sort((x, y) => x.d - y.d);
      const pick = ranked.find((r) => !taken.has(r.c.role));
      if (!pick) continue;
      taken.add(pick.c.role);
      out[pick.c.role] = a.m;
    }
  } else if (parsed.length >= 2) {
    out.amount = parsed[parsed.length - 2].m;
    out.balance = parsed[parsed.length - 1].m;
  } else if (parsed.length === 1) {
    out.amount = parsed[0].m;
  }
  return out;
}

const phraseIn = (text, list) => hasWord(text, list);
const startsWithPhrase = (text, list) => { const t = norm(text); return list.some((p) => t === p || t.startsWith(p + ' ')); };

/**
 * Parse a statement from any bank.
 * options: { dateOrder: 'dmy'|'mdy', flip: boolean } — the importer's "fix it" switches.
 */
export function parseGenericStatement(pages, options = {}) {
  const pageLines = pages.map((items) => groupLines(items));
  const all = pageLines.flatMap((ls, p) => ls.map((l) => ({ ...l, page: p + 1 })));
  const fullText = all.map((l) => l.text).join('\n');
  const warnings = [];
  const decimal = detectDecimal(all.flatMap((l) => l.cells.map((c) => c.text)).flatMap((t) => [t, ...splitTrailingAmounts(t).amounts]));
  const currency = detectCurrency(fullText);
  const card = CARD_HINTS.filter((h) => phraseIn(fullText, [h])).length >= 2;

  // ---- summary lines: opening/closing balance and totals, anywhere on the statement ----
  const lineAmounts = (l) => {
    const r = readLine(l, decimal);
    return r.amounts.map((a) => parseMoney(a.raw, decimal)).filter(Boolean);
  };
  let opening = null, openingWeak = null, closing = null, closingWeak = null;
  const totals = { withdrawals: null, deposits: null };
  for (const l of all) {
    const words = norm(l.text);
    if (!words || words.length > 140) continue;
    const amts = lineAmounts(l);
    if (!amts.length) continue;
    const last = amts[amts.length - 1];
    const rest = readLine(l, decimal).desc;
    if (opening == null && phraseIn(l.text, OPENING)) opening = last;
    else if (openingWeak == null && startsWithPhrase(rest, OPENING_WEAK)) openingWeak = last;
    if (closing == null && phraseIn(l.text, CLOSING)) closing = last;
    else if (startsWithPhrase(rest, CLOSING_WEAK)) closingWeak = last;
    if (phraseIn(l.text, TOTAL) && words.split(' ').length <= 8) {
      const isDeb = phraseIn(l.text, ROLE_WORDS.debit) || phraseIn(l.text, ['purchases', 'new charges', 'debits']);
      const isCred = phraseIn(l.text, ROLE_WORDS.credit) || phraseIn(l.text, ['payments and credits', 'payments credits']);
      if (isDeb && isCred && amts.length >= 2) { totals.withdrawals ??= amts[0].abs; totals.deposits ??= amts[1].abs; }
      else if (isDeb && !isCred) totals.withdrawals ??= amts[0].abs;
      else if (isCred && !isDeb) totals.deposits ??= amts[0].abs;
    }
  }
  if (opening == null) opening = openingWeak;
  if (closing == null) closing = closingWeak;

  // ---- table rows ----
  const rows = [];
  let cols = null;
  let seenHeader = false;
  let inTable = false;
  let page = 0;
  const headerPages = new Set(all.filter((l) => headerRoles(l)).map((l) => l.page));
  for (const l of all) {
    if (l.page !== page) {
      // A page that repeats the header: skip its letterhead and period line above the header.
      page = l.page;
      inTable = seenHeader && !headerPages.has(page);
    }
    const hc = headerRoles(l);
    if (hc) { cols = hc; seenHeader = true; inTable = true; continue; }
    if (FOOTER.test(l.text) || l.y < 28) continue;
    if (seenHeader && !inTable) continue;
    const r = readLine(l, decimal);
    if (!r.date && !r.amounts.length && !r.desc) continue;
    if ((phraseIn(r.desc, [...OPENING, ...CLOSING]) || startsWithPhrase(r.desc, [...OPENING_WEAK, ...CLOSING_WEAK])) && r.desc.split(' ').length <= 8) r.special = true;
    if (startsWithPhrase(r.desc, TOTAL)) r.special = true;
    r.cols = assignColumns(r, cols, decimal);
    r.hasAmt = r.cols.debit || r.cols.credit || r.cols.amount;
    r.page = l.page;
    r.inTable = seenHeader;
    rows.push(r);
    // The final closing balance ends the table; the fine print after it isn't transactions.
    if (r.special && phraseIn(r.desc, CLOSING)) inTable = false;
  }
  // When the statement has a header, ignore everything before the first one.
  const firstHeaderIdx = seenHeader ? rows.findIndex((r) => r.inTable) : 0;
  const tableRows = rows.slice(Math.max(0, firstHeaderIdx));

  // ---- day/month order for numeric dates ----
  const scanned = tableRows.filter((r) => r.date).map((r) => r.date).concat(findDates(all.slice(0, 80).map((l) => l.text).join('\n')));
  const ord = resolveOrder(scanned, options.dateOrder || (currency === 'USD' ? 'mdy' : null));
  const order = options.dateOrder || ord.order;
  const orderCertain = !!options.dateOrder || ord.certain || !scanned.some((d) => d.ambiguous);

  // ---- group rows into transactions ----
  // Some banks print the amount on the first line of a multi-line entry, others on the last. When
  // a fair share of dated lines carry no amount, it's the latter: a new undated line then starts
  // the next entry instead of continuing the previous one.
  const datedRows = tableRows.filter((r) => r.date && r.desc && !r.special);
  const amountLast = datedRows.length > 0 && datedRows.filter((r) => !r.hasAmt).length / datedRows.length > 0.1;
  const txns = [];
  let cur = null;
  let lastDate = null;
  let pending = null;
  for (const r of tableRows) {
    if (r.special) { cur = null; pending = null; continue; }
    const d = r.date ? settle(r.date, order) : null;
    if (d) lastDate = d;
    if (d && r.hasAmt) {
      if (pending) warnings.push(`Skipped a line with no amount: “${pending.desc.slice(0, 60)}”`);
      pending = null;
      cur = { date: d, desc: r.desc, cols: r.cols, page: r.page, descX: r.descX, cont: 0 };
      txns.push(cur);
    } else if (d && !r.hasAmt) {
      if (!r.desc) { cur = null; pending = null; continue; } // a date heading for the lines below
      pending = { date: d, desc: r.desc, page: r.page, descX: r.descX, cont: 0 };
      cur = null;
    } else if (!d && r.hasAmt) {
      if (pending) {
        pending.desc = [pending.desc, r.desc].filter(Boolean).join(' ');
        pending.cols = r.cols;
        txns.push(pending);
        cur = pending;
        pending = null;
      } else if (r.desc && lastDate && (seenHeader ? r.inTable : true)) {
        cur = { date: lastDate, desc: r.desc, cols: r.cols, page: r.page, descX: r.descX, cont: 0 };
        txns.push(cur);
      }
    } else if (!d && !r.hasAmt && r.desc) {
      if (amountLast && !pending && lastDate && (!seenHeader || r.inTable)) {
        pending = { date: lastDate, desc: r.desc, page: r.page, descX: r.descX, cont: 0 };
        cur = null;
        continue;
      }
      const target = pending || cur;
      if (target && target.cont < 3 && (target.descX == null || (r.x0 >= target.descX - 10 && r.x0 <= target.descX + 80))) {
        target.desc += ' ' + r.desc;
        target.cont++;
      } else if (!pending) cur = null;
    }
  }
  if (pending) warnings.push(`Skipped a line with no amount: “${pending.desc.slice(0, 60)}”`);

  // ---- years and the statement period ----
  const head = all.filter((l) => l.page === 1).slice(0, 80).map((l) => l.text).join('\n');
  const yearsInText = (head.match(/\b(19[89]\d|20\d\d)\b/g) || []).map(Number);
  const yearHint = yearsInText.length ? mode(yearsInText) : null;
  let period = findPeriod(head, order, yearHint) || findPeriod(fullText, order, yearHint);
  const fallbackYear = period ? Number(period.end.slice(0, 4)) : yearsInText.length ? mode(yearsInText) : new Date().getFullYear();
  resolveYears(txns, period, fallbackYear);
  const ok = txns.filter((t) => t.iso);
  if (ok.length < txns.length) warnings.push(`${txns.length - ok.length} line(s) had a date that couldn’t be read and were skipped.`);
  let list = ok;
  // Statements printed newest-first: put them in date order (the balance after each line still applies).
  if (list.length > 1 && list[0].iso > list[list.length - 1].iso) list = list.slice().reverse();
  if (!period && list.length) period = { start: list[0].iso, end: list[list.length - 1].iso, guessed: true };

  // ---- money in or out ----
  // Credit cards: the balance is what you owe, so it counts as negative here and charges reduce it.
  const flip = options.flip ? -1 : 1;
  const items = list.map((t) => {
    const c = t.cols;
    let amt = null, known = false;
    if (c.debit && !c.credit) { amt = -c.debit.abs; known = true; }
    else if (c.credit && !c.debit) { amt = c.credit.abs; known = true; }
    else if (c.debit && c.credit) { amt = c.credit.abs - c.debit.abs; known = true; }
    else if (c.amount) {
      amt = signed(c.amount, { card });
      if (amt != null) known = true;
      else amt = (card ? CARD_IN_WORDS.test(t.desc) : IN_WORDS.test(t.desc)) ? c.amount.abs : -c.amount.abs;
    }
    const bal = c.balance ? signed(c.balance, { card, plain: card ? -1 : 1 }) : null;
    return { t, amt: amt * flip, known, bal };
  });
  const asBalance = (m) => (m ? signed(m, { card, plain: card ? -1 : 1 }) : null);

  let open = asBalance(opening);
  let close = asBalance(closing);
  // Without a printed opening balance, take it from the first line that shows a balance.
  const firstBal = items.findIndex((x) => x.bal != null);
  if (open == null && firstBal >= 0) {
    // Back out the transactions before it (known signs only; unknown ones are solved below anyway).
    let s = 0;
    for (let i = 0; i <= firstBal; i++) s += items[i].amt;
    if (items.slice(0, firstBal + 1).every((x) => x.known) || firstBal === 0) open = round2(items[firstBal].bal - s);
  }
  // Solve signs between balance checkpoints so the running balance adds up.
  const balanceIssues = [];
  let prev = open;
  let segment = [];
  let checkpoints = 0;
  for (const x of items) {
    segment.push(x);
    if (x.bal == null) continue;
    if (prev != null) {
      const res = solveSegment(segment, x.bal - prev);
      if (res.ok) checkpoints++;
      else balanceIssues.push({ date: x.t.iso, description: x.t.desc, expected: round2(prev + segment.reduce((s, y) => s + y.amt, 0)), printed: x.bal });
    }
    prev = x.bal;
    segment = [];
  }
  // How sure are we about money in vs out? Printed columns/signs, or proven by the balance, beat keywords.
  const signSource = items.every((x) => x.known) ? 'columns' : checkpoints && !balanceIssues.length ? 'balance' : 'keywords';
  if (close == null) {
    const lastBal = [...items].reverse().find((x) => x.bal != null);
    if (lastBal) {
      const idx = items.lastIndexOf(lastBal);
      close = round2(lastBal.bal + items.slice(idx + 1).reduce((s, y) => s + y.amt, 0));
    }
  }

  const transactions = items.map((x) => ({ date: x.t.iso, description: x.t.desc, amount: round2(x.amt), balance: x.bal != null ? round2(x.bal) : null, page: x.t.page }));
  const lowConfidence = signSource === 'keywords' && !(open != null && close != null);
  return {
    period: period ? { start: period.start, end: period.end } : null,
    opening: open != null ? round2(open) : null,
    closing: close != null ? round2(close) : null,
    summaryTotals: card ? { withdrawals: null, deposits: null } : totals,
    transactions,
    balanceIssues,
    warnings,
    meta: { parser: 'generic', format: 'pdf', currency, card, decimal, dateOrder: order, dateOrderCertain: orderCertain, signSource, lowConfidence, periodGuessed: !!period?.guessed },
  };
}

/** Flip as few unknown signs as possible so the segment sums to `target`. Mutates amounts. */
function solveSegment(segment, target) {
  const want = cents(target);
  const sum = () => segment.reduce((s, y) => s + cents(y.amt), 0);
  if (sum() === want) return { ok: true, changed: 0 };
  const unknown = segment.filter((y) => !y.known && y.amt != null);
  if (unknown.length && unknown.length <= 14) {
    const base = sum();
    let best = null;
    for (let mask = 1; mask < 1 << unknown.length; mask++) {
      let s = base;
      let bits = 0;
      for (let i = 0; i < unknown.length; i++) if (mask & (1 << i)) { s -= 2 * cents(unknown[i].amt); bits++; }
      if (s === want && (!best || bits < best.bits)) best = { mask, bits };
    }
    if (best) {
      unknown.forEach((y, i) => { if (best.mask & (1 << i)) y.amt = -y.amt; });
      return { ok: true, changed: best.bits };
    }
  }
  // A single line with a known sign that only works the other way round: the column guess was wrong.
  if (segment.length === 1 && segment[0].amt != null && cents(-segment[0].amt) === want) { segment[0].amt = -segment[0].amt; return { ok: true, changed: 1 }; }
  return { ok: false, changed: 0 };
}

function mode(arr) {
  const c = new Map();
  for (const v of arr) c.set(v, (c.get(v) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

/** "1 January 2026 to 31 January 2026", "01/01/2026 - 31/01/2026", "du 1 au 31 janvier 2026" … */
export function findPeriod(text, order = 'dmy', yearHint = null) {
  for (const line of String(text).split('\n')) {
    const ds = findDates(line);
    for (let i = 0; i + 1 < ds.length; i++) {
      const a = ds[i], b = ds[i + 1];
      const between = line.slice(a.index + a.len, b.index);
      if (!/^\s*(to|through|thru|until|till|[-–—~]|au|à|a|al|hasta|bis|tot|t\/m|ate|até|fino al|al)\s*$/i.test(between)) continue;
      const sa = settle(a, order), sb = settle(b, order);
      const yb = sb.y || sa.y || yearHint;
      if (!yb) continue;
      let ya = sa.y || yb;
      if (!sa.y && sa.m > sb.m) ya = yb - 1;
      if (!validDate(ya, sa.m, sa.d) || !validDate(yb, sb.m, sb.d)) continue;
      const start = isoDate(ya, sa.m, sa.d), end = isoDate(yb, sb.m, sb.d);
      if (start <= end) return { start, end };
    }
  }
  // "Statement period: January 2026" style isn't common enough to guess; fall back to the transactions.
  return null;
}

function shift(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Fill in missing years from the statement period, rolling over December → January. */
function resolveYears(txns, period, fallbackYear) {
  let year = fallbackYear;
  let prevMonth = null;
  if (!period) {
    // Start from the first explicit year if there is one before any yearless date.
    const firstY = txns.find((t) => t.date.y)?.date.y;
    if (firstY) year = firstY;
    // If the first month is later than the last month and nothing has a year, the statement crosses New Year.
    const ms = txns.map((t) => t.date.m);
    if (!txns.some((t) => t.date.y) && ms.length && ms[0] > ms[ms.length - 1] + 6) year = fallbackYear - 1;
  }
  for (const t of txns) {
    const { m, d } = t.date;
    let y = t.date.y;
    if (!y && period) {
      const years = [...new Set([Number(period.end.slice(0, 4)), Number(period.start.slice(0, 4))])];
      for (const cand of years) {
        const s = isoDate(cand, m, d);
        if (s >= shift(period.start, -40) && s <= shift(period.end, 10)) { y = cand; break; }
      }
      y ||= years[0];
    } else if (!y) {
      if (prevMonth != null && m < prevMonth - 6) year++;
      if (prevMonth != null && m > prevMonth + 6) year--;
      y = year;
    }
    prevMonth = m;
    if (validDate(y, m, d)) t.iso = isoDate(y, m, d);
  }
}
