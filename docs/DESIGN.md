# Design plan

Money is a home-screen web app that should feel like Apple built it. This page covers the decisions behind it.

## Principles

- **One number first.** Every tab opens on its headline: your balance, what you spent, your rings. Detail sits one tap away in a sheet.
- **Native idioms only.** Large titles that collapse into a frosted bar, a floating glass tab bar, inset grouped lists, bottom sheets you can drag down, centered alerts, iOS switches and segmented controls. No web-style navigation.
- **System everything.** SF Pro via `-apple-system`, Apple's system colors and grouped backgrounds, light and dark from the OS, Dynamic Type sizes from the HIG type ramp.
- **Motion with weight.** Spring curves (CSS `linear()` springs, with cubic-bezier fallbacks) for sheets, tabs, rings and toggles. Press states scale down slightly. Haptic taps on iOS 18+ through the switch-checkbox technique, and on Android through the Vibration API. Reduced Motion turns all of it into quick fades.
- **Privacy is the architecture.** The repo is public, so it only ever holds ciphertext. Plaintext exists in memory while unlocked and disappears on lock.

## Tabs

| Tab | What you see |
|---|---|
| **Summary** | The date and your avatar (Settings), like the Health app. Big balance with a daily chart you scrub with a finger, as in Stocks (range 1M · 3M · 6M · YTD · ALL), money in / out / net. **This month** card: Fitness rings for the budget on black (Spent, Saved, Eating out) and what's left to spend a day, or, with no budget, everyday spending so far against the usual by this day. **Highlights**: the three most important insight cards, Show All for the rest, each opening a detail sheet. **Coming up**: bills due in two weeks with calendar-style date chips. Accounts: bank sync, bank emails waiting to be checked, and statement health. |
| **Spending** | Built around one question: how much, and more or less than usual? Month / Year segmented control, the period as a title with ‹ › (tap it for a list; swipe the card). One big total and a plain-English pill ("$223 more than September by now", compared with the same point of the period before). Month: running-total line for this month against last month in gray and the budget as a dashed line, scrubbable with a readout. Year: a bar per month with the average; tap one to open that month. "Everyday spending · Change" at the bottom of the card. Budget card (left to spend, a today tick, per day). Where it went: a 100% colour bar, then each category with payments, its change against last month in words, amount and share (six shown, Show All). Top places. |
| **Activity** | List or **Calendar**. List: search (merchant, category, amount, month, notes) plus filter chips (Money Out, Money In, One-offs, Reversed). Grouped by day with day totals. Tap a transaction to change its category; Money offers **Apply to all N from this merchant** and saves that as a rule (at stores that sell everything, *Only This One* comes first). One-off switch. **Split** divides a charge between categories; a split charge stays one row here. Notes on any transaction. Calendar: a month grid where each day's dot grows with what went out (Fitness history style), no-spend days counted; tap a day for its transactions. |
| **Budget** (sheet) | Opened from Summary, Spending or Settings. From your take-home pay, savings goal and start date: Apple Watch-style rings for **Saved** (green), **Spent** (red) and **Eating out** (cyan) on a black card, take-home / save / spend pills, every line against its budget with green, orange or red bars, a month-by-month chart and table. Before the start date it previews the plan against your months so far. |

Three tabs (Summary, Spending, Activity) in a floating glass tab bar. Settings, the budget, the importer and every drill-down are bottom sheets. Settings → Export Transactions writes a CSV (split charges as their parts, formula-looking text defused). On a phone the app behind recedes like an iOS card stack. On desktop (1000px and wider) the tab bar becomes a glass sidebar, content sits in a 760px column, and sheets become centered form sheets.

## Categories and "Everyday"

Categories live in `data/rules.json`, and each has `everyday: true/false`. **Everyday** leaves out tuition, travel, immigration and government, money sent to people, and anything you switch to *One-off*. **Everything** counts all spending except moves between your own accounts. Refunds reduce their category. Reversals, corrections and waived fees are paired with the transaction they undo and left out of totals entirely, so *net = balance change* holds for every month.

## Split charges

