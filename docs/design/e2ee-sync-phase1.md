# Implementation Plan: E2EE Sync — Phase 1 (accounts + one-way backup/restore)

**Status:** Proposed · **Depends on:** [`e2ee-sync.md`](e2ee-sync.md) and the shipped
Phase 0 envelope model (`crypto.js` / `auth.js`).

> Phase 1 goal: a user backs up their encrypted vault to the cloud and restores it
> on a second device — server holds **ciphertext only**. No auto-sync, no merge yet.

---

## 1. Scope

**In scope**
- Real accounts (email + password) with password-off-the-wire auth.
- A minimal **zero-knowledge** backend: register, login, get/put the vault blob.
- Client "Cloud Sync" UI: enable, **Back up now**, **Restore on this device**, sign out.
- Keep the local vault authoritative; sync is an opt-in layer over Phase 0.

**Explicit non-goals (deferred to Phase 2+)**
- Automatic / background sync.
- Two-way sync and conflict **merge** — Phase 1 is manual, last-upload-wins with a
  "a newer backup exists, overwrite?" guard (optimistic version, no record merge).
- Multi-device sessions & revocation, email-based account recovery.

---

## 2. The key simplification (reuse Phase 0)

The vault already lives in `localStorage['infinity_vault_investments']` as an
AES-GCM blob encrypted under the **DEK**. **That blob *is* the sync payload.**

- **Back up** = upload the existing at-rest ciphertext verbatim. No new crypto path.
- **Restore** = download the blob → write it to `localStorage` → unlock with the DEK
  the device just unwrapped at login.

So the server stores two opaque things per user: the **account envelope** (Phase 0's
`kekSalt`, `wrappedDEK`, `recovery`) so a new device can reconstruct the DEK from the
password, and the **vault ciphertext**. Neither is readable without the password.

---

## 3. Recommended stack

**Cloudflare Workers + D1 (SQLite) + R2 (object store).** Rationale: cheap at rest
(free tier covers early usage), low-ops (no servers), global edge TLS, one language
(JS/TS) end-to-end. D1 holds accounts + the vault *version*; R2 holds the vault blob.

*Alternative:* Supabase (Postgres + Row-Level Security + Storage) — faster to stand up,
RLS enforces per-user isolation, at the cost of more moving parts. Either works; the
API contract below is backend-agnostic.

---

## 4. Authentication — split-derivation (password never usable off the device)

Two **independent** PBKDF2 derivations from the same password, with **different salts**:

```
KEK      = PBKDF2(password, kekSalt,  kekIters)     ── local only; wraps the DEK (Phase 0)
authHash = PBKDF2(password, authSalt, authIters)    ── sent to the server as a login proof
```

`kekSalt ≠ authSalt` is **mandatory** — with the same salt, `authHash` would equal the
KEK material and uploading it would hand the server the key. With different random
salts the two outputs are independent; `authHash` reveals nothing about the KEK.

Server never stores `authHash` raw: it stores `serverHash = Argon2id(authHash, serverSalt)`.

**Register (enable sync from an unlocked local vault):**
1. Client generates `authSalt`; computes `authHash`.
2. `POST /account { email, authSalt, authIters, authHash, kekSalt, kekIters, wrappedDEK, recovery }`.
3. Server stores the account + `Argon2id(authHash)`; returns a session token.
4. Client uploads the vault (`PUT /vault`).

**Login on a new device:**
1. `POST /session/prelogin { email }` → `{ authSalt, authIters }`
   (return a **deterministic dummy salt** for unknown emails to resist account enumeration).
2. Client computes `authHash`; `POST /session { email, authHash }`.
3. Server verifies `Argon2id(authHash) == serverHash`; returns `{ token, account }` where
   `account = { kekSalt, kekIters, wrappedDEK, recovery, vaultVersion }`.
4. Client: `KEK = PBKDF2(password, kekSalt)`, `GET /vault` → ciphertext,
   `DEK = unwrapDEK(KEK, wrappedDEK)`, decrypt → write locally. Device is set up.

**Session token:** opaque random (32 bytes); server stores only `sha256(token)`; short
TTL (e.g. 30 days) mirrored into the client's `sessionStorage`.

> **Honest caveat (same as Bitwarden):** a *malicious* server that dumps its DB can
> mount an **offline** dictionary attack on the password (crack `Argon2id→authHash`,
> then `PBKDF2→password`, then derive the KEK). E2EE holds against an honest-but-curious
> server, the network, and a passive breach of the vault blob; it does **not** make a
> weak password safe against a hostile server. Mitigations: strong client + server KDFs,
> encourage strong passwords, and treat OPAQUE (Phase 2+) as the fix that removes the
> crackable verifier entirely.

