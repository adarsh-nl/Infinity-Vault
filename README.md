# ♾️ Infinity Vault — Personal Investment Dashboard

A lightweight, privacy-first investment tracker built entirely with vanilla HTML, CSS, and JavaScript. No frameworks, no build tools, no servers — just open `index.html` in a browser and start tracking your wealth.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![No Dependencies](https://img.shields.io/badge/dependencies-0%20(CDN%20only)-brightgreen)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-blue)

---

## ✨ Features

### 🔐 Client-Side Authentication
- Username + password login system
- Passwords hashed with **SHA-256** via the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest) before storing — never saved in plaintext
- Session tracked via `sessionStorage` — **auto-locks** when you close the tab
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
├── auth.js         # SHA-256 hashing, login/register/session
├── storage.js      # LocalStorage CRUD, KPI calculations
├── charts.js       # 5 Chart.js visualizations
└── app.js          # Main controller: auth flow, navigation,
                    # form logic, gold API, settings
```

### How It Works

1. **Data Storage** — All data lives in browser `localStorage`. No server, no database. Your data never leaves your browser.

2. **Authentication** — Credentials are hashed with SHA-256 and stored in `localStorage`. The session flag is stored in `sessionStorage`, which clears automatically when the tab closes.

3. **Gold Price Fetching** — On page load, the app makes two API calls:
   - `gold-api.com` for live gold price in USD per troy ounce
   - `open.er-api.com` for USD → INR exchange rate
   - Converts to ₹/gram and caches the result in `localStorage`

4. **Page Routing** — Three "pages" (Dashboard, Investments, Settings) are `<div>` sections toggled via CSS classes. No actual page navigation or framework routing needed.

5. **Charts** — Rendered with [Chart.js](https://www.chartjs.org/) via CDN. All charts are theme-aware and re-render on dark/light mode toggle.

### External Dependencies (CDN only)

| Dependency | Purpose | CDN |
|-----------|---------|-----|
| [Chart.js](https://www.chartjs.org/) | Data visualizations | jsdelivr |
| [Phosphor Icons](https://phosphoricons.com/) | Icon set | unpkg |
| [Google Fonts](https://fonts.google.com/) | Inter + Outfit typography | Google |

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

This app uses **client-side authentication** with SHA-256 hashing. It is designed for **personal use on your own machine** to prevent casual access. It is **not** a substitute for server-side authentication. Do not rely on it for sensitive financial data over shared or public networks.

---

## 🤝 Contributing

Contributions are welcome! Some ideas:

- [ ] Edit existing investments (currently delete + re-add)
- [ ] Multiple currency support
- [ ] PDF report generation
- [ ] More asset-specific calculators (PPF, NPS, etc.)
- [ ] Chart date range filtering

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).