A raw transaction can carry `parts` (split by hand) or `items` (from an Amazon order history). `buildModel` turns it into one model row per category (`id~k`, `partOf`), scaled so the parts add up to the charge to the cent, so every total, chart, budget and insight counts each part in its own category with no special cases. The whole charge is also in `byId` (with `split`) for Activity, which shows it as one row, and for the transaction sheet. A refund of the whole charge nets out all its parts; a refund of one item nets out that part.

## Data pipeline

```
PDF ──pdf.js──▶ positioned text ──cibc-parser (CIBC) / generic-parser (any bank)──▶ statement
CSV / OFX / QFX / QIF ──file-formats──▶ transactions ──split by month──▶ statements
   (on device)                                          │  summary: period, opening, withdrawals, deposits, closing
                                                        │  rows: date | description | withdrawals | deposits | balance
                                                        ▼
                      reconcile ─▶ sanitize (strip card/ref/account numbers) ─▶ dedupe ─▶ categorize (your rules → rules.json)
                                                        ▼
                                     vault (in memory) ──AES-256-GCM──▶ data/vault.enc.json
```

The parser reads x-positions from the table header, so every amount lands in the right column. It detects whether CIBC printed each amount on the first or last line of a multi-line transaction. It verifies the printed running balance wherever one appears. A statement only counts as reconciled when all of these hold to the cent:

1. opening + deposits − withdrawals = closing,
2. the deposits total matches the bank's summary,
3. the withdrawals total matches the bank's summary,
4. every printed running balance matches.

Anything else is flagged in red, and importing it needs an explicit *Import anyway*.

**Categories** (`js/categorize.js`, `data/rules.json` → `lexicon`): kind-of-transaction words, MCC codes, then merchant rules and ~900 world brands (earliest-named merchant wins, longest match on ties), then everyday words in many languages, then weak hints. Matching is token-based on accent-free text, and each distinct merchant is categorised once per rebuild (memoised), so a 20,000-transaction vault re-saves in ~150 ms. Your own merchant rules also match other branches of the same name.

**Other banks** (`js/generic-parser.js`, `js/file-formats.js`, `js/parse-util.js`). No per-bank templates; the general reader works from what every statement has:

