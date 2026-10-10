# Money

A private, Apple-style finance app for your iPhone home screen. It's a static site plus a tiny sync API, hosted for free on Cloudflare Workers: no framework, no bundler, nothing to run.

- **Summary**: your balance with a Stocks-style chart you scrub with your finger; this month at a glance with Fitness-style rings for your budget (Spent, Saved, Eating out) and what's left to spend each day; **Highlights** that dig into your data (possible double charges, where the month is heading, subscriptions and bills with price rises, unusual charges, how much you keep, Amazon by what you bought, and more); bills coming up; your statements and bank
- **Spending**: pick a **Month** or **Year**. One big number for what you spent, a plain sentence saying how it compares ("$223 more than September by now"), and a chart of this month's running total against last month's (and your budget): drag a finger along it to read any day. In Year, a bar per month; tap one to open it. Then your budget left per day, **Where it went** (a colour bar and each category with its change from last month) and your top places. "Everyday spending · Change" switches to all spending.
- **Activity**: every transaction, searchable (names, amounts, categories, notes), or a **Calendar** of what went out each day. Re-categorize, split a charge across categories, add a note, or apply a change to all from a merchant (saved as a rule).
- **Budget** (from Summary, Spending or Settings): take-home pay and a savings goal split into a monthly budget, with rings, every line against its budget, and month by month
- **Add Statement**: reads statements from any bank on your device (PDF, or the CSV, OFX/QFX or QIF file online banking lets you download), removes duplicates, categorizes, and reconciles to the bank's balances. Or connect your bank once (Plaid) and new transactions come in on their own; or let Money read your bank's **email alerts** (Gmail, or paste any email) so purchases show up the day they happen; Amazon order history sorts Amazon charges by item
- **Accounts**: share the link with family. Everyone gets their own private account with every feature, synced across their iPhone and Mac.

**Privacy:** each account's data is one encrypted vault. The sync server (and the repo, for the original single-user vault `data/vault.enc.json`) only ever holds ciphertext: AES-256-GCM, with a key derived from the owner's passphrase (PBKDF2-SHA-256, 600k iterations). Statement PDFs never leave your device and are git-ignored. Account and transit numbers are never stored. The app auto-locks and asks search engines not to index it. See [docs/DESIGN.md](docs/DESIGN.md) for the design and the security model.

```
index.html              app shell (CSP, icon sprite)
manifest.webmanifest    install metadata
_headers                security headers (Cloudflare)
wrangler.jsonc          Cloudflare deploy config (publishes dist/ only, D1 database)
worker/index.js         sync API: stores encrypted vaults per account (Cloudflare D1)
sw.js                   offline cache (bump VERSION after changing files)
css/app.css             design system
js/                     app code: crypto, cloud sync, parser, ledger, charts, views
data/rules.json         categories + merchant rules (public, edit freely)
data/vault.enc.json     original single-user vault, encrypted (optional once you use accounts)
vendor/pdfjs/           pdf.js, vendored so no code loads from a CDN
icons/                  app icon + iPhone launch screens
tools/vault.mjs         command-line check / import / report
tools/build-site.mjs    copies the website files into dist/ for Cloudflare
tests/                  parser + reconciliation + crypto + sync API tests
docs/                   design notes and the vault JSON schema
```

---

## Setup

### 1. Get the code into your repo

This code lives on the `claude/apple-finance-pwa` branch of `abraar-money-dashboard`. Merge it into `main` (open a pull request on GitHub and merge it, or `git checkout main && git merge claude/apple-finance-pwa && git push`).

### 2. Host it for free on Cloudflare (recommended)

Cloudflare is free, works with a **private** repo (so the old history never goes public), and redeploys within about a minute whenever the repo changes, including when the app saves your vault.

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). It's free with no card needed.
2. Go to **Workers & Pages → Create → Import a repository**. Connect GitHub and allow **only `abraar-money-dashboard`**.
3. Keep the defaults: production branch `main`, build command empty, deploy command `npx wrangler deploy`. Then click **Deploy**.
4. Your app is live at `https://abraar-money-dashboard.<your-subdomain>.workers.dev`.

