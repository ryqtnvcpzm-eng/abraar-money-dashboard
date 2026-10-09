// Synthetic export files in the formats banks offer for download. Made-up data.
export const EXPORTS = [
  {
    name: 'card-activity.csv', label: 'US card CSV (purchases negative, two months)',
    text: `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
02/02/2026,02/03/2026,TRADER JOE S #123,Groceries,Sale,-54.20,
01/28/2026,01/29/2026,Payment Thank You-Mobile,,Payment,300.00,
01/15/2026,01/16/2026,"SHELL OIL 5744, INC",Gas,Sale,-38.75,
01/13/2026,01/14/2026,NETFLIX.COM,Entertainment,Sale,-15.49,
`,
    expect: { months: ['2026-01', '2026-02'], amounts: { '2026-01': [-15.49, -38.75, 300], '2026-02': [-54.2] }, verified: null },
  },
  {
    name: 'accountactivity.csv', label: 'Canadian bank CSV, no header (date, description, debit, credit, balance)',
    text: `03/02/2026,TIM HORTONS #2217,2.15,,1022.85
03/04/2026,PAYROLL DEP,,1500.00,2522.85
03/04/2026,SEND E-TFR ***Ab1,100.00,,2422.85
03/10/2026,HYDRO OTTAWA,88.40,,2334.45
`,
    expect: { months: ['2026-03'], amounts: { '2026-03': [-2.15, 1500, -100, -88.4] }, opening: { '2026-03': 1025 }, closing: { '2026-03': 2334.45 }, verified: true },
  },
  {
    name: 'umsaetze.csv', label: 'German bank CSV (semicolon, comma decimals, dd.mm.yy)',
    text: `Kontonummer;DE00 0000 0000 0000 0000 00
"Buchungstag";"Valutadatum";"Buchungstext";"Verwendungszweck";"Beguenstigter/Zahlungspflichtiger";"Betrag";"Waehrung"
"28.03.26";"28.03.26";"LASTSCHRIFT";"Miete Maerz";"Hausverwaltung";"-1.100,00";"EUR"
"15.03.26";"15.03.26";"GUTSCHRIFT";"Gehalt";"Beispiel AG";"2.400,00";"EUR"
"02.03.26";"02.03.26";"KARTENZAHLUNG";"REWE SAGT DANKE";"REWE Markt";"-23,45";"EUR"
`,
    expect: { months: ['2026-03'], amounts: { '2026-03': [-23.45, 2400, -1100] }, currency: 'EUR', verified: null },
  },
  {
    name: 'statement.csv', label: 'UK app bank CSV (money out / money in columns)',
    text: `Date,Time,Type,Name,Category,Money Out,Money In,Balance
05/01/2026,09:12,Card payment,Pret A Manger,Eating out,6.45,,93.55
06/01/2026,12:00,Faster payment,Example Ltd,Income,,1200.00,1293.55
13/01/2026,08:00,Direct Debit,Rent,Bills,950.00,,343.55
`,
    expect: { months: ['2026-01'], amounts: { '2026-01': [-6.45, 1200, -950] }, opening: { '2026-01': 100 }, verified: true },
  },
  {
    name: 'export.ofx', label: 'OFX (SGML) with ledger balance',
    text: `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD
<BANKACCTFROM><BANKID>000000<ACCTID>0000000<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260401<DTEND>20260531
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260403120000<TRNAMT>-12.50<FITID>1<NAME>COFFEE &amp; CO<MEMO>POS</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260415<TRNAMT>2000.00<FITID>2<NAME>PAYROLL</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260502<TRNAMT>-800.00<FITID>3<NAME>RENT</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>1687.50<DTASOF>20260531</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`,
    expect: { months: ['2026-04', '2026-05'], amounts: { '2026-04': [-12.5, 2000], '2026-05': [-800] }, opening: { '2026-04': 500 }, closing: { '2026-05': 1687.5 }, currency: 'CAD', verified: null },
  },
  {
    name: 'quicken.qif', label: 'QIF',
    text: `!Type:Bank
D06/03'26
T-45.00
PGROCERY STORE
^
D06/20'26
T1,250.00
PSALARY
^
`,
    expect: { months: ['2026-06'], amounts: { '2026-06': [-45, 1250] }, verified: null },
  },
];