- *Header words* in seven languages locate the date, description, debit, credit, amount and balance columns, and amounts snap to the nearest column.
- *Dates* in numeric, ISO and written forms (with month names in seven languages). Day/month order is settled by any date that can only be read one way (13/02), then by which order keeps dates in sequence. Missing years come from the statement period, rolling over at New Year.
- *Amounts* with either decimal separator, spaces or apostrophes for thousands, currency symbols, and the signs banks use (−, trailing −, parentheses, CR/DR, Soll/Haben).
- *Money in vs out*, strongest first: the column, a printed sign, then the running balance. Where only some lines show a balance, it solves for the fewest sign flips that make each balance add up. Descriptions ("salary", "refund", "Gehalt"…) are only a last resort, and the importer then says so.
- *Credit cards* are recognised ("minimum payment", "credit limit"…) and read the other way round: charges are money out, and the balance owed counts as negative.
- *Layouts*: amount on the first or last line of a multi-line entry, dates printed once per day, two date columns, newest-first order.
- *Exports*: CSV delimiter, header row, decimal separator and columns are detected (or inferred from the data when there's no header). OFX ledger balances and CSV running balances give opening/closing balances per month. A file with no balances at all is imported as *Not checked* rather than *Doesn't match*.

On the synthetic CIBC statements the general reader produces exactly the same transactions as the CIBC reader, which the tests check.

## Security model

| Threat | Mitigation |
|---|---|
| Someone reads the public repo | Only `data/vault.enc.json` is committed: AES-256-GCM, with the key derived by PBKDF2-SHA-256 at 600,000 iterations and a random salt. Header fields are bound as associated data, so tampering is detected. |
| Weak passphrase | 12-character minimum plus a strength check, with a nudge toward four or more random words. The file is public, so the passphrase is the whole defense. |
| Statement PDFs leak | They're read in memory and never stored. `*.pdf` is in `.gitignore`. |
| Account numbers | The parser never reads the header block. Descriptions are scrubbed of card numbers, 5+ digit runs and account or transit fragments before storage, and a test enforces this. |
| Biometric unlock | Optional, per device. A platform passkey (iCloud Keychain, user verification required) evaluates the WebAuthn PRF extension. HKDF of that secret encrypts the raw vault key, and the result is stored only in that browser. Releasing it needs Face ID or Touch ID on that device; the passphrase is never stored. It's bound to the vault's KDF salt, so a passphrase change retires it. |
| Accounts and sync | Optional (needs the D1 binding and an `INVITE_CODE` secret). Each account stores one vault envelope plus its public KDF salt. The browser derives an auth token as HKDF(raw vault key, "money/cloud-auth/v1"); the server keeps only SHA-256 of it, so reading or writing a vault needs the passphrase and the server never sees anything it could decrypt with. Accounts can't see each other. Unknown usernames get a stable fake KDF salt so the API doesn't reveal who has an account, wrong tokens are throttled (10 per 15 minutes per account), writes must be same-origin, and saves compare-and-swap on the vault's revision, so a stale device is asked which version to keep instead of overwriting. Creating an account needs the invite code. |
| Online guessing / lockout | Each token check first reserves an attempt atomically (`INSERT … ON CONFLICT … RETURNING`), keyed by account + network (10 per 15 minutes), plus a looser per-account cap (300), so parallel guesses can't slip under the limit and a stranger can't lock the owner out. Clients refuse KDF settings weaker than 100k iterations or a short salt, so a tampered server can't ask for cheap keys. Fake answers for unknown usernames are keyed by a random per-site secret kept in D1. |
| Lost or overwritten edits | Every save is a compare-and-swap on the revision *and* the key it was authorised with (a slow old-key request can't undo a passphrase change). "Keep this device's" re-saves as a newer revision instead of forcing an older one. A sync only marks what it actually uploaded. If another device changed the passphrase, edits this device hadn't synced are kept aside and offered as a file after unlocking. |
| Forgotten passphrase | Each account gets a random 120-bit recovery key (24 characters). The browser wraps the raw vault key with AES-GCM under HKDF(recovery key, username) and the server stores only that blob, served to anyone because it's useless without the key (unknown usernames get a stable fake). The key itself lives only inside the encrypted vault, so Settings can show it and a passphrase change re-wraps the new key. A change that can't re-wrap it deletes the stale blob. A device with Face ID on can also reset the passphrase, since its passkey releases the raw key. |
| Bank sync (Plaid) | Optional (needs `PLAID_CLIENT_ID` and `PLAID_SECRET` on the Worker). The bank sign-in happens on Plaid's **Hosted Link** page in its own tab, so the app's CSP stays `script-src 'self'` with no third-party script or frame. The Worker creates the link token (Plaid sees a per-site HMAC of the username, not the username), and the browser polls `/bank/finish` until Plaid reports the session done; the public token is exchanged on the Worker and the access token returned to the browser, which keeps it only inside the encrypted vault. Each sync sends it back with the account token; the Worker adds the secret, pages through `/transactions/sync`, trims each transaction to date, amount, description and category, and stores nothing. Account masks are dropped. Synced transactions only fill days after the last statement file, and a file added later replaces them. |
| Bank emails (Gmail) | Optional (needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`). Sign-in is Google's OAuth code flow with PKCE in its own tab: `/mail/link` stores SHA-256(state) and SHA-256 of a random browser nonce in `mail_handoff`, sets the nonce as an HttpOnly `__Host-` SameSite=Lax cookie, and returns Google's URL; the callback only accepts the code in a browser carrying that cookie (otherwise someone could send you their own link and collect your Gmail access); Google redirects to `/api/v1/mail/callback`, which parks the one-time code (15 minutes at most) and sends the tab to `mail-done.html`; the app polls `/mail/finish` with the state and its PKCE verifier, and the Worker exchanges the code (deleting it first) and returns the refresh token to the browser, which keeps it only in the vault. `/mail/token` swaps it for a one-hour access token. The browser then calls the Gmail API itself (`connect-src https://gmail.googleapis.com`, `gmail.readonly`): a search for alert-like words since the last check, skipping messages it has seen, five fetches at a time. `js/email-parse.js` decodes MIME/.eml and Gmail parts (base64, quoted-printable, RFC 2047, charsets, HTML tables to "label | value" rows, forwarded blocks), rejects non-transactions by phrase class (codes, declines, statements, reminders, balances, security, shipping, promos, receipts) unless a strong transaction phrase overrides, scores every amount by the words around it (transaction verbs, labels, the subject; balance/limit/threshold words push down), and reads merchant (labels, "at/with/to/from" phrases with stop words, "X sent you", "paid X"), date (labels, "on …", read against the email's date with day/month order chosen by distance) and direction. `js/mail.js` routes results: ignored sources dropped, followed sources with a sure reading added, everything else to `vault.mail.pending`; transactions get `ext: "mail:<hash>"`, so `syncStatements` and `commitImport` treat them like feed rows, `sameTxn` skips duplicates (same cents within a day, or within three days with a shared word), and `applyBankSync` replaces a matching alert with the feed's row (`absorbAlert`, keeping edits). |
| Phone left unlocked | Auto-lock after 1, 2, 5 or 15 minutes idle, and after more than a minute in the background. Locking drops the key and wipes the DOM. |
| Malicious script | Strict CSP: `script-src 'self'`, `connect-src 'self' https://api.github.com` (the sync API is same-origin), no inline scripts, and pdf.js vendored rather than loaded from a CDN. Statement text is HTML-escaped everywhere. |
| GitHub token theft | Optional. It's a fine-grained token for one repo with Contents read/write, stored in localStorage **encrypted with the vault key**. |
| Search engines | `noindex, nofollow, noarchive` meta tags, plus an `X-Robots-Tag` header on Cloudflare. |
| Hosting | Cloudflare Workers (static assets) from a private repo. `_headers` sends a real CSP with `frame-ancestors 'none'`, plus HSTS and nosniff. Optional Cloudflare Access email login puts even the ciphertext behind auth. |

## Files

- `index.html`: shell, icon sprite, CSP
- `css/app.css`: design tokens and components
- `js/app.js`: boot, lock/unlock, auto-lock, tabs; `js/state.js` holds in-memory state
- `js/crypto.js`: WebCrypto vault format; `js/store.js` handles repo, account and local copies, the GitHub API and export
- `js/cloud.js`: account sign-up, sign-in and sync client; `worker/index.js`: the sync API (Cloudflare Worker + D1)
- `js/bank.js`: turns a bank-feed sync into vault transactions and monthly statements (balances worked back from the bank's balance); `js/views/bank.js`: the Bank Sync sheet; `bank-done.html`: the page Plaid returns to
- `js/email-parse.js`: reads bank alert emails (MIME, Gmail, pasted text) into date, amount, merchant and direction; `js/mail.js`: adds them to the vault; `js/gmail.js`: the Gmail search and fetch in the browser; `js/views/mail.js`: the Bank Emails sheet; `mail-done.html`: the page Google returns to
- `js/analysis.js`: recurring charges, pace, unusual and double charges, cash flow and the rest of the insights' maths; `js/amazon.js`: reads Amazon's order-history zip/CSV and matches shipments to charges
- `js/statements.js` (one entry point for every file), `js/cibc-parser.js`, `js/generic-parser.js`, `js/file-formats.js`, `js/parse-util.js`, `js/pdf-text.js`, `js/categorize.js`, `js/ledger.js`: pure logic shared with the Node tools and tests
- `js/ui.js` (sheets, alerts, haptics) and `js/charts.js` (balance scrubber, stacked columns, rings)
- `js/views/*`: one file per tab plus sheets, the importer and settings
- `sw.js`, `manifest.webmanifest`, `icons/`: installable PWA that works offline
- `tools/vault.mjs`: command-line check, import and report; `tools/make-icons.mjs`; `tools/vendor-pdfjs.mjs`
- `tests/`: parser, reconciliation, crypto and privacy tests against synthetic CIBC-layout PDFs, other banks' layouts (UK, US, German, Indian, credit card) and CSV/OFX/QIF exports; `tests/cloud.mjs` runs the sync API (including recovery) against an in-memory D1