---

## 5. Data model

**D1**

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,        -- uuid v4
  email           TEXT UNIQUE NOT NULL,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  -- auth (split-derivation)
  auth_salt       TEXT NOT NULL,           -- b64
  auth_iters      INTEGER NOT NULL,
  server_salt     TEXT NOT NULL,           -- b64
  server_hash     TEXT NOT NULL,           -- Argon2id(authHash, server_salt)
  -- account envelope (opaque to server)
  kek_salt        TEXT NOT NULL,           -- b64
  kek_iters       INTEGER NOT NULL,
  wrapped_dek     TEXT NOT NULL,           -- JSON {iv,ct}
  recovery        TEXT,                    -- JSON {salt,iters,wrappedDEK} | null
  -- vault pointer
  vault_version   INTEGER NOT NULL DEFAULT 0,
  vault_updated_at INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,            -- sha256(token)
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
```

**R2:** object key `vault/{user_id}` → the vault ciphertext blob (the `{v,iv,ct}` JSON
string, uploaded verbatim). Versioning/CAS is tracked in `users.vault_version`, not R2.

---

## 6. API contracts

All requests over HTTPS; JSON bodies; `Authorization: Bearer <token>` where noted.
Errors: `{ error: "<code>" }` with a matching HTTP status.

| Method & path | Auth | Body → Response |
|---|---|---|
| `POST /v1/account` | — | `{email, authSalt, authIters, authHash, kekSalt, kekIters, wrappedDEK, recovery}` → `201 {token, expiresAt}` · `409 email_taken` |
| `POST /v1/session/prelogin` | — | `{email}` → `200 {authSalt, authIters}` (dummy salt if unknown) |
| `POST /v1/session` | — | `{email, authHash}` → `200 {token, expiresAt, account:{kekSalt,kekIters,wrappedDEK,recovery,vaultVersion}}` · `401 invalid_credentials` |
| `GET /v1/vault` | ✔ | → `200 {vaultVersion, ciphertext}` · `204` if none |
| `PUT /v1/vault` | ✔ | `{ciphertext, baseVersion}` → `200 {vaultVersion}` · `409 version_conflict {vaultVersion}` |
| `POST /v1/account/keys` | ✔ | `{authSalt, authIters, authHash, kekSalt, kekIters, wrappedDEK}` (password change) → `200` |
| `DELETE /v1/account` | ✔ | → `204` (wipe D1 row + R2 object) |
| `POST /v1/session/logout` | ✔ | → `204` (delete session row) |

**`PUT /v1/vault` CAS:** server accepts only if `baseVersion == users.vault_version`,
then increments it. On mismatch → `409 {vaultVersion}`; the Phase-1 client shows
"a newer backup exists — overwrite?" and, if confirmed, re-PUTs with the returned
version (no record merge until Phase 2).

**Server-side must-haves:** rate-limit `prelogin` + `session` (per-IP and per-email),
CORS locked to the app origin, request-size cap on the blob, structured logging that
**never** records ciphertext or blob sizes, and Argon2id (not fast hashing) for
`server_hash`.

---

## 7. Client changes

New module `sync.js` (loaded like the others; dual-export for tests). Surface:

```js
Sync.enable(email, password)   // register account from the current unlocked vault, upload
Sync.prelogin(email)           // → {authSalt, authIters}
Sync.signIn(email, password)   // session; caches token + account envelope
Sync.restore(password)         // unwrap DEK from server envelope, GET vault, write local
Sync.backupNow()               // PUT localStorage vault blob with CAS
Sync.pushKeys(password)        // after a password change: POST /account/keys
Sync.status()                  // {enabled, email, lastBackup, vaultVersion, dirty}
Sync.signOut()                 // drop token (local vault stays)
Sync.disableAndDelete(pwd)     // DELETE /account
```

Notes:
- `backupNow()` reads `localStorage['infinity_vault_investments']` (already ciphertext)
  and PUTs it — no re-encryption. `restore()` writes it back and calls
  `InvestmentStorage.reload()`.
- A local `dirty` flag flips on any vault mutation and clears after a successful backup,
  driving a "Back up now" nudge and a "last backed up …" label.
- Token in `sessionStorage`; sync config (email, salts, `enabled`) in `localStorage`.
- **Password change** must, after `AuthManager.changePassword`, call `Sync.pushKeys` so
  the server's `authHash` + `wrappedDEK` stay in step. (Handle offline: queue the push.)

**Settings → "Cloud Sync" card:** signed-out state (email + "Enable sync" / "Sign in");
signed-in state (email, last-backup time, **Back up now**, **Restore from cloud**, **Sign
out**, and a danger "Delete cloud copy"). All destructive/outbound actions route through
the existing `confirmDialog`.

**CSP:** extend `connect-src` in `index.html` with the sync API origin, e.g.
`connect-src 'self' https://api.gold-api.com https://open.er-api.com https://sync.infinityvault.app;`

