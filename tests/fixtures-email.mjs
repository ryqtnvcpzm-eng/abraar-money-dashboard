// Made-up bank alert emails, in the shapes banks send them (plain sentences, HTML tables, labels
// stacked over values, forwarded mail). No real emails, people or card numbers.
const D = 'Fri, 03 Oct 2026 14:22:05 -0400';

export const ALERTS = [
  {
    name: 'Canadian credit card purchase (sentence)',
    msg: { from: 'CIBC Alerts <alerts@notifications.cibc.com>', subject: 'Transaction alert', date: D,
      text: 'Hello,\nA purchase of $12.48 was made at TIM HORTONS #4412 on October 3, 2026 with your CIBC Aventura Visa card ending in 1234.\nIf you don’t recognize this transaction, call us.' },
    expect: { amount: -12.48, merchant: 'Tim Hortons', date: '2026-10-03', kind: 'purchase', account: 'card', confidence: 'high' },
  },
  {
    name: 'HTML table alert (label | value rows)',
    msg: { from: '"TD Alerts" <tdalerts@td.com>', subject: 'TD Alert: Purchase over your set amount', date: D,
      html: `<html><head><style>td{color:#333}</style></head><body><table><tr><td><b>Merchant</b></td><td>SHOPPERS DRUG MART #0921</td></tr>
        <tr><td>Amount</td><td>$46.10</td></tr><tr><td>Date</td><td>Oct 2, 2026</td></tr><tr><td>Card</td><td>TD Cash Back Visa ************5678</td></tr></table>
        <p>You set this alert for purchases over $25.00.</p><p style="font-size:10px">Earn up to 5% cash back. <a href="#">Unsubscribe</a></p></body></html>` },
    expect: { amount: -46.1, merchant: 'Shoppers Drug Mart', date: '2026-10-02', kind: 'purchase', account: 'card' },
  },
  {
    name: 'Labels stacked over values',
    msg: { from: 'RBC Royal Bank <alerts@rbc.com>', subject: 'Credit card purchase', date: D,
      text: 'Your RBC credit card was used.\n\nMerchant name:\nUBER* EATS\nAmount:\n$31.90 CAD\nDate:\n2026-10-01\n\nCard number ending: 9012' },
    expect: { amount: -31.9, merchant: 'Uber', date: '2026-10-01', kind: 'purchase', account: 'card' },
  },
  {
    name: 'Debit purchase on chequing',
    msg: { from: 'Scotiabank <noreply@scotiabank.com>', subject: 'Scotia InfoAlert', date: D,
      text: 'You made a debit purchase of $8.75 at DOLLARAMA #112 from your chequing account on Oct 03.' },
    expect: { amount: -8.75, merchant: 'Dollarama', date: '2026-10-03', kind: 'purchase', account: 'bank' },
  },
  {
    name: 'Interac e-Transfer sent',
    msg: { from: 'BMO <alerts@bmo.com>', subject: 'Interac e-Transfer sent', date: D,
      text: 'You sent $60.00 to Sam Example by Interac e-Transfer on October 2, 2026. Reference number: CA1Mx8Z9QW7.' },
    expect: { amount: -60, merchant: 'Sam Example', merchantIs: 'Sam Example', date: '2026-10-02', kind: 'transfer', account: 'bank' },
  },
  {
    name: 'Interac e-Transfer received',
    msg: { from: 'Interac e-Transfer <notify@payments.interac.ca>', subject: 'INTERAC e-Transfer: Alex Sample sent you money.', date: D,
      text: 'Hi,\nAlex Sample sent you $125.00 (CAD) and the money has been automatically deposited into your bank account.\nMessage: dinner' },
    expect: { amount: 125, merchant: 'Alex Sample', kind: 'transfer', account: 'bank', date: '2026-10-03' },
  },
  {
    name: 'Refund credited to card',
    msg: { from: 'Tangerine <alerts@tangerine.ca>', subject: 'A credit was posted to your card', date: D,
      text: 'A refund of $19.99 from Best Buy was credited to your Tangerine Money-Back Credit Card on Sep 30, 2026.' },
    expect: { amount: 19.99, merchant: 'Best Buy', date: '2026-09-30', kind: 'refund', account: 'card' },
  },
  {
    name: 'US card: amount and merchant in the subject',
    msg: { from: 'Chase <no.reply.alerts@chase.com>', subject: 'Your $45.67 transaction with STARBUCKS STORE 08812', date: 'Thu, 2 Oct 2026 09:10:00 -0500',
      text: 'You made a $45.67 transaction with STARBUCKS STORE 08812 on Oct 2, 2026 at 9:08 AM ET.\nAccount: Sapphire Preferred credit card (...4321)\nDo not reply to this message.' },
    expect: { amount: -45.67, merchant: 'Starbucks', date: '2026-10-02', kind: 'purchase', account: 'card' },
  },
  {
    name: 'Charged to your card, merchant first',
    msg: { from: 'American Express <AmericanExpress@welcome.aexp.com>', subject: 'Large Purchase Approved', date: D,
      text: 'Card Member, a charge of $312.00 was approved at DELTA AIR LINES on your Card ending in 01005.\nTo view your account, log in.' },
    expect: { amount: -312, merchant: 'Delta Air Lines', kind: 'purchase', account: 'card' },
  },
  {
    name: 'ATM withdrawal',
    msg: { from: 'Bank of America <onlinebanking@ealerts.bankofamerica.com>', subject: 'Withdrawal alert', date: D,
      text: 'A withdrawal of $100.00 was made from your checking account ending in 4455 at an ATM on 10/02/2026.' },
    expect: { amount: -100, merchant: null, date: '2026-10-02', kind: 'withdrawal', account: 'bank' },
  },
  {
    name: 'UK card payment (£, dd/mm)',
    msg: { from: 'Monzo <help@monzo.com>', subject: 'You spent £23.40 at Pret A Manger', date: 'Fri, 03 Oct 2026 12:00:00 +0100',
      text: 'You spent £23.40 at Pret A Manger on 02/10/2026 using your debit card.' },
    expect: { amount: -23.4, merchant: 'Pret A Manger', date: '2026-10-02', currency: 'GBP', kind: 'purchase', account: 'bank' },
  },
  {
    name: 'India UPI debit (Rs.)',
    msg: { from: 'HDFC Bank InstaAlerts <alerts@hdfcbank.net>', subject: 'You have done a UPI txn. Check details!', date: D,
      text: 'Dear Customer, Rs.499.00 has been debited from account **1234 to VPA swiggy@icici SWIGGY on 02-10-26. Your UPI transaction reference number is 527512345678.' },
    expect: { amount: -499, merchant: 'Swiggy', date: '2026-10-02', currency: 'INR', kind: 'purchase', account: 'bank' },
  },
  {
    name: 'Payroll deposit',
    msg: { from: 'Wells Fargo Alerts <alerts@notify.wellsfargo.com>', subject: 'Direct deposit received', date: D,
      text: 'A direct deposit of $2,150.33 from ACME PAYROLL has been deposited into your account on 10/03/2026.' },
    expect: { amount: 2150.33, merchant: 'Acme Payroll', date: '2026-10-03', kind: 'deposit', account: 'bank' },
  },
  {
    name: 'Card payment received',
    msg: { from: 'Capital One <capitalone@notification.capitalone.com>', subject: 'We received your payment', date: D,
      text: 'Thank you! We received your payment of $500.00 on October 2, 2026 for your card ending in 7788. Your available credit is $4,210.55.' },
    expect: { amount: 500, kind: 'payment', account: 'card', date: '2026-10-02' },
  },
  {
    name: 'Forwarded alert (pasted)',
    msg: { text: 'FYI\n\n---------- Forwarded message ---------\nFrom: CIBC <alerts@notifications.cibc.com>\nDate: Wed, Oct 1, 2026 at 6:15 PM\nSubject: Transaction alert\nTo: <someone@example.com>\n\nA purchase of $64.20 was made at COSTCO WHOLESALE W512 on October 1, 2026 with your credit card ending in 1234.' },
    expect: { amount: -64.2, merchant: 'Costco', date: '2026-10-01', kind: 'purchase', account: 'card' },
  },
  {
    name: 'Pasted body only, no headers',
    msg: { text: 'You made a purchase of $9.99 at NETFLIX.COM with your Visa card on Sept 28, 2026.' },
    today: '2026-10-03',
    expect: { amount: -9.99, merchant: 'Netflix', date: '2026-09-28', kind: 'purchase', account: 'card' },
  },
  {
    name: 'Unknown sender that clearly reads like an alert',
    msg: { from: 'My Credit Union <notices@examplecu.org>', subject: 'Purchase alert', date: D,
      text: 'Your debit card was charged $27.15 at SHELL CANADA on October 3, 2026.' },
    expect: { amount: -27.15, merchant: 'Shell', kind: 'purchase', account: 'bank', date: '2026-10-03' },
  },
  {
    name: 'Alert with a balance line after the amount',
    msg: { from: 'Neo Financial <alerts@neofinancial.com>', subject: 'New transaction', date: D,
      text: 'Your available balance is $1,204.11.\nYou spent $18.40 at A&W on Oct 3.\nCurrent balance: $395.89' },
    expect: { amount: -18.4, merchant: 'A&W', date: '2026-10-03', kind: 'purchase' },
  },
  {
    name: '.eml file (multipart, quoted-printable HTML)',
    eml: [
      'From: =?UTF-8?Q?CIBC_Alerts?= <alerts@notifications.cibc.com>',
      'Subject: =?UTF-8?B?VHJhbnNhY3Rpb24gYWxlcnQ=?=',
      'Date: Thu, 02 Oct 2026 08:00:00 -0400',
      'Message-ID: <abc123@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'View this email in your browser.',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>A purchase of <b>$7.35</b> was made at <b>STARBUCKS</b> on October 2, 2026 with your=',
      ' CIBC Dividend Visa=C2=AE card.</p>',
      '--b1--',
      '',
    ].join('\r\n'),
    expect: { amount: -7.35, merchant: 'Starbucks', date: '2026-10-02', kind: 'purchase', account: 'card' },
  },
];

