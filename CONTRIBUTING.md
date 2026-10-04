# Contributing to Infinity Vault

Thanks for your interest! Infinity Vault is a **zero-build, dependency-free**
browser app — you can hack on it with nothing but a text editor and a browser.

## Running the app

```bash
# Any static server works; the gold-price API needs http(s), not file://
python3 -m http.server 8000
# → open http://localhost:8000
```

## Running the tests

The **runtime** has no dependencies, but the **test suite** uses
[Vitest](https://vitest.dev/) (dev-only — it never ships to users).

```bash
npm install     # installs Vitest into node_modules/ (git-ignored)
npm test        # run the suite once
npm run test:watch
```

Pure logic lives in `finance.js` (financial formulas) and the data layer in
`storage.js`. Both are covered by `tests/`. **Any change to a financial formula
or the storage/normalization logic must come with a test.** CI runs `npm test`
on every pull request.

## Project layout

| File | Responsibility |
|------|----------------|
| `index.html` | Markup for the three pages + modals |
| `styles.css` | Design system (CSS variables, light/dark) |
| `finance.js` | Pure financial math — no DOM, no storage (unit-tested) |
| `crypto.js` | PBKDF2 key derivation + AES-GCM encrypt/decrypt |
| `auth.js` | Registration, login, session, password change |
| `storage.js` | localStorage CRUD, backups, KPIs (unit-tested) |
| `charts.js` | Chart.js visualizations |
| `app.js` | UI controller: wiring, forms, navigation |

## Conventions

- Keep `finance.js` **pure** so it stays trivially testable.
- Prefer `textContent` / escaping over `innerHTML` for any user-controlled data.
- Conventional Commit messages (`fix:`, `feat:`, `refactor:`, `docs:`…).
