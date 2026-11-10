"""Generate a SYNTHETIC credit card statement in the CIBC Visa layout (two dates per row, a spend-category
column, foreign-currency lines under charges abroad, payments in their own section), for parser tests.
Every name and amount is made up. Written to the folder you pass in (never into the repo).

    python3 tests/make_cibc_card.py OUT_DIR
"""
import sys, os, json
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

def fmt(v): return f"{v:,.2f}"

def make(path, period, rows, payments, prev_balance, foreign_style=0):
    """rows: (trans, post, desc, category, amount, foreign_line or None); amount + = charge, - = credit."""
    W, H = letter
    c = canvas.Canvas(path, pagesize=letter)
    charges = round(sum(a for *_, a, f in rows if a > 0), 2)
    credits = round(-sum(a for *_, a, f in rows if a < 0), 2)
    paid = round(sum(a for _, _, _, a in payments), 2)
    total = round(prev_balance - paid - credits + charges, 2)
    # page 1: summary
    c.setFont('Helvetica-Bold', 9); c.drawString(40, H - 30, 'SAMPLE STATEMENT - SYNTHETIC TEST DATA - NOT A REAL ACCOUNT')
    c.setFont('Helvetica-Bold', 13); c.drawString(40, H - 55, 'CIBC Aventura® Visa* Card')
    c.setFont('Helvetica', 9)
    c.drawString(40, H - 75, 'SAMPLE PERSON'); c.drawString(330, H - 75, 'Account number 4500 XXXX XXXX 1234')
    c.drawString(330, H - 88, f'Statement date {period[2]}')
    c.drawString(330, H - 101, f'Statement period {period[0]} to {period[1]}')
    y = H - 140
    c.setFont('Helvetica-Bold', 11); c.drawString(40, y, 'Account Summary'); y -= 18
    c.setFont('Helvetica', 9)
    for k, v in [('Previous balance', f'${fmt(prev_balance)}'), ('Payments', f'- {fmt(paid)}'), ('Other credits', f'- {fmt(credits)}'),
                 ('Purchases', fmt(charges)), ('Cash advances', '0.00'), ('Interest', '0.00'), ('Fees', '0.00'), ('Total balance', f'= ${fmt(total)}')]:
        c.drawString(40, y, k); c.drawRightString(300, y, v); y -= 14
    y -= 10
    c.drawString(40, y, 'Minimum payment $10.00'); c.drawString(200, y, 'Payment due date Nov 15, 2026'); y -= 14
    c.drawString(40, y, 'Credit limit $5,000.00'); c.drawString(200, y, 'Available credit $3,000.00')
    c.setFont('Helvetica', 7); c.drawString(40, 30, 'Page 1 of 2'); c.showPage()
    # page 2: transactions
    c.setFont('Helvetica', 7); c.drawString(40, H - 25, 'SAMPLE STATEMENT - SYNTHETIC TEST DATA')
    y = H - 50
    c.setFont('Helvetica-Bold', 10); c.drawString(40, y, 'Your payments'); y -= 16
    c.setFont('Helvetica-Bold', 8)
    c.drawString(40, y, 'Trans'); c.drawString(78, y, 'Post'); y -= 10
    c.drawString(40, y, 'date'); c.drawString(78, y, 'date'); c.drawString(120, y, 'Description'); c.drawRightString(570, y, 'Amount($)'); y -= 14
    c.setFont('Helvetica', 8)
    for t, p, d, a in payments:
        c.drawString(40, y, t); c.drawString(78, y, p); c.drawString(120, y, d); c.drawRightString(570, y, fmt(a)); y -= 13
    c.setFont('Helvetica-Bold', 8); c.drawString(120, y, 'Total payments'); c.drawRightString(570, y, f'${fmt(paid)}'); y -= 24
    c.setFont('Helvetica-Bold', 10); c.drawString(40, y, 'Your new charges and credits'); y -= 16
    c.setFont('Helvetica-Bold', 8)
    c.drawString(40, y, 'Trans'); c.drawString(78, y, 'Post'); c.drawString(400, y, 'Spend'); y -= 10
    c.drawString(40, y, 'date'); c.drawString(78, y, 'date'); c.drawString(120, y, 'Description'); c.drawString(400, y, 'Categories'); c.drawRightString(570, y, 'Amount($)'); y -= 12
    c.setFont('Helvetica', 8); c.drawString(120, y, 'Card number 4500 XXXX XXXX 1234'); y -= 13
    for t, p, d, cat, a, f in rows:
        c.drawString(40, y, t); c.drawString(78, y, p); c.drawString(120, y, d); c.drawString(400, y, cat); c.drawRightString(570, y, fmt(a)); y -= 12
        if f:
            c.setFont('Helvetica', 7); c.drawString(130, y, f); c.setFont('Helvetica', 8); y -= 12
    c.setFont('Helvetica-Bold', 8); c.drawString(120, y, 'Total for 4500 XXXX XXXX 1234'); c.drawRightString(570, y, f'${fmt(round(charges - credits, 2))}'); y -= 14
    c.drawString(120, y, 'Total of new charges and credits'); c.drawRightString(570, y, f'${fmt(round(charges - credits, 2))}')
    c.setFont('Helvetica', 7); c.drawString(40, 30, 'Page 2 of 2')
    c.save()
    return {'charges': charges, 'credits': credits, 'payments': paid, 'total': total}

out = sys.argv[1]
rows = [
    ('Sep 27', 'Sep 29', 'TIM HORTONS #1234 TORONTO ON', 'Restaurants', 4.56, None),
    ('Sep 30', 'Oct 01', 'METRO 123 TORONTO ON', 'Retail and Grocery', 87.21, None),
    ('Oct 03', 'Oct 06', 'EMIRATES 1762412345678 DUBAI ARE', 'Transportation', 1512.34, 'FOREIGN CURRENCY 3,920.00 AED @ 0.385801'),
    ('Oct 04', 'Oct 06', 'EMIRATES SKYWARDS DUBAI ARE', 'Transportation', 96.45, 'FOREIGN CURRENCY 250.00 AED @ 0.385800'),
    ('Oct 09', 'Oct 10', 'AMAZON.CA*AB12CD34E AMAZON.CA ON', 'Retail and Grocery', 25.99, None),
    ('Oct 12', 'Oct 14', 'UBER* TRIP TORONTO ON', 'Transportation', 18.40, None),
    ('Oct 15', 'Oct 16', 'AMAZON.CA REFUND AMAZON.CA ON', 'Retail and Grocery', -25.99, None),
    ('Oct 18', 'Oct 20', 'NETFLIX.COM 866-579-7172 ON', 'Personal and Household Expenses', 18.99, None),
    ('Oct 21', 'Oct 22', 'EMIRATES DUTY FREE DUBAI ARE', 'Retail and Grocery', 61.73, 'FOREIGN CURRENCY 160.00 AED @ 0.385812'),
    ('Oct 23', 'Oct 24', 'SHOPPERS DRUG MART #0921 TORONTO ON', 'Health and Education', 32.10, None),
]
payments = [('Oct 02', 'Oct 03', 'PAYMENT THANK YOU/PAIEMENT MERCI', 450.00)]
info = make(os.path.join(out, 'visa-2026-10.pdf'), ('Sep 26', 'Oct 25, 2026', 'Oct 25, 2026'), rows, payments, 450.00)
print(json.dumps(info))