---

## 8. Security & threat notes (Phase-1-specific)

- **What the server sees:** email, `Argon2id(authHash)`, the account envelope (opaque),
  the vault ciphertext (opaque), version numbers, timestamps. **Not:** password, KEK,
  DEK, or any investment field.
- **Metadata leaks:** account existence/email, blob size (≈ portfolio size), backup
  times. Mitigate blob-size leakage by padding the ciphertext to fixed buckets before
  upload (documented in Phase 0's `crypto.js` as a follow-up).
- **Account enumeration:** `prelogin` returns a *deterministic per-email dummy salt* for
  unknown addresses so timing/response don't reveal membership.
- **Email verification:** recommended before first backup (deliverability + abuse); may
  ship as a fast-follow if it blocks the MVP, but say so.
- **In-session exposure:** unchanged from today — plaintext is in memory while unlocked;
  the existing CSP/SRI/escaping remain the mitigation.
- **Before launch:** independent review of the auth + key-handling paths; vetted libs
  only (Web Crypto client-side, a maintained Argon2 impl server-side).

---

## 9. Testing

- **`sync.js` (unit, mocked `fetch`):** enable→backup→restore round-trip; CAS `409`
  handling; token expiry → re-auth; offline queueing of `pushKeys`.
- **Zero-knowledge assertion:** capture every request body in the round-trip test and
  assert **no investment field / plaintext ever appears** on the wire (only ciphertext,
  salts, `authHash`).
- **Backend contract tests:** register/login happy + error paths; wrong `authHash` →
  401; `prelogin` gives identical shape for known/unknown emails; per-user isolation
  (user A cannot read user B's vault); rate-limit trips.
- **Two-device E2E:** device A `enable` + `backupNow`; device B `signIn` + `restore`;
  assert decrypted vaults are byte-identical; wrong password on B fails to decrypt.
- **Password-change consistency:** change password, `pushKeys`, then a fresh device can
  still `signIn` + `restore` with the new password; the recovery key still works.

---

## 10. Milestones & rough effort

Sequenced so each is demoable. (Sizing is indicative — 1 person, focused.)

- **1a — Backend skeleton + auth** (~1 wk): Worker + D1 schema, `account` / `prelogin` /
  `session` / `logout`, Argon2id, rate limits, CORS. Contract tests.
- **1b — Vault store + `sync.js` backup** (~1 wk): R2 wiring, `GET/PUT /vault` + CAS,
  client `enable` + `backupNow`, Settings signed-in card, dirty flag.
- **1c — Restore on a new device** (~0.5 wk): `prelogin`+`signIn`+`restore`, "Sign in"
  UI, two-device E2E green.
- **1d — Password-change sync + account deletion** (~0.5 wk): `pushKeys`, `DELETE
  /account`, confirm dialogs, offline queue.
- **1e — Hardening + review** (~1 wk): rate-limit/enumeration tuning, blob-size padding,
  zero-knowledge test, email verification (or explicitly defer), security review.

**≈ 4–5 focused weeks** to a launchable, audited one-way sync. This is where the project
takes on **hosting + email + ops + a support surface** — worth confirming demand
(Phase 0 is already useful without it) before committing.

---

## 11. Open decisions (call before 1a)

1. **Backend:** Cloudflare (Workers+D1+R2) vs. Supabase. → *recommend Cloudflare.*
2. **Email verification:** gate first backup on it, or fast-follow? → *recommend gate it;
   defer only if it blocks the MVP.*
3. **Account model:** one password for both local KEK and cloud auth (recommended — one
   thing to remember), vs. a separate sync password. → *recommend one password.*
4. **Local username vs. cloud email:** Phase 1 keeps the local username and adds an email
   for the cloud account; confirm that's acceptable vs. migrating local accounts to email.
5. **Pricing/product:** free vs. paid sync tier — out of engineering scope, but it
   determines abuse controls and whether email verification is mandatory.
```
