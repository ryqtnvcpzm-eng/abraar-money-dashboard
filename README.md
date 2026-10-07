# Money

A private, Apple-style finance app for your iPhone home screen. It's a static site on GitHub Pages: no server, no build step, nothing to run.

- **Overview**: balance with a Stocks-style chart you scrub with your finger, money in/out/net, and insight cards
- **Spending**: by month, Everyday vs Everything, categories, monthly stacked chart, top merchants
- **Activity**: every transaction, searchable. Re-categorize one, or apply the change to all from a merchant (saved as a rule).
- **Plan**: budget from your start date, with Saved / Spent / Eating-out rings and budget vs actual
- **Add Statement**: reads a CIBC PDF on your device, removes duplicates, categorizes, and reconciles to the bank's balances

**Privacy:** the repo holds only `data/vault.enc.json`, which is AES-256-GCM encrypted with a key derived from your passphrase (PBKDF2-SHA-256, 600k iterations). Statement PDFs never leave your device and are git-ignored. Account and transit numbers are never stored. The app auto-locks and asks search engines not to index it. See [docs/DESIGN.md](docs/DESIGN.md) for the design and the security model.

```
index.html              app shell (CSP, icon sprite)
manifest.webmanifest    install metadata
sw.js                   offline cache (bump VERSION after changing files)
css/app.css             design system
js/                     app code: crypto, parser, ledger, charts, views
data/rules.json         categories + merchant rules (public, edit freely)
data/vault.enc.json     your data, encrypted (created by the app)
vendor/pdfjs/           pdf.js, vendored so no code loads from a CDN
icons/                  app icon + iPhone launch screens
tools/vault.mjs         command-line check / import / report
tests/                  parser + reconciliation + crypto tests
docs/                   design notes and the vault JSON schema
```

---

## Setup

### 1. Get the code into your repo

This code lives on the `claude/apple-finance-pwa` branch of `abraar-money-dashboard`. Merge it into `main` (open a pull request on GitHub and merge it, or `git checkout main && git merge claude/apple-finance-pwa && git push`).

### 2. Decide public vs. private, and clean the history

GitHub Pages on a **Free** plan needs a **public** repo. A private repo works with Pages on GitHub Pro, Team or Enterprise.

> ⚠️ This repo's earlier commits contain the old dashboard, with **monthly balances and totals in plain text**. Before making the repo public, publish a fresh history that starts from this version:
>
> ```bash
> git checkout main && git pull
> git checkout --orphan fresh && git add -A && git commit -m "Money"
> git branch -D main && git branch -m main
> git push --force origin main
> git push origin --delete claude/apple-finance-pwa   # old branches still carry the old history
> ```
>
> Or create a brand-new repository and push only this version to it.

### 3. Turn on GitHub Pages

Go to **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.** After about a minute your app is at `https://<your-username>.github.io/<repo-name>/`.

### 4. Create your vault and set your passphrase

Open the site in Safari (on your phone or computer) and tap **Create Your Vault**. Choose a passphrase of at least 12 characters; four or more random words is ideal.

- Your vault file is public, so **the passphrase is the only thing protecting it**. Don't reuse one.
- **It can't be recovered.** Write it down somewhere safe, such as your password manager.

### 5. Add your statements (Jan–Sep)

**In the app (simplest):** tap **Add Statements**, choose all nine CIBC PDFs, and look over the reconciliation card for each month. A month reconciles when opening + deposits − withdrawals = closing and both totals match CIBC's summary to the cent. Then tap **Add 9 Statements**.

**Or on your computer**, to see the full reconciliation table first:

```bash
npm install                                   # once; installs pdf.js for the tools
mkdir statements && cp ~/Downloads/*.pdf statements/   # git-ignored, never committed
node tools/vault.mjs check statements/*.pdf   # prints the reconciliation table, writes nothing
node tools/vault.mjs import statements/*.pdf  # asks for your passphrase, writes data/vault.enc.json
git add data/vault.enc.json && git commit -m "Add statements" && git push
```

### 6. Save the encrypted file to the repo

After the app adds statements, the updated vault is saved (encrypted) on that device. Use one of these to put it in the repo:

- **One tap:** Settings → **GitHub Connection**. Paste a fine-grained token (see below), then tap **Save to GitHub**.
- **By hand:** Settings → **Export Encrypted File**, then commit it as `data/vault.enc.json` (github.com → *Add file → Upload files* into `data/`).

**Creating the token:** go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) and set:

- **Repository access:** *Only select repositories*, then pick this one repo
- **Permissions:** Repository permissions → *Contents: Read and write*, and nothing else
- **Expiration:** your choice (90 days is a good default)

The token stays on that device only, encrypted with your passphrase, and is only ever sent to `api.github.com`.

### 7. Set up your plan

Open the **Plan** tab and tap **Set Up Plan**. Enter your employer, your start date, take-home pay, and your savings percentage. Money suggests a split of the spending budget (housing, groceries, restaurants, transport, misc, flex, coffee, gym) that you can edit line by line. The plan is stored inside the encrypted vault, not in the code.

### 8. Install it on your iPhone

1. Open the site in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **Money** from the home screen and unlock with your passphrase.

The home-screen app has its own storage, separate from Safari's, so it loads the vault from your repo. Do step 6 first. It works offline after the first launch.

---

## Every month: add the new statement

1. In CIBC Online Banking, download last month's **eStatement PDF**.
2. Open Money → **+** (Overview or Activity) → **Choose PDFs** → pick the file.
3. Check the card says **Reconciled**, then tap **Add Statement**.
4. Tap **Save to GitHub**, or **Export Vault File** and commit it.

Duplicates are skipped automatically. If you re-add a month, Money offers to replace it and keeps your category edits.

**If a month doesn't reconcile**, the card shows exactly which check failed and by how much. That usually means a PDF layout the parser didn't expect. You can still import it with *Import anyway*; it stays flagged on the Overview until a clean re-import replaces it.

## Categories and rules

- **In the app:** tap any transaction → **Category** → pick one → **Apply to All** to save a merchant rule. Rules are stored in your encrypted vault (Settings → Merchant Rules to delete them).
- **In `data/rules.json`:** the built-in categories (name, color, icon, whether it counts as *Everyday*) and merchant patterns (case-insensitive regex, first match wins). This file is public, so keep it to generic merchant names. Never put people's names or amounts in it.

## Security notes

- Auto-lock: after 5 minutes idle by default (Settings → Auto-Lock), and when the app has been in the background for over a minute.
- Change your passphrase in Settings → **Change Passphrase**, then Save to GitHub.
- **Forget This Device** removes the local encrypted copy and the token from that browser.
- Never commit PDFs, CSVs or decrypted exports. `.gitignore` already blocks the common ones.

## Development

```bash
npm install
npm test          # parser + reconciliation + crypto + privacy tests (needs python3 + reportlab for sample PDFs)
npm run serve     # http://localhost:8080 — tap "Explore with Sample Data" to try it without a vault
npm run icons     # re-render icons/splash screens from icons/icon.svg (needs Playwright)
npm run vendor    # re-copy pdf.js after changing its version in package.json
```

Static files only, with no framework and no bundler. After changing any app file, bump `VERSION` in `sw.js` so installed copies update.
