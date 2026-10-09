# Money

A private, Apple-style finance app for your iPhone home screen. It's a static site plus a tiny sync API, hosted for free on Cloudflare Workers: no framework, no bundler, nothing to run.

- **Overview**: balance with a Stocks-style chart you scrub with your finger, money in/out/net, and insight cards
- **Spending**: by month, Everyday vs Everything, categories, monthly stacked chart, top merchants
- **Activity**: every transaction, searchable. Re-categorize one, or apply the change to all from a merchant (saved as a rule).
- **Plan**: budget from your start date, with Saved / Spent / Eating-out rings and budget vs actual
- **Add Statement**: reads statements from any bank on your device (PDF, or the CSV, OFX/QFX or QIF file online banking lets you download), removes duplicates, categorizes, and reconciles to the bank's balances
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

- **Forgot your passphrase?** Every account gets a **recovery key** when it's created (also in Settings → Recovery Key). On the lock screen tap **Forgot passphrase?** and enter it, or use **Reset with Face ID** on a device where Face ID is on. Without either, nobody can reset it, including you as the site owner. That's what keeps it private.
- If two devices change the same account offline, the next sync asks which version to keep.
- Statements from **any bank** work: PDF statements in most layouts and languages, or the CSV, OFX/QFX or QIF download from online banking (the most reliable choice when a bank offers it). Scanned (image-only) PDFs can't be read.
- If you turned on Cloudflare Access (below), add each person's email to its policy so they can reach the site.
- To stop new sign-ups, change or delete `INVITE_CODE`. Existing accounts keep working while it's set; deleting it pauses sync for everyone until it's set again.

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

### 6. Set up your plan

Open the **Plan** tab and tap **Set Up Plan**. Enter your employer, your start date, take-home pay, and your savings percentage. Money suggests a split of the spending budget (housing, groceries, restaurants, transport, misc, flex, coffee, gym) that you can edit line by line. The plan is stored inside the encrypted vault, not in the code.

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
- **How matching works:** first the kind of transaction (fees, pay, transfers, cash withdrawals), then the merchant named first in the description, so "BOUSTAN MCGILL" is a restaurant and "MCGILL ATHLETIC" is fitness. A campus or institution name on its own (McGill, "University") only counts when nothing else matches.
- **In `data/rules.json`:** the built-in categories (name, color, icon, whether it counts as *Everyday*) and merchant patterns (case-insensitive regex). Rules marked `"stage": "type"` are checked first, in order; `"weak": true` rules only apply when no other merchant rule matches. This file is public, so keep it to generic merchant names. Never put people's names or amounts in it.

## Security notes

- **Face ID / Touch ID** (iOS 18+ / macOS 15+): Settings → **Face ID** (or **Touch ID** on a Mac), then enter your passphrase once. Set it up separately on each device. It uses a passkey in iCloud Keychain (WebAuthn PRF) to keep an encrypted copy of the vault key on that device only. Your passphrase is never stored and always works. Changing the passphrase turns Face ID off until you turn it on again.
- Auto-lock: after 5 minutes idle by default (Settings → Auto-Lock), and when the app has been in the background for over a minute.
- Change your passphrase in Settings → **Change Passphrase**, then Save to GitHub.
- **Forget This Device** (or **Sign Out on This Device** for an account) removes the local encrypted copy from that browser. **Delete Account** removes an account's data from the server for good.
- The sync API stores only ciphertext and a SHA-256 hash of a token derived from the passphrase key, so it can't decrypt anything or hand one person's data to another. Wrong-token attempts are throttled per account.
- Never commit PDFs, CSVs or decrypted exports. `.gitignore` already blocks the common ones.

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
