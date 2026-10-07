# Abraar Money — private finance PWA

An iOS-style personal finance app for Abraar: real CIBC statement data
(Jan–Sep 2026, 378 transactions, every month reconciled to the cent),
an encrypted data file, and a budget plan that starts Nov 2, 2026 at IQVIA.
Static site — no build step, no server. Vanilla JS + pdf.js (CDN).

## Files
- `index.html`, `styles.css`, `app.js` — the app
- `data.enc.json` — AES-256-GCM encrypted data (PBKDF2-SHA256, 200k iterations)
- `rules.json` — categories, colors, merchant→category rules (editable)
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA shell (offline, installable)
- `build_data.mjs` / `build_data.py` — regenerates `data.enc.json`

## 1. Repo & Pages — the privacy tradeoff (read this first)
This repo is **private**. GitHub Pages on a private repo requires GitHub Pro,
**and a Pages site is a public URL even when the repo is private** — anyone
with the link can load the app shell. That is acceptable *only* because the
data itself is encrypted: `data.enc.json` is ciphertext and useless without
your passphrase. Options, safest first:
1. **Keep it private** (current setup): open the app from the Muse-hosted
   link or run it locally (`python3 -m http.server` in this folder →
   http://localhost:8000). Nothing is public.
2. **GitHub Pages**: fine if you accept a public shell URL. Never commit
   unencrypted data — only `data.enc.json` as produced by the app/builder.
Raw statement PDFs are in `.gitignore` and must never be committed.

## 2. How data.enc.json was made
`build_data.mjs` reads the extracted transactions, builds a payload
(transactions + statement summaries + budget plan), generates a **random
temporary passphrase**, and encrypts with the exact scheme the browser uses
(PBKDF2-SHA256 → AES-256-GCM; salt + IV in the file). Re-run anytime:
```
node build_data.mjs        # or: python3 build_data.py
```

## 3. Set YOUR passphrase (do this first!)
The temporary passphrase was printed by the build script and saved **outside
this repo** at `~/workspace/your_files/pwa-temp-passphrase.txt`.
1. Open the app, unlock with the temporary passphrase.
2. Go to **Plan → Security & data → Change passphrase & export encrypted file**.
3. Set your own passphrase (8+ chars), download the new `data.enc.json`.
4. Replace the committed `data.enc.json` with the download (upload via GitHub
   web UI, or the in-app GitHub commit option below). Delete the temp file.

## 4. Install on iPhone
Open the app URL in **Safari** → Share → **Add to Home Screen**. It launches
full-screen, works offline, and uses the app icon. (Install requires the
https Muse link or a Pages URL — a plain http://localhost page on your
computer won't be reachable from the phone.)

## 5. Adding next month's statement
1. Download the CIBC PDF as usual (**never commit it** — it's gitignored).
2. In the app: **Activity → ＋ Statement**, pick the PDF. Parsing happens
   entirely in your browser (pdf.js). The app extracts transactions by the
   balance-step method, de-dupes against what you have, auto-categorizes with
   `rules.json` + your on-device rules, and **reconciles** against the
   statement's opening/closing balances — a mismatch is flagged in red with
   the amounts before you confirm.
3. Tap **Add N transactions**. To make it permanent, export the updated
   encrypted file (Plan → Change passphrase flow downloads a fresh
   `data.enc.json` with your current passphrase) and commit it — or use
   **Plan → Commit encrypted file to GitHub**.

## 6. Categories & rules
Tap any transaction in Activity to change its category; "Apply to all"
updates every transaction from that merchant and saves a merchant rule on
this device. **Plan → Export updated rules.json** downloads a merged rules
file to commit back to the repo.

## 7. Optional GitHub commit from the app
Plan → "Commit encrypted file to GitHub (optional)". It re-encrypts with your
current passphrase and PUTs `data.enc.json` via the GitHub API. The token
lives **only in this browser's localStorage** and is sent only to
api.github.com. Use a fine-grained token scoped to **this one repo** with
Contents read & write. Leave it blank and use file downloads if unsure.

## Privacy notes
- No account or transit numbers exist anywhere in this app or its data.
- Auto-locks after 5 minutes idle and when the app is hidden; the passphrase
  is never stored, only held in memory while unlocked.
- `noindex` meta + the encrypted payload keep search engines and casual
  visitors out.
- "Export transactions (JSON backup)" produces an **unencrypted** file —
  store it somewhere safe.
