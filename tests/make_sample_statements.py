"""Generate SYNTHETIC bank-statement PDFs that follow the CIBC chequing layout, for parser tests.

Every name and amount here is made up. The PDFs are written to a folder you pass in
(never into the repo) and are clearly marked as sample data.

    python3 tests/make_sample_statements.py OUT_DIR
"""
import sys
import os
import random
import calendar
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

def fmt(v):
    return f"{v:,.2f}"

def month_txns(year, month, rng):
    """(day, [description lines], amount) — negative = withdrawal."""
    days = calendar.monthrange(year, month)[1]
    t = []
    for d in sorted(rng.sample(range(1, days + 1), 14)):
        t.append((d, ['RETAIL PURCHASE 000001%06d' % rng.randint(0, 999999), 'COUCHE-TARD #2%02d' % rng.randint(0, 99)], -round(rng.uniform(2.5, 9.5), 2)))
    for d in sorted(rng.sample(range(1, days + 1), 4)):
        t.append((d, ['VISA DEBIT RETAIL PURCHASE 4506*********123', 'PROVIGO LE MARCHE MONTREAL QC'], -round(rng.uniform(18, 64), 2)))
    t.append((3, ['INTERNET BILL PAY 000000%06d' % rng.randint(0, 999999), 'FIZZ'], -34.49))
    t.append((5, ['E-TRANSFER 105%09d' % rng.randint(0, 10**9 - 1), 'Sample Person'], -60.00))
    t.append((15, ['PAYROLL DEPOSIT', 'SAMPLE EMPLOYER INC'], 1200.00))
    t.append((28, ['PAYROLL DEPOSIT', 'SAMPLE EMPLOYER INC'], 1200.00))
    t.append((9, ['VISA DEBIT PURCHASE 4506*********123', 'AMAZON.CA'], -42.10))
    t.append((11, ['VISA DEBIT PURCHASE REVERSAL', 'AMAZON.CA'], 42.10))
    t.append((days, ['SERVICE CHARGE', 'MONTHLY FEE'], -6.95))
    t.append((days, ['SERVICE CHARGE DISCOUNT', 'MIN BALANCE MET'], 6.95))
    # two identical coffees on the same day — both are real and must both survive
    t.append((12, ['RETAIL PURCHASE 000001000111', 'TIM HORTONS #1234'], -2.35))
    t.append((12, ['RETAIL PURCHASE 000001000111', 'TIM HORTONS #1234'], -2.35))
    if month == 4:
        t.append((20, ['INTERNET BILL PAY 000000123456', 'MCGILL UNIVERSITY'], -8150.00))
    t.sort(key=lambda x: x[0])
    return t

def draw_statement(path, year, month, opening, rng, amount_on_last_line=False):
    txns = month_txns(year, month, rng)
    days = calendar.monthrange(year, month)[1]
    wd = round(sum(-a for _, _, a in txns if a < 0), 2)
    dep = round(sum(a for _, _, a in txns if a > 0), 2)
    closing = round(opening - wd + dep, 2)

    c = canvas.Canvas(path, pagesize=letter)
    W, H = letter
    page_no = [1]
    total_pages = 2

    def header(first):
        c.setFont('Helvetica-Bold', 9)
        c.drawString(40, H - 30, 'SAMPLE STATEMENT - SYNTHETIC TEST DATA - NOT A REAL ACCOUNT')
        c.setFont('Helvetica-Bold', 14)
        c.drawString(40, H - 55, 'Account Statement')
        c.setFont('Helvetica', 9)
        c.drawString(40, H - 70, f'For {MON[month-1]} 1 to {MON[month-1]} {days}, {year}')
        c.drawString(380, H - 70, 'Account number 00-00000')
        c.drawString(380, H - 82, 'Branch transit number 00000')
        y = H - 110
        if first:
            c.setFont('Helvetica-Bold', 11); c.drawString(40, y, 'Account summary'); y -= 16
            c.setFont('Helvetica', 9)
            prev_m = MON[month - 1]
            c.drawString(40, y, f'Opening balance on {prev_m} 1, {year}'); c.drawRightString(300, y, f'${fmt(opening)}'); y -= 13
            c.drawString(40, y, 'Withdrawals'); c.drawString(230, y, '-'); c.drawRightString(300, y, fmt(wd)); y -= 13
            c.drawString(40, y, 'Deposits'); c.drawString(230, y, '+'); c.drawRightString(300, y, fmt(dep)); y -= 13
            c.drawString(40, y, f'Closing balance on {MON[month-1]} {days}, {year}'); c.drawString(230, y, '='); c.drawRightString(300, y, f'${fmt(closing)}'); y -= 26
            c.setFont('Helvetica-Bold', 11); c.drawString(40, y, 'Transaction details'); y -= 18
        c.setFont('Helvetica-Bold', 8.5)
        c.drawString(40, y, 'Date'); c.drawString(85, y, 'Description')
        c.drawRightString(410, y, 'Withdrawals ($)'); c.drawRightString(490, y, 'Deposits ($)'); c.drawRightString(570, y, 'Balance ($)')
        c.setFont('Helvetica', 8.5)
        return y - 16

    def footer():
        c.setFont('Helvetica', 7)
        c.drawString(40, 40, f'Page {page_no[0]} of {total_pages}')
        c.drawString(200, 40, 'Sample data generated for automated tests.')

    y = header(True)
    c.drawString(40, y, f'{MON[month-1]} 1'); c.drawString(85, y, 'Opening balance'); c.drawRightString(570, y, f'${fmt(opening)}'); y -= 13
    bal = opening
    last_day = None
    split_at = len(txns) // 2
    for i, (d, lines, amt) in enumerate(txns):
        if i == split_at:
            footer(); c.showPage(); page_no[0] += 1
            y = header(False)
            c.drawString(85, y, 'Balance forward'); c.drawRightString(570, y, f'${fmt(bal)}'); y -= 13
            last_day = None  # CIBC repeats the date at the top of a page
        bal = round(bal + amt, 2)
        end_of_day = i == len(txns) - 1 or txns[i + 1][0] != d or i + 1 == split_at
        if d != last_day:
            c.drawString(40, y, f'{MON[month-1]} {d}')
            last_day = d
        amt_line = len(lines) - 1 if amount_on_last_line else 0
        for j, text in enumerate(lines):
            c.drawString(85, y, text)
            if j == amt_line:
                c.drawRightString(410 if amt < 0 else 490, y, fmt(abs(amt)))
            if j == len(lines) - 1 and end_of_day:
                c.drawRightString(570, y, fmt(bal))
            y -= 11
        y -= 2
    c.drawString(40, y, f'{MON[month-1]} {days}'); c.drawString(85, y, 'Closing balance'); c.drawRightString(570, y, f'${fmt(closing)}')
    footer()
    c.save()
    return opening, wd, dep, closing, len(txns)

if __name__ == '__main__':
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    rng = random.Random(42)
    bal = 5000.00
    for m in range(1, 5):
        o, wd, dep, cl, n = draw_statement(os.path.join(out, f'sample-2026-{m:02d}.pdf'), 2026, m, bal, rng, amount_on_last_line=(m % 2 == 0))
        print(f'2026-{m:02d} opening {o:.2f} withdrawals {wd:.2f} deposits {dep:.2f} closing {cl:.2f} txns {n}')
        bal = cl
