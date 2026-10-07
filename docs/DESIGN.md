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
| **Overview** | Big balance. A daily balance chart you scrub with a finger, as in Stocks: the header shows the date and balance under your finger, and you feel a tap at each month boundary. Range picker: 1M · 3M · 6M · YTD · ALL. Money in / out / net for the range. Swipeable insight cards written from your data (most visited merchant, everyday average versus plan, biggest month, balance trend, a category that moved, plan countdown, eating out). Statement health. |
| **Spending** | Month pager (‹ September 2026 ›, or tap for a list including All Months). Everyday / Everything toggle. Total versus average, a stacked color bar, then categories with counts and shares. Tap a category for a sheet with its monthly columns and transactions. Monthly stacked columns (tap a month to jump to it). Top merchants with visit counts. |
| **Activity** | Search (merchant, category, amount, month) plus filter chips (Money Out, Money In, One-offs, Reversed). Grouped by day with day totals. Tap a transaction to change its category; Money offers **Apply to all N from this merchant** and saves that as a rule. One-off switch. |
| **Plan** | From your start date: Apple Watch-style rings for **Saved** (green), **Spent** (red) and **Eating out** (cyan), the Fitness palette on a black card. Take-home, save percentage and spend pills. Budget against actual for every line, with green, orange or red bars and amount left or over. Month history. Before the start date, it previews the plan against your latest full month. |

Settings, the importer and every drill-down are bottom sheets. On a phone the app behind recedes like an iOS card stack. On desktop (1000px and wider) the tab bar becomes a glass sidebar, content sits in a 760px column, and sheets become centered form sheets.

## Categories and "Everyday"

Categories live in `data/rules.json`, and each has `everyday: true/false`. **Everyday** leaves out tuition, travel, immigration and government, money sent to people, and anything you switch to *One-off*. **Everything** counts all spending except moves between your own accounts. Refunds reduce their category. Reversals, corrections and waived fees are paired with the transaction they undo and left out of totals entirely, so *net = balance change* holds for every month.

## Data pipeline

```
CIBC PDF ──pdf.js──▶ positioned text ──cibc-parser──▶ statement
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

## Security model

| Threat | Mitigation |
|---|---|
| Someone reads the public repo | Only `data/vault.enc.json` is committed: AES-256-GCM, with the key derived by PBKDF2-SHA-256 at 600,000 iterations and a random salt. Header fields are bound as associated data, so tampering is detected. |
| Weak passphrase | 12-character minimum plus a strength check, with a nudge toward four or more random words. The file is public, so the passphrase is the whole defense. |
| Statement PDFs leak | They're read in memory and never stored. `*.pdf` is in `.gitignore`. |
| Account numbers | The parser never reads the header block. Descriptions are scrubbed of card numbers, 5+ digit runs and account or transit fragments before storage, and a test enforces this. |
| Phone left unlocked | Auto-lock after 1, 2, 5 or 15 minutes idle, and after more than a minute in the background. Locking drops the key and wipes the DOM. |
| Malicious script | Strict CSP: `script-src 'self'`, `connect-src 'self' https://api.github.com`, no inline scripts, and pdf.js vendored rather than loaded from a CDN. Statement text is HTML-escaped everywhere. |
| GitHub token theft | Optional. It's a fine-grained token for one repo with Contents read/write, stored in localStorage **encrypted with the vault key**. |
| Search engines | `noindex, nofollow, noarchive` meta tags. |

## Files

- `index.html`: shell, icon sprite, CSP
- `css/app.css`: design tokens and components
- `js/app.js`: boot, lock/unlock, auto-lock, tabs; `js/state.js` holds in-memory state
- `js/crypto.js`: WebCrypto vault format; `js/store.js` handles repo and local copies, the GitHub API and export
- `js/cibc-parser.js`, `js/pdf-text.js`, `js/categorize.js`, `js/ledger.js`: pure logic shared with the Node tools and tests
- `js/ui.js` (sheets, alerts, haptics) and `js/charts.js` (balance scrubber, stacked columns, rings)
- `js/views/*`: one file per tab plus sheets, the importer and settings
- `sw.js`, `manifest.webmanifest`, `icons/`: installable PWA that works offline
- `tools/vault.mjs`: command-line check, import and report; `tools/make-icons.mjs`; `tools/vendor-pdfjs.mjs`
- `tests/`: parser, reconciliation, crypto and privacy tests against synthetic CIBC-layout PDFs
