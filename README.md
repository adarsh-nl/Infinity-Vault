# ♾️ Infinity Vault — Personal Investment Dashboard

A lightweight, privacy-first investment tracker built entirely with vanilla HTML, CSS, and JavaScript. No frameworks, no build tools, no servers — just open `index.html` in a browser and start tracking your wealth.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![No Dependencies](https://img.shields.io/badge/dependencies-0%20(CDN%20only)-brightgreen)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-blue)

---

## ✨ Features

### 🔐 Encrypted Local Vault
- Username + password login system
- Your password is stretched with **PBKDF2-SHA256** (210k iterations) into a 256-bit key that **encrypts your investment data with AES-GCM** — data at rest, exports, and backups are all ciphertext
- The password itself is **never stored**; login is verified by decrypting a small token, so a wrong password simply fails to decrypt
- Session key is held in memory and mirrored into `sessionStorage`, so a reload stays unlocked but closing the tab **auto-locks** the vault
- Existing (pre-encryption) accounts are **migrated automatically and losslessly** on first login
- First visit = registration, subsequent visits = login

### 📊 Rich Dashboard with 5 Visualizations
| Chart | Type | Purpose |
|-------|------|---------|
| Asset Diversification | Donut | See how your portfolio is spread across asset types |
| Projected Growth | Bar | Compare total invested vs total maturity/current value |
| Returns by Investment | Horizontal Bar | Rank each investment by annualized return % |
| Type-Wise Performance | Grouped Bar | Invested vs Maturity for each asset class |
| Investment Timeline | Line | Cumulative invested amount over months |

### 💰 Smart Investment Types

**Fixed Deposit (FD)**
- Enter principal, interest rate (% p.a.), and maturity date
- Maturity auto-calculated using **quarterly compounding**:
  ```
  Maturity = P × (1 + r/4)^(4 × days/365)
  ```
- Live preview shows tenure in days and calculated maturity as you type

**SIP (Systematic Investment Plan)**
- Enter monthly amount, duration (months), and expected annual return
- Maturity calculated using the standard **SIP Future Value** formula:
  ```
  FV = P × [((1 + r)^n - 1) / r] × (1 + r)
  ```
  where `P` = monthly amount, `r` = monthly rate, `n` = number of months

**Gold**
- Enter weight (grams) and purchase price per gram
- **Live 24K gold price** fetched from [gold-api.com](https://gold-api.com) (free, no API key)
- USD → INR conversion via [open.er-api.com](https://open.er-api.com)
- Auto-updates current value for all gold investments on page load
- Falls back to cached price if APIs are unavailable

**Stocks, Mutual Funds, Crypto, Real Estate, Other**
- Manual invested amount and current/maturity value

### 📈 Annualized Returns
Returns are calculated using an annualized formula to normalize across different holding periods:
```
Annualized Return % = ((Maturity - Invested) / Invested) × 100 × (365 / days)
```
- FDs use their tenure in days
- Other types calculate days from investment date to today

### 💼 Full Investments Page
- Browse all investments in a searchable, filterable table
- **Search** by investment name
- **Filter chips** by asset type: FD, Stocks, MF, SIP, Crypto, Gold, Real Estate, Other

### ⚙️ Settings Page
- **Change Password** — verifies current password before updating
- **Export Data** — download all investments as a JSON file
- **Import Data** — restore from a JSON backup
- **Clear All Data** — permanently delete everything (with confirmation)

### 🎨 Premium UI
- **Glassmorphism** design with deep blurs and subtle borders
- **Dark/Light mode** toggle
- Modern typography via Google Fonts (Outfit + Inter)
- Smooth animations and micro-interactions
- Responsive design for mobile and desktop
- [Phosphor Icons](https://phosphoricons.com/) throughout

---

## 🏗️ Architecture

```
Infinity Vault/
├── index.html      # Single-page app with 3 routable pages
├── styles.css      # Full design system with CSS variables
├── finance.js      # Pure financial math (FD/SIP/returns) — unit-tested
├── crypto.js       # PBKDF2 key derivation + AES-GCM encrypt/decrypt
├── auth.js         # Register/login/session, verifier, legacy migration
├── storage.js      # Encrypted vault, CRUD, backups, KPIs — unit-tested
├── charts.js       # 5 Chart.js visualizations
├── app.js          # Main controller: auth flow, navigation,
│                   # form logic, gold API, settings
└── tests/          # Vitest suites (dev-only; runtime stays zero-build)
```

> The **app** still runs with zero build — just open it. `finance.js`, `crypto.js`,
> and `storage.js` double as importable modules so the logic can be unit-tested
> (`npm test`); see [CONTRIBUTING.md](CONTRIBUTING.md).

### How It Works

1. **Data Storage** — All data lives in browser `localStorage`. No server, no database. Your data never leaves your browser.

2. **Authentication & encryption** — A key is derived from your password with PBKDF2-SHA256 and used to AES-GCM–encrypt the investment blob before it is written to `localStorage`. Only a random salt, the iteration count, and a decryptable verifier token are stored — never the password. The derived key is mirrored into `sessionStorage` for the active tab and cleared when the tab closes.

3. **Gold Price Fetching** — On page load, the app makes two API calls:
   - `gold-api.com` for live gold price in USD per troy ounce
   - `open.er-api.com` for USD → INR exchange rate
   - Converts to ₹/gram and caches the result in `localStorage`

4. **Page Routing** — Three "pages" (Dashboard, Investments, Settings) are `<div>` sections toggled via CSS classes. No actual page navigation or framework routing needed.

5. **Charts** — Rendered with [Chart.js](https://www.chartjs.org/) via CDN. All charts are theme-aware and re-render on dark/light mode toggle.

### External Dependencies (CDN only)

| Dependency | Purpose | CDN | Pinned |
|-----------|---------|-----|--------|
| [Chart.js](https://www.chartjs.org/) | Data visualizations | jsdelivr | `4.5.1` + SRI |
| [Phosphor Icons](https://phosphoricons.com/) | Icon set | unpkg / jsdelivr | `2.1.2` + SRI |
| [Google Fonts](https://fonts.google.com/) | Inter + Outfit typography | Google | — |

CDN scripts are **pinned to exact versions with Subresource Integrity** hashes,
so a tampered file is rejected by the browser. A **Content-Security-Policy**
`<meta>` in `index.html` restricts every origin the page may load from and
forbids inline/`eval` script — defense-in-depth behind the render-time escaping.

No `npm install`, no `node_modules`, no build step.

---

## 🚀 Getting Started

### Option 1: Just open it
```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/infinity-vault.git
cd infinity-vault

# Open in your browser
open index.html
```

### Option 2: Local HTTP server (recommended for gold price API)
```bash
# Python
python3 -m http.server 8000

# Then visit http://localhost:8000
```

> **Note:** The gold price API requires `http://` or `https://` (not `file://`) due to browser CORS policies. If you just open `index.html` directly, gold prices won't fetch, but everything else works fine.

### First Time Setup
1. Create a username and password
2. Start adding investments!
3. Your data is stored locally — bookmark the page for easy access

---

## 📸 Features at a Glance

| Feature | Description |
|---------|-------------|
| 🔒 Login/Register | SHA-256 hashed credentials, auto-lock on tab close |
| 📅 FD Calculator | Quarterly compounding with live tenure preview |
| 📈 SIP Calculator | Standard FV formula with wealth gain preview |
| 🏅 Live Gold Price | Auto-fetched from gold-api.com, cached locally |
| 📊 5 Charts | Diversification, Growth, Returns, Performance, Timeline |
| 🔍 Search & Filter | Full-text search + type filter chips |
| 💾 Export/Import | JSON backup and restore |
| 🌙 Dark/Light Mode | Premium glassmorphism on both themes |
| 📱 Responsive | Works on mobile, tablet, and desktop |

---

## 🔒 Security Note

Infinity Vault is **local-first**: your data lives only in your browser and is
**encrypted at rest** with a key derived from your password (PBKDF2-SHA256 →
AES-GCM). Anyone who obtains your `localStorage`, an exported backup, or the disk
profile cannot read your portfolio without the password.

Honest limits of the model:

- **While a tab is unlocked**, the session key sits in `sessionStorage` and the
  decrypted data is in memory — same-origin scripts on the page can read it.
  This is inherent to any in-browser app; it is why the XSS hardening matters.
- There is **no password recovery.** If you forget it, the data is unrecoverable
  by design — keep an exported backup somewhere safe.
- Encryption requires a **secure context** (`https://`, `localhost`, or a local
  file). Over plain `http://` on a shared host, the app falls back to an
  unencrypted profile lock — don't use it for sensitive data there.

It remains a personal tool, not a substitute for a server-side, multi-user
system with recovery and audit controls.

---

## 🤝 Contributing

Contributions are welcome! Some ideas:

- [x] ~~Edit existing investments~~ (done — pencil action on each row)
- [ ] Multiple currency support
- [ ] PDF report generation
- [ ] More asset-specific calculators (PPF, NPS, etc.)
- [ ] Chart date range filtering

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).
