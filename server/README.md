# Sync backend (E2EE, Phase 1) — reference scaffold

A minimal **zero-knowledge** backend for cloud backup/restore: it stores and
relays ciphertext, salts, and an `authHash` proof — never the password, keys, or
any investment data. Full design: [`../docs/design/e2ee-sync-phase1.md`](../docs/design/e2ee-sync-phase1.md).

## Status

⚠️ **Reference scaffold — not audited, not run by this repo's tests.** The
*behavioral spec* for every endpoint is the in-memory mock server in
[`../tests/sync.test.js`](../tests/sync.test.js), against which the client
(`sync.js`) is verified. Deploy this Worker to exercise it for real, and get an
independent security review before production. Inline `TODO`s mark the hardening
gaps (Argon2id server-side hashing, rate limiting, email verification).

## Files

| File | Purpose |
|------|---------|
| `schema.sql` | D1 (SQLite) tables: `users`, `sessions` |
| `worker.js` | Cloudflare Worker implementing the API contract |
| `wrangler.toml` | Worker + D1 + R2 bindings and config |

## Deploy (Cloudflare)

```bash
npm i -g wrangler && wrangler login

wrangler d1 create infinity-vault
wrangler d1 execute infinity-vault --file=./schema.sql      # apply schema
wrangler r2 bucket create infinity-vault-vaults

# put the D1 database_id + your app origin into wrangler.toml, then:
wrangler deploy
```

## Wiring the client

```js
Sync.configure('https://<your-worker>.workers.dev');
// then Sync.enable(email, password) / signIn / restore / backupNow …
```

Also add the Worker origin to the app's CSP `connect-src` in `index.html`.

## What the server can and cannot see

**Can:** email, `hash(authHash)`, the account envelope (opaque wrapped keys +
salts), the vault ciphertext (opaque), version numbers, timestamps.
**Cannot:** password, KEK, DEK, or any investment field.
