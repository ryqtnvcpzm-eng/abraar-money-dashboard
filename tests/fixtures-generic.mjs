// Synthetic statement layouts from different banks/countries, as positioned text (what pdf.js returns).
// Made-up data. Each fixture: { name, pages, expect: { period, opening, closing, count, amounts? } }
const CW = 5; // rough glyph width in points
function page(rows) {
  const items = [];
  let y = 780;
  for (const r of rows) {
    if (r === null) { y -= 14; continue; }
    for (const [x, str, right] of r) {
      const w = str.length * CW;
      items.push({ str, x: right ? x - w : x, y, w });
    }
    y -= 14;
  }
  return items;
}
// Right-aligned amount at column edge x
const R = (x, s) => [x, s, true];

export const FIXTURES = [
  {
    name: 'UK bank (paid out / paid in / balance, dd/mm/yyyy)',
    pages: [page([
      [[40, 'Example Bank plc']],
      [[40, 'Your statement'], [300, '1 January 2026 to 31 January 2026']],
      null,
      [[40, 'Date'], [110, 'Description'], [330, 'Paid out'], [420, 'Paid in'], [510, 'Balance']],
      [[40, '01/01/2026'], [110, 'Balance brought forward'], R(560, '1,250.00')],
      [[40, '02/01/2026'], [110, 'TESCO STORES 2231'], R(370, '42.18'), R(560, '1,207.82')],
      [[40, '05/01/2026'], [110, 'SALARY EXAMPLE LTD'], R(460, '2,100.00'), R(560, '3,307.82')],
      [[40, '13/01/2026'], [110, 'RENT STANDING ORDER'], R(370, '950.00'), R(560, '2,357.82')],
      [[110, 'REF FLAT 2']],
      [[40, '20/01/2026'], [110, 'PRET A MANGER'], R(370, '6.45'), R(560, '2,351.37')],
      [[40, '31/01/2026'], [110, 'Balance carried forward'], R(560, '2,351.37')],
      [[200, 'Page 1 of 1']],
    ])],
    expect: { period: ['2026-01-01', '2026-01-31'], opening: 1250, closing: 2351.37, count: 4, amounts: [-42.18, 2100, -950, -6.45], descIncludes: 'REF FLAT 2' },
  },
  {
    name: 'US bank (signed amount column, mm/dd, beginning/ending balance)',
    pages: [page([
      [[40, 'Statement Period 02/01/2026 - 02/28/2026']],
      [[40, 'Beginning Balance'], R(560, '$3,402.11')],
      [[40, 'Ending Balance'], R(560, '$2,980.61')],
      null,
      [[40, 'Date'], [100, 'Description'], [420, 'Amount'], [500, 'Balance']],
      [[40, '02/03'], [100, 'STARBUCKS STORE 1234 SEATTLE WA'], R(460, '-5.75'), R(560, '3,396.36')],
      [[40, '02/13'], [100, 'ACH DEPOSIT PAYROLL ACME INC'], R(460, '1,840.00'), R(560, '5,236.36')],
      [[40, '02/14'], [100, 'ZELLE PAYMENT TO J SMITH'], R(460, '-200.00'), R(560, '5,036.36')],
      [[40, '02/15'], [100, 'RENT PAYMENT ONLINE'], R(460, '-2,055.75'), R(560, '2,980.61')],
    ])],
    expect: { period: ['2026-02-01', '2026-02-28'], opening: 3402.11, closing: 2980.61, count: 4, amounts: [-5.75, 1840, -200, -2055.75] },
  },
  {
    name: 'German bank (Buchungstag / Verwendungszweck / Betrag, comma decimals)',
    pages: [page([
      [[40, 'Kontoauszug 3/2026']],
      [[40, 'Zeitraum: 01.03.2026 bis 31.03.2026']],
      [[40, 'Alter Kontostand'], R(560, '1.020,00 EUR')],
      null,
      [[40, 'Buchungstag'], [120, 'Verwendungszweck'], [480, 'Betrag EUR']],
      [[40, '02.03.2026'], [120, 'REWE Markt GmbH Berlin'], R(560, '-23,45')],
      [[40, '15.03.2026'], [120, 'Gehalt Beispiel AG'], R(560, '2.400,00')],
      [[40, '28.03.2026'], [120, 'Miete Maerz'], R(560, '-1.100,00')],
      [[40, 'Neuer Kontostand'], R(560, '2.296,55 EUR')],
    ])],
    expect: { period: ['2026-03-01', '2026-03-31'], opening: 1020, closing: 2296.55, count: 3, amounts: [-23.45, 2400, -1100], currency: 'EUR' },
  },
  {
    name: 'Credit card (charges positive, payment negative, previous/new balance)',
    pages: [page([
      [[40, 'Example Visa Credit Card Statement']],
      [[40, 'Statement period Dec 15, 2025 - Jan 14, 2026']],
      [[40, 'Previous balance'], R(560, '$512.40')],
      [[40, 'New balance'], R(560, '$318.90')],
      [[40, 'Minimum payment'], R(560, '$10.00')],
      [[40, 'Payment due date Feb 4, 2026']],
      [[40, 'Credit limit'], R(560, '$5,000.00')],
      null,
      [[40, 'Trans date'], [100, 'Post date'], [160, 'Description'], [500, 'Amount']],
      [[40, 'Dec 18'], [100, 'Dec 19'], [160, 'NETFLIX.COM'], R(560, '16.99')],
      [[40, 'Dec 28'], [100, 'Dec 29'], [160, 'PAYMENT - THANK YOU'], R(560, '-512.40')],
      [[40, 'Jan 3'], [100, 'Jan 4'], [160, 'UBER EATS TORONTO'], R(560, '41.86')],
      [[40, 'Jan 10'], [100, 'Jan 11'], [160, 'GROCERY MART'], R(560, '260.05')],
    ])],
    expect: { period: ['2025-12-15', '2026-01-14'], opening: -512.4, closing: -318.9, count: 4, amounts: [-16.99, 512.4, -41.86, -260.05], dates: ['2025-12-18', '2025-12-28', '2026-01-03', '2026-01-10'] },
  },
  {
    name: 'Indian bank (narration, withdrawal/deposit amt, newest first, dd-mm-yyyy)',
    pages: [page([
      [[40, 'Statement of account from 01-04-2026 to 30-04-2026']],
      null,
      [[40, 'Date'], [100, 'Narration'], [330, 'Withdrawal Amt.'], [420, 'Deposit Amt.'], [500, 'Closing Balance']],
      [[40, '25-04-2026'], [100, 'UPI-SWIGGY-ORDER'], R(380, '450.00'), R(560, '61,050.00')],
      [[40, '10-04-2026'], [100, 'NEFT CR-SALARY APR'], R(470, '55,000.00'), R(560, '61,500.00')],
      [[40, '02-04-2026'], [100, 'ATM WDL'], R(380, '2,000.00'), R(560, '6,500.00')],
    ])],
    expect: { period: ['2026-04-01', '2026-04-30'], opening: 8500, closing: 61050, count: 3, amounts: [-2000, 55000, -450] },
  },
  {
    name: 'No column header, day headings, unsigned amounts, end-of-day balances',
    pages: [page([
      [[40, 'Account activity  March 1, 2026 to March 31, 2026']],
      [[40, 'Opening balance'], R(560, '500.00')],
      [[40, 'March 3, 2026']],
      [[60, 'COFFEE CORNER'], R(460, '4.50')],
      [[60, 'BOOKSHOP'], R(460, '20.00')],
      [[60, 'REFUND BOOKSHOP'], R(460, '20.00'), R(560, '495.50')],
      [[40, 'March 9, 2026']],
      [[60, 'ACME LTD'], R(460, '300.00'), R(560, '795.50')],
      [[40, 'Closing balance'], R(560, '795.50')],
    ])],
    expect: { period: ['2026-03-01', '2026-03-31'], opening: 500, closing: 795.5, count: 4, amounts: [-4.5, -20, 20, 300] },
  },
];