`wrangler.jsonc` tells Cloudflare what to do. Before each deploy, it runs `tools/build-site.mjs`, which copies **only** the website files into `dist/` (an allowlist), so tooling, tests, `node_modules`, or a statement PDF accidentally left in the repo are never published.

The `_headers` file gives the site strict security headers (CSP, `noindex`, no framing). **Save to GitHub** already knows your repo from the `money-repo` tag in `index.html`, so each save commits there and Cloudflare redeploys.

**Optional, but a strong extra layer: Cloudflare Access.** This puts an email login in front of the whole site, so strangers can't even download the encrypted file. It's free for up to 50 users:
Zero Trust (left sidebar) → **Access → Applications → Add an application → Self-hosted**. Set the domain to your `*.workers.dev` address, add a policy *Allow → Emails → your email*, use the **One-time PIN** login, and set session duration to 1 month. On your iPhone you'll enter an emailed code about once a month, before the passphrase screen.

<details>
<summary>Alternative: GitHub Pages</summary>

GitHub Pages on a **Free** plan needs a **public** repo (a private repo needs Pro, Team or Enterprise). Go to **Settings → Pages → Deploy from a branch → `main` / `(root)` → Save**. The site is at `https://<user>.github.io/<repo>/`.

> ⚠️ This repo's earlier commits contain the old dashboard, with **monthly balances and totals in plain text**. Before making it public, publish a fresh history:
>
> ```bash
> git checkout main && git pull
> git checkout --orphan fresh && git add -A && git commit -m "Money"
> git branch -D main && git branch -m main
> git push --force origin main
> git push origin --delete claude/apple-finance-pwa   # old branches still carry the old history
> ```
</details>

### 2b. Turn on accounts (so family can use it too)

Accounts let anyone you send the link to make their **own** private account with every feature: statements, plan, insights, Face ID and sync between their devices. Each account is a separate vault encrypted with its owner's passphrase. Nobody, including you as the site owner, can read anyone else's money.

1. **Database.** `wrangler.jsonc` declares a D1 database called `money-accounts`, and Cloudflare creates it automatically on the next deploy (look for "Provisioning" in the build log). If the log shows an error instead: **Storage & Databases → D1 → Create** a database named `money-accounts`, copy its ID, add `"database_id": "<that id>"` next to `"database_name"` in `wrangler.jsonc`, and push.
2. **Invite code.** In the dashboard open your Worker → **Settings → Variables and Secrets → Add** → type **Secret**, name `INVITE_CODE`, and a value only you know (a few random words). Save. Only people with this code can create accounts.
3. **Check:** open `https://<your site>/api/v1/status`. It should say `{"configured":true}`. Until both steps are done, the app works exactly as before, with no account option.

**Move your own data into an account:** unlock as usual → Settings → **Move to Cloud Sync**. Pick a username and enter the invite code; your passphrase stays the same. After that, the iPhone and Mac stay in step on their own and you don't need the GitHub token any more.

**Invite someone:** Settings → **Invite Someone** → **Share Link**. Send them the invite code separately (a text is fine). They open the link, tap **Create Account**, choose a username and passphrase, add their statements, and install it to their home screen. Several people can share one device: the lock screen asks who's using Money.

Good to know:

- **Forgot your passphrase?** Every account gets a **recovery key** when it's created (also in Settings → Recovery Key). Changing your passphrase in Settings gives you a new recovery key; the old one stops working. On the lock screen tap **Forgot passphrase?** and enter it, or use **Reset with Face ID** on a device where Face ID is on. Without either, nobody can reset it, including you as the site owner. That's what keeps it private.
- If two devices change the same account offline, the next sync asks which version to keep.
- Statements from **any bank** work: PDF statements in most layouts and languages, or the CSV, OFX/QFX or QIF download from online banking (the most reliable choice when a bank offers it). Scanned (image-only) PDFs can't be read.
- If you turned on Cloudflare Access (below), add each person's email to its policy so they can reach the site. Leave `/bank-done.html` and `/mail-done.html` reachable without it if you use bank sync or Gmail (they're static "go back to Money" pages with nothing private on them).
- To stop new sign-ups, change or delete `INVITE_CODE`. Existing accounts keep working while it's set; deleting it pauses sync for everyone until it's set again.