export const NOT_ALERTS = [
  { name: 'one-time code', msg: { from: 'CIBC <alerts@cibc.com>', subject: 'Your verification code', date: D, text: 'Your one-time verification code is 482913. It expires in 10 minutes.' }, reason: 'code' },
  { name: 'statement ready', msg: { from: 'TD <noreply@td.com>', subject: 'Your eStatement is ready', date: D, text: 'Your statement is now available. Statement balance: $1,234.56. Minimum payment: $10.00.' } },
  { name: 'payment due reminder', msg: { from: 'RBC <alerts@rbc.com>', subject: 'Payment reminder', date: D, text: 'Your minimum payment of $25.00 is due on October 15, 2026.' } },
  { name: 'marketing', msg: { from: 'Scotiabank <offers@scotiabank.com>', subject: 'Earn up to 10,000 bonus points', date: D, text: 'Apply now and earn up to $200 in rewards. Limited-time offer. Spend $1,000 in the first 3 months.' } },
  { name: 'low balance', msg: { from: 'BMO <alerts@bmo.com>', subject: 'Low balance alert', date: D, text: 'Your chequing account balance has dropped below $100.00. Your balance is $86.12.' } },
  { name: 'declined', msg: { from: 'Chase <no.reply.alerts@chase.com>', subject: 'Transaction declined', date: D, text: 'A $42.00 transaction at GAMESTOP was declined on your card ending in 1111.' }, reason: 'declined' },
  { name: 'shipping', msg: { from: 'Amazon.ca <shipment-tracking@amazon.ca>', subject: 'Your order has shipped', date: D, text: 'Your package with 2 items has shipped. Order total: $54.99. Track your package.' } },
  { name: 'newsletter with prices', msg: { from: 'Some Store <news@store.example>', subject: 'New arrivals', date: D, text: 'Jackets from $49.99. Shoes now $79.00. Shop now.' } },
  { name: 'password changed', msg: { from: 'TD <noreply@td.com>', subject: 'Security notice', date: D, text: 'Your password was changed. If this wasn’t you, call us.' } },
];
