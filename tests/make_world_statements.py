"""Generate SYNTHETIC statement PDFs in other banks' styles, for the general reader's tests.

Every name and amount is made up. Files are written to the folder you pass in (never into the repo).

    python3 tests/make_world_statements.py OUT_DIR
"""
import sys
import os
from reportlab.lib.pagesizes import A4, letter
from reportlab.pdfgen import canvas


def uk(path):
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont('Helvetica-Bold', 14); c.drawString(40, 800, 'Sample Bank plc')
    c.setFont('Helvetica', 9)
    c.drawString(40, 784, 'Current account statement')
    c.drawString(330, 784, '1 May 2026 to 31 May 2026')
    y = 740
    c.setFont('Helvetica-Bold', 9)
    for x, h in [(40, 'Date'), (110, 'Payment type and details'), (360, 'Paid out'), (440, 'Paid in'), (515, 'Balance')]:
        c.drawString(x, y, h)
    c.setFont('Helvetica', 9)
    rows = [
        ('01 May 26', 'BALANCE BROUGHT FORWARD', None, None, '840.00'),
        ('02 May 26', 'CARD PAYMENT TO SAINSBURYS', '31.20', None, '808.80'),
        (None, 'ON 01 MAY', None, None, None),
        ('08 May 26', 'BANK GIRO CREDIT SAMPLE EMPLOYER', None, '1,950.00', '2,758.80'),
        ('15 May 26', 'DIRECT DEBIT COUNCIL TAX', '120.00', None, None),
        ('15 May 26', 'CARD PAYMENT TO COSTA COFFEE', '3.40', None, '2,635.40'),
        ('29 May 26', 'STANDING ORDER RENT', '900.00', None, '1,735.40'),
        ('31 May 26', 'BALANCE CARRIED FORWARD', None, None, '1,735.40'),
    ]
    for d, desc, out, inn, bal in rows:
        y -= 16
        if d: c.drawString(40, y, d)
        c.drawString(110, y, desc)
        if out: c.drawRightString(400, y, out)
        if inn: c.drawRightString(480, y, inn)
        if bal: c.drawRightString(555, y, bal)
    c.drawString(270, 40, 'Page 1 of 1')
    c.save()
    return '2026-05 840.00 1735.40 5'


def card(path):
    c = canvas.Canvas(path, pagesize=letter)
    c.setFont('Helvetica-Bold', 14); c.drawString(40, 750, 'Sample Rewards Credit Card')
    c.setFont('Helvetica', 9)
    c.drawString(40, 734, 'Statement period: Jun 08, 2026 - Jul 07, 2026')
    c.drawString(40, 718, 'Previous balance'); c.drawRightString(300, 718, '$1,204.33')
    c.drawString(40, 704, 'New balance'); c.drawRightString(300, 704, '$389.12')
    c.drawString(40, 690, 'Minimum payment due'); c.drawRightString(300, 690, '$10.00')
    c.drawString(40, 676, 'Payment due date: Jul 28, 2026')
    c.drawString(40, 662, 'Credit limit'); c.drawRightString(300, 662, '$4,000.00')
    y = 630
    c.setFont('Helvetica-Bold', 9)
    for x, h in [(40, 'Trans.'), (90, 'Posted'), (140, 'Description'), (520, 'Amount ($)')]:
        c.drawString(x, y, h)
    c.drawString(40, y - 10, 'date'); c.drawString(90, y - 10, 'date')
    y -= 10
    c.setFont('Helvetica', 9)
    rows = [
        ('Jun 10', 'Jun 11', 'SPOTIFY P1234ABCD STOCKHOLM', '11.99'),
        ('Jun 14', 'Jun 15', 'PAYMENT - THANK YOU', '-1,204.33'),
        ('Jun 20', 'Jun 21', 'AIR CANADA 0141234567890', '320.00'),
        ('Jun 30', 'Jul 01', 'METRO 123 TORONTO ON', '57.13'),
    ]
    for td, pd, desc, amt in rows:
        y -= 16
        c.drawString(40, y, td); c.drawString(90, y, pd); c.drawString(140, y, desc); c.drawRightString(570, y, amt)
    c.save()
    return '2026-07 -1204.33 -389.12 4'


def german(path):
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont('Helvetica-Bold', 13); c.drawString(40, 800, 'Beispielbank AG')
    c.setFont('Helvetica', 9)
    c.drawString(40, 784, 'Kontoauszug 7/2026  Zeitraum: 01.07.2026 bis 31.07.2026')
    c.drawString(40, 768, 'Alter Kontostand vom 30.06.2026'); c.drawRightString(555, 768, '1.500,00 H')
    y = 740
    c.setFont('Helvetica-Bold', 9)
    for x, h in [(40, 'Buchung'), (100, 'Valuta'), (160, 'Vorgang'), (480, 'Soll'), (530, 'Haben')]:
        c.drawString(x, y, h)
    c.setFont('Helvetica', 9)
    rows = [
        ('01.07.', '01.07.', 'Lastschrift Miete Juli', '850,00', None),
        ('10.07.', '10.07.', 'Kartenzahlung EDEKA Berlin', '64,18', None),
        ('25.07.', '25.07.', 'Gutschrift Gehalt Beispiel GmbH', None, '2.310,00'),
    ]
    for b, v, desc, soll, haben in rows:
        y -= 16
        c.drawString(40, y, b); c.drawString(100, y, v); c.drawString(160, y, desc)
        if soll: c.drawRightString(510, y, soll)
        if haben: c.drawRightString(560, y, haben)
    y -= 24
    c.drawString(40, y, 'Neuer Kontostand vom 31.07.2026'); c.drawRightString(555, y, '2.895,82 H')
    c.save()
    return '2026-07 1500.00 2895.82 3'


if __name__ == '__main__':
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for name, fn in [('uk.pdf', uk), ('card.pdf', card), ('german.pdf', german)]:
        print(name, fn(os.path.join(out, name)))