### 2c. Optional: bank sync, so you never download statements again

With accounts on, Money can pull new transactions straight from your bank through [Plaid](https://plaid.com) (it covers CIBC and most banks in Canada and the US). Each account connects its own bank; it's off until you add Plaid keys.

1. Sign up at **dashboard.plaid.com**. New teams in Canada and the US get the free **Trial** plan, which connects real banks (up to 10 connections), enough for a family.
2. In the Plaid dashboard, under **Developers → Keys**, copy the **client_id** and the **Production secret**.
3. Still in Plaid, under **Developers → API → Allowed redirect URIs**, add `https://<your site>/bank-done.html`.
4. In Cloudflare, open your Worker → **Settings → Variables and Secrets** and add `PLAID_CLIENT_ID` and `PLAID_SECRET`, both as type **Secret** (Workers → Settings, not Builds → Variables). Optional: `PLAID_ENV` = `sandbox` to try it with Plaid's test bank first (use the Sandbox secret then; in the test bank sign in with `user_good` / `pass_good`), and `PLAID_COUNTRIES` (default `CA,US`). Switching from sandbox to production later means disconnecting and connecting again in Money.
5. Check `https://<your site>/api/v1/status` says `"bank":true`, then in Money tap **+ → Connect Your Bank** (or Settings → Bank Sync).

How it works: you sign in to your bank on **Plaid's own page** (Money never sees your bank password), pick the account this vault follows, and Money brings in the transactions after your last statement file, already categorized (Plaid's category fills in when Money doesn't know a place). After that it syncs on its own whenever you open the app (every few hours), or tap **Sync Now**. Statement files stay the record: if you add one later, it replaces the synced days it covers. The Plaid connection key lives only inside your encrypted vault; the Worker adds Plaid's secret, passes the transactions through and stores nothing. If your bank asks you to sign in again, Bank Sync shows **Reconnect**.

### 2d. Optional: bank emails (Gmail), for transactions as they happen

Most banks can email you every time your card is used. Money can read those alerts and add the purchases right away, so the current month is up to date before the statement arrives. It works for anyone in the family whose alerts land in Gmail; each account connects its own Gmail. Anyone can also **paste** an alert or add **.eml** files from any email app with no setup at all (+ → Bank Emails).

To switch on Gmail (once, for the whole site):

1. At [console.cloud.google.com](https://console.cloud.google.com), create a project (e.g. "Money"), then **APIs & Services → Library → Gmail API → Enable**.
2. **Google Auth Platform → Branding/Audience**: user type **External**, app name "Money", your email as support contact. Under **Audience**, add every Gmail address that will connect as a **test user**, then click **Publish app**. (While it's in "Testing", Google ends Gmail sign-ins every 7 days. Published but unverified is fine for a family: Google shows a "Google hasn't verified this app" screen once; tap **Advanced → Go to Money**.)
3. **Data Access → Add or remove scopes**: add `https://www.googleapis.com/auth/gmail.readonly`.
4. **Clients → Create client → Web application**. Under **Authorized redirect URIs** add `https://<your site>/api/v1/mail/callback`. Copy the **Client ID** and **Client secret**.
5. In Cloudflare, open your Worker → **Settings → Variables and Secrets** and add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (type **Secret**).
6. Check `https://<your site>/api/v1/status` says `"mail":true`, then in Money tap **+ → Bank Emails → Connect Gmail**. Google's page has to come back to the same browser Money is open in; if Money says it came back to a different browser (it can happen from the iPhone Home Screen app), connect once from Money in Safari. The connection is saved in your vault, so it then works on all your devices.

Then turn on email alerts in your bank's app (look for **Alerts** or **Notifications**; set purchase alerts to $0 or $1 to get every one). If alerts go to another address, forward them to the connected Gmail, or paste them.

How it works: Gmail is asked (read-only) for emails that look like money alerts since the last check, and **your browser** reads them; no email passes through the Worker. An on-device language reader works out whether each email is a transaction at all (one-time codes, ads, "statement ready" notes, payment reminders, balance updates, declined purchases and shipping emails are skipped), then finds the sentence or table row with the money in it and pulls out the amount, the store or person, the date and which way the money went. Only those four things and the bank's name are kept, in your encrypted vault; card and account numbers never are. Alerts it isn't sure about, and the first ones from each bank, wait under **To Check**; switch on **Add new ones by themselves** for a bank and later alerts it's sure about are added on their own. Like bank sync, alerts only fill the days after your last statement, a statement added later replaces them, and if bank sync brings the same purchase, its copy wins (keeping your category and notes). The long-lived Google sign-in lives only inside your encrypted vault; the Worker only adds the Google client secret when the app asks for a fresh one-hour Gmail pass. **Disconnect Gmail** revokes it at Google.

**Why not an Amazon API?** Amazon has no API for your own orders (its APIs are for sellers and affiliates), and the unofficial tools log in as you with your Amazon password and scrape the website, which breaks often and is against Amazon's terms. Money uses the official route instead: **Amazon Orders** opens Amazon's data-request page for your store in one tap, and the zip it emails you sorts every order (see below).

### 3. Create your vault and set your passphrase

Open the site in Safari (on your phone or computer) and tap **Create Your Vault**. Choose a passphrase of at least 12 characters; four or more random words is ideal.

- Your vault file is public, so **the passphrase is the only thing protecting it**. Don't reuse one.
- **It can't be recovered.** Write it down somewhere safe, such as your password manager.

### 4. Add your statements (Jan–Sep)

**In the app (simplest):** tap **Add Statements**, choose all nine CIBC PDFs, and look over the reconciliation card for each month. A month reconciles when opening + deposits − withdrawals = closing and both totals match CIBC's summary to the cent. Then tap **Add 9 Statements**.

**Or on your computer**, to see the full reconciliation table first:

```bash
npm install                                   # once; installs pdf.js for the tools
mkdir statements && cp ~/Downloads/*.pdf statements/   # git-ignored, never committed
node tools/vault.mjs check statements/*.pdf   # prints the reconciliation table, writes nothing
node tools/vault.mjs import statements/*.pdf  # asks for your passphrase, writes data/vault.enc.json
git add data/vault.enc.json && git commit -m "Add statements" && git push
```

### 5. Save the encrypted file to the repo

*Skip this if you use an account (step 2b): accounts sync on their own.* Without one, after the app adds statements, the updated vault is saved (encrypted) on that device. Use one of these to put it in the repo:

- **One tap:** Settings → **GitHub Connection**. The repo is filled in already; paste a fine-grained token (see below), then tap **Save to GitHub**. Cloudflare redeploys about a minute later.
- **By hand:** Settings → **Export Encrypted File**, then commit it as `data/vault.enc.json` (github.com → *Add file → Upload files* into `data/`).

**Creating the token:** go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) and set:

- **Repository access:** *Only select repositories*, then pick this one repo
- **Permissions:** Repository permissions → *Contents: Read and write*, and nothing else
- **Expiration:** your choice (90 days is a good default)

The token stays on that device only, encrypted with your passphrase, and is only ever sent to `api.github.com`.

### 6. Set up your budget

On **Summary**, tap **Set Budget** (or Settings → **Budget**). Enter your employer, your start date, take-home pay, and your savings percentage. Money suggests a split of the spending budget (housing, groceries, restaurants, transport, misc, flex, coffee, gym) that you can edit line by line. The budget is stored inside the encrypted vault, not in the code.

### 7. Install it on your iPhone

1. Open the site in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **Money** from the home screen and unlock with your passphrase.

The home-screen app has its own storage, separate from Safari's, so it loads the vault from your repo. Do step 5 first. It works offline after the first launch.

---

## Every month: add the new statement

1. In online banking, download last month's **statement PDF**, or a **CSV / OFX / QIF** export of your transactions.
2. Open Money → **+** (Overview or Activity) → **Choose Files** → pick the file.
3. Check the card says **Reconciled** (or **Not checked** for a download without balances), then tap **Add Statement**.
4. With an account it syncs on its own. Without one, tap **Save to GitHub** or **Export Vault File** and commit it.

Duplicates are skipped automatically, even across a PDF and a CSV of the same month. If you re-add a month, Money offers to replace it and keeps your category edits. A CSV or OFX that spans several months becomes one statement per month.

**How it reads other banks:** CIBC statements use an exact CIBC reader. Everything else goes through a general reader that finds the table header (in English, French, Spanish, German, Italian, Portuguese or Dutch), reads dates in any common format (31/01/2026, 01/31/2026, 2026-01-31, 31 Jan 2026, 31. Januar…), reads amounts like 1,234.56, 1.234,56, (45.00) and 45.00 DR, and uses the running balance to confirm money in vs out. Tap **Review** on a card to see every line. If purchases show up as money in, or 03/04 was read the wrong way round, there are switches to fix it.

**If a month doesn't reconcile**, the card shows exactly which check failed and by how much. That usually means a layout the reader didn't expect. You can still import it with *Import anyway*; it stays flagged on the Overview until a clean re-import replaces it.

## Categories and rules

- **After adding statements:** places Money doesn't recognise (usually small local spots) are listed under **Needs a Category**, from the import screen or the banner on Overview. One tap per place; it's remembered for every past and future visit.
- **In the app:** tap any transaction → **Category** → pick one → **Apply to All** to save a merchant rule. Rules are stored in your encrypted vault (Settings → Merchant Rules to delete them), never in the public repo.
- **Automatic, for any bank in the world.** Money categorises on your device, in this order:
  1. the kind of transaction (pay, fees, transfers, cash withdrawals, investing apps), in many languages;
  2. a merchant category code (MCC) when the bank prints one;
  3. about 1,000 chains and brands from around the world (Tesco, Kroger, Carrefour, REWE, Swiggy, Woolworths, Lawson, Talabat…);
  4. everyday words in many languages ("pharmacie", "supermercado", "Tankstelle", "ristorante");
  5. your own choices: tagging "Blue Heron" once also covers "Blue Heron Main St" and "Blue Heron Airport".

  Product names (from an Amazon order history) are sorted with their own list of about 580 everyday product words.

  The merchant named first in the description wins, so "BOUSTAN MCGILL" is a restaurant, and a place name on its own (McGill, "University") only counts when nothing else matches. Cafés, transit and restaurants paid in a foreign currency count as **Travel**. On a test set of 173 descriptions from 20+ countries it gets every one right, and `npm test` checks that.
- **In `data/rules.json`:** the built-in categories (name, color, icon, whether it counts as *Everyday*) and merchant patterns (case-insensitive regex). Rules marked `"stage": "type"` are checked first, in order; `"weak": true` rules only apply when no other merchant rule matches. This file is public, so keep it to generic merchant names. Never put people's names or amounts in it.

## Insights

Overview ranks what's worth knowing and shows the top dozen as swipeable cards (**See All** lists them). Tap one for the full story: charts, the numbers behind it and the transactions.

| Card | What it tells you |
|---|---|
| **Possible double charge** | The same amount at the same place twice within a day, in the last 60 days. Places where that's normal for you (two transit fares) are left out. Tap **Both Were Real** to dismiss it. |
| **This month so far** | Everyday spending by today's date against the same point in your earlier months, and where the month ends if the rest goes as usual. Which categories are running ahead. |
| **Price went up** | A subscription or bill that now charges more, with the extra per year. |
| **Coming up** | Bills and subscriptions due in the next two weeks, from when each charged before. |
| **Bills & subscriptions** | Everything that charges on a schedule (weekly to yearly), split into subscriptions, bills and other regulars, with next dates, monthly and yearly cost, and the ones that stopped. Rent sent by e-transfer counts when it's the same amount each month. |
| **Unusual charge** | A charge far above what you usually pay at that place, or your biggest ever in a category. Mark it as a one-off if it was planned. |
| **Money in vs out** | How much of what comes in you keep, month by month. Moves between your own accounts don't count. |
| **Safety net** | How many months your balance would cover your usual spending. |
| **Amazon** | What your Amazon money went on, by category, once you add your order history (below). |
| **Weekends, Small buys add up, Bank fees** | Weekend days against weekdays, purchases under $15 that add up, and fees you could ask to have waived. |
| **Most visited, Everyday spending, Biggest month, Balance, a category that moved, Plan, Eating out** | As before. |

Everything is worked out on your device from the decrypted vault.

## Amazon, Costco and other stores that sell everything

A statement only says "Amazon", but one order can be groceries and the next a phone. Money handles it three ways:

1. **The descriptor, when it says more.** Prime and Prime Video, Kindle, Audible and Amazon Music go to *Subscriptions & Fun*, Amazon Fresh and Whole Foods to *Groceries*, Amazon Pharmacy to *Health*. Plain Amazon purchases start as *Shopping*.
2. **Your Amazon order history** (best). On Amazon go to **Account → Request Your Data**, choose **Your Orders**, and add the zip Amazon emails you (Settings → **Amazon Orders**, or drop it on Add Statement). Money groups items into the shipments Amazon charges for, matches each to its charge by exact amount and date, and files every item by what it is: a phone case under *Electronics & Tech*, coffee under *Groceries*, paper towels under *Home & Household*. An order with both is **split**, so each part counts in its own category while Activity still shows one charge. Refunds go back to the category of the item returned. The file is read on your device; only item names, prices, dates and categories are kept, inside the encrypted vault. Addresses, order numbers, payment and tracking details are ignored. Shipments that don't match yet (a statement you haven't added) are kept for a year and sorted when that statement arrives.
3. **By hand, in one tap.** Tap a charge at Amazon, Walmart, Costco, Canadian Tire or Dollarama and pick **What was it?** (this charge only; a category change at these stores defaults to *Only This One*), or **Split Across Categories** to divide it. Splitting works for any purchase.

## Security notes

- **Face ID / Touch ID** (iOS 18+ / macOS 15+): Settings → **Face ID** (or **Touch ID** on a Mac), then enter your passphrase once. Set it up separately on each device. It uses a passkey in iCloud Keychain (WebAuthn PRF) to keep an encrypted copy of the vault key on that device only. Your passphrase is never stored and always works. Changing the passphrase turns Face ID off until you turn it on again.
- Auto-lock: after 5 minutes idle by default (Settings → Auto-Lock), and when the app has been in the background for over a minute.
- Change your passphrase in Settings → **Change Passphrase**, then Save to GitHub.
- **Forget This Device** (or **Sign Out on This Device** for an account) removes the local encrypted copy from that browser. **Delete Account** removes an account's data from the server for good.
- The sync API stores only ciphertext and a SHA-256 hash of a token derived from the passphrase key, so it can't decrypt anything or hand one person's data to another. Wrong guesses are throttled per account and per network (10 per 15 minutes), so a stranger guessing can't lock you out. Saves use compare-and-swap, so two devices can't silently overwrite each other; if both changed, Money asks which to keep.
- **Bank emails** (optional): the browser reads Gmail itself with a read-only Google sign-in; no email passes through the Worker. Only the date, amount, a cleaned-up merchant name, the bank's name and a short hash of each email (so it's never read twice) are kept, inside the encrypted vault. The Google sign-in token is kept only inside the vault; while you connect, Google's one-time code waits on the Worker for at most 15 minutes, under a hash, and can only be used together with a secret that never leaves your browser (PKCE).
- **Bank sync** (optional) goes through Plaid: the Plaid access token is stored only inside your encrypted vault and sent to the Worker with each sync; the Worker adds Plaid's secret, relays the call, and keeps nothing (no database rows, no logs of transactions). Account numbers, even Plaid's last-4 "mask", are dropped before anything reaches your browser. Disconnect removes the connection at Plaid.
- Never commit PDFs, CSVs, Amazon zips or decrypted exports. `.gitignore` already blocks the common ones.

## Development

```bash
npm install
npm test          # parser + reconciliation + crypto + privacy + sync API tests (needs python3 + reportlab for sample PDFs)
npm run serve     # http://localhost:8080 — tap "Explore with Sample Data" to try it without a vault
# accounts locally: put INVITE_CODE=anything in .dev.vars, then `npx wrangler dev` (local D1)
npm run icons     # re-render icons/splash screens from icons/icon.svg (needs Playwright)
npm run vendor    # re-copy pdf.js after changing its version in package.json
```

Static files only, with no framework and no bundler. After changing any app file, bump `VERSION` in `sw.js` so installed copies update.
