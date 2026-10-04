# Design: End-to-End Encrypted Sync

**Status:** Proposed · **Author:** —  · **Supersedes:** none
**Depends on:** the local encrypted vault (PBKDF2 → AES-GCM, see `crypto.js`/`auth.js`)

> Goal in one line: let a user open their vault on a second device and see the same
> data, **without the server ever holding plaintext, the encryption key, or the password.**

---

## 1. Principles (non-negotiable)

1. **Zero-knowledge server.** The backend stores and relays ciphertext only. A full
   server compromise must leak no portfolio data.
2. **Local-first.** The app keeps working 100% offline. Sync is an *optional layer*,
   not a dependency — losing the network never blocks the user.
3. **The password never leaves the device.** Not even hashed-as-sent-for-login in a
   form the server could use to derive the key.
4. **Honest recovery.** E2EE means a forgotten password is unrecoverable *unless* the
   user kept a recovery key. We make that explicit and give them the key up front.

Everything below serves these four.

---

## 2. What has to change vs. today

| Area | Today | Needed for sync |
|------|-------|-----------------|
| Key model | AES-GCM key derived **directly** from password (one key) | **Envelope**: random data key wrapped by a password-derived key |
| Identity | Local username + password (UI lock only) | A real **account** the server can authenticate |
| Storage | `localStorage` on one browser | Local **+** an encrypted blob the server holds |
| Concurrency | N/A (single writer) | **Conflict resolution** across devices, done client-side |
| Recovery | Export a JSON backup | **Recovery key** (server can't help) |

---

## 3. Key architecture — envelope encryption

The current model (derive the data key straight from the password) makes password
changes require re-encrypting the whole vault and gives no path to recovery keys or
multi-wrapping. Switch to a two-key envelope:

```
password ──(Argon2id, per-user salt)──▶  KEK  (Key-Encryption Key, never leaves device)
                                          │
random 256-bit  ─────────────────────▶  DEK  (Data-Encryption Key, encrypts the vault)
                                          │
                            wrappedDEK = AES-GCM(KEK, DEK)   ◀── synced to server
```

- **DEK** encrypts the investment blob (AES-256-GCM). It is random, generated once,
  and **never leaves any device unwrapped**.
- **KEK** is derived from the password with **Argon2id** (memory-hard; big upgrade over
  today's PBKDF2 — ship via a small WASM lib, fall back to PBKDF2-SHA256 @ ≥600k iters
  where WASM is unavailable). Per-user random salt, stored with the account.
- The server only ever sees **`wrappedDEK`** (ciphertext) — useless without the KEK.

**Payoffs this unlocks:**
- *Password change* = re-derive KEK, re-wrap the DEK. Cheap; no vault re-encryption.
- *Recovery* = wrap the same DEK a **second** time under a recovery key (§8).
- *Multi-device* = every device unwraps the same DEK from its own password entry.

> **Decision — KDF:** Argon2id (recommended) vs. PBKDF2. Argon2id resists GPU/ASIC
> cracking far better; cost is a ~50 KB WASM dependency (breaks the "zero external JS"
> purity, but only on the sync path). Recommend Argon2id with a PBKDF2 fallback.

---

## 4. Authentication without revealing the password

The server must know *whose* ciphertext to serve, but must not learn anything that
lets it derive the KEK. Two viable designs:

**A. Split-derivation (Bitwarden model) — recommended for v1.**
Derive a master secret from the password, then derive **two independent** values with
different KDF contexts:
- `KEK` → stays on device (wraps the DEK).
- `authHash` = KDF(masterSecret, "auth") → sent to the server **once per login**; the
  server salts-and-hashes it *again* before storage. `authHash` reveals nothing about
  `KEK` (independent derivation), and the server never sees the raw password.
Well-understood, straightforward to implement on Web Crypto.

**B. OPAQUE (aPAKE) — the stronger, future option.**
An asymmetric PAKE (RFC 9380 / draft-irtf-cfrg-opaque): the server authenticates the
user *without ever receiving any password-derived value at all*, defeating even
server-side precomputation. More moving parts; a good v2 hardening.

Either way: successful auth returns a **short-lived session token** (opaque bearer or
JWT) used for the sync API. Tokens are revocable per device (§ roadmap Phase 3).

> **Decision — auth:** ship split-derivation (A) for v1; treat OPAQUE (B) as a tracked
> upgrade. Both keep the password off the wire in usable form.

---

## 5. Sync protocol & conflict resolution

Because the server can't read ciphertext, **all merging happens client-side after
decrypt.** The unit of sync therefore matters.

**v1 model — single encrypted blob + optimistic concurrency.**
- Vault shape (inside the ciphertext): `{ schema, records: [ { id, ...fields, updatedAt, deleted } ] }`.
  Deletes are **tombstones** (`deleted: true` + `updatedAt`), not removals, so a delete
  on one device propagates instead of being resurrected by a stale peer.
- Server holds: `{ vaultVersion, ciphertext }` and an ETag == `vaultVersion`.
- **Pull:** `GET /vault` → decrypt → merge into local (see below).
- **Push:** `PUT /vault` with `If-Match: <vaultVersion>`. On `409 Conflict`, pull →
  merge → retry. (Compare-and-swap; no lost updates.)
- **Merge (client, deterministic):** union records by `id`; for collisions keep the
  higher `updatedAt` (last-writer-wins per record); a tombstone beats an older edit.
  Purge tombstones older than N days after they've surely propagated.
- **Offline:** every local mutation stamps `updatedAt`; a pending-changes flag triggers
  push on reconnect. The existing local vault is the source of truth until then.

**Why not per-record ciphertext in v1?** It merges more granularly but (a) leaks record
count/sizes as metadata and (b) adds key/IV management per record. LWW-by-record inside
one blob gets ~all the practical benefit for a personal portfolio (few records, rare
concurrent edits). Revisit if real conflicts prove common.

> **Decision — granularity:** single blob + per-record LWW merge for v1; per-record
> ciphertext is a documented v2+ option, not a v1 requirement.

---

## 6. Backend (deliberately minimal)

Endpoints (all over TLS; ciphertext bodies):

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/account` | register: email, salt, `authHash`, `wrappedDEK`, recovery-`wrappedDEK` |
| POST | `/session` | login: email + `authHash` → session token |
| GET  | `/vault` | return `{ vaultVersion, ciphertext }` |
| PUT  | `/vault` | store ciphertext; `If-Match` CAS on `vaultVersion` |
| POST | `/account/rotate` | new salt / `authHash` / re-`wrappedDEK` (password change) |
| DELETE | `/account` | wipe ciphertext + account |

**What the server can see:** email, a salted hash of `authHash`, the account salt,
`wrappedDEK` (opaque), the vault ciphertext (opaque), version numbers, timestamps.
**What it cannot see:** password, KEK, DEK, any investment field.

**Stack options** (pick for cost/ops, not features):
- *Serverless KV* — Cloudflare Workers + D1 (auth/metadata) + R2/KV (blob). Cheap, low-ops. **Recommended.**
- *BaaS* — Supabase (Postgres + Row-Level Security + Storage). Fast to stand up; RLS enforces per-user isolation.
- *Self-host* — small Fastify/Node + Postgres + S3. Most control, most ops.

Cross-cutting: rate limiting (login especially), minimal logging (no ciphertext, no
sizes in logs), CORS locked to the app origin, and the app's existing CSP extended with
the sync origin in `connect-src`.

---

## 7. Migration for existing (local-only) users

Local-only stays the **default**; sync is opt-in via Settings → "Enable Sync".

On enable:
1. Generate a random **DEK**; re-encrypt the current vault under it (it's currently
   under the password-derived key — a lossless re-key, same pattern as the
   legacy→v2 migration already shipped in `auth.js`).
2. Derive **KEK** from the existing password (new Argon2id salt); compute `wrappedDEK`.
3. Collect an **email** (new requirement) + generate the **recovery key** (§8).
4. Create the account and perform the **initial upload**.
5. Bump the local vault format `v2 → v3` (envelope). A device that never enables sync
   can also be migrated to v3 locally so the key model is uniform.

No data is destroyed; the local encrypted copy remains authoritative throughout.

---

## 8. Recovery & account lifecycle

**Recovery key** — the crux of honest E2EE. At sync setup, generate a high-entropy code
(e.g. 32 bytes → grouped Base32), show it **once**, and store `wrappedDEK_recovery =
AES-GCM(recoveryKey, DEK)` on the server. If the password is lost, the user enters the
recovery key → unwraps the DEK → sets a new password (new KEK, re-wrap). **Without it,
a forgotten password means the data is gone — and we say so, clearly, at setup.**

- **Email verification** on register (deliverability + reduces abuse).
- **"Password reset"** resets *authentication* only; it does **not** decrypt data. Real
  reset requires the recovery key or the old password. The UI must not imply otherwise.
- **Account deletion** wipes server ciphertext; local data is untouched (still usable
  offline).

---

## 9. Threat model (stated honestly)

| Adversary | Outcome |
|-----------|---------|
| Server operator / DB dump / subpoena | Ciphertext + metadata only. No portfolio data, no password. |
| Network (MITM) | TLS; bodies are already ciphertext. |
| Lost/stolen device (locked) | At-rest vault is encrypted; needs the password. |
| Malicious script in the page (XSS) | **Plaintext is exposed in-session** — inherent to any web app. Mitigated (not eliminated) by the existing escaping + CSP + SRI. |

**Metadata that still leaks:** account existence & email, ciphertext size (≈ portfolio
size), sync timestamps, device count. Mitigations: pad ciphertext to size buckets,
minimize logs/retention, no per-record sizes.

**Hard requirements before launch:** use vetted primitives only (Web Crypto,
`libsodium`/`argon2` WASM — no hand-rolled crypto), and commission an **independent
security review** of the key handling and sync protocol.

---

## 10. Phased roadmap

Ordered so each phase ships standalone value and de-risks the next.

- **Phase 0 — Envelope key refactor + recovery key (client-only, no backend).**
  Move to DEK/KEK; add a recovery key + "reset password with recovery key" locally.
  Ships real value (recovery, password change without re-encrypt) with **zero
  infrastructure and zero new attack surface.** Highest ROI; do this first.
- **Phase 1 — Accounts + one-way encrypted cloud backup/restore.**
  Backend + auth + `GET/PUT /vault`, driven manually ("Back up now" / "Restore on this
  device"). Delivers the core cross-device story with the simplest possible sync.
- **Phase 2 — Two-way sync.** Optimistic concurrency + client-side LWW merge + tombstones.
- **Phase 3 — Background/auto sync.** Offline queue, periodic pull/push, device sessions
  + revocation, conflict UX.
- **Phase 4 — Recovery & account polish + audit + launch.** Email flows, account portal,
  padding, security audit sign-off.

---

## 11. Effort, cost & risk (read before committing)

This is the **largest** item on the roadmap and a genuine inflection point:

- It introduces a **backend, real accounts, infrastructure, and ongoing operations** —
  a static, free-to-host app becomes a service with hosting + email + uptime + a
  **support burden** (recovery, lost passwords) and a **security-audit requirement**.
- Recurring cost: hosting + transactional email + a one-time (then periodic) audit.
- Product risk: recovery UX is make-or-break; get it wrong and users lose data and trust.

**Recommendation:** build **Phase 0 now** (pure client, high value, low risk, no
commitment), use it to validate that users actually want cross-device sync, and only
then invest in the Phase 1 backend. Don't stand up infrastructure ahead of demand.

---

## 12. Testing strategy

- **Crypto (Vitest + Web Crypto):** DEK/KEK wrap→unwrap round-trip; password change
  re-wraps without touching the vault; recovery key unwraps the same DEK; wrong
  password/recovery key fail closed.
- **Merge (pure, deterministic):** LWW by `updatedAt`, tombstone precedence, offline
  replay, idempotent re-merge (merge(merge(a,b),b) == merge(a,b)).
- **Protocol:** CAS `409` → pull → merge → retry converges; two simulated clients reach
  an identical vault.
- **Zero-knowledge assertion:** an automated test that captures every request body and
  asserts **no plaintext field ever appears** on the wire.
- **Backend:** auth contract tests, rate-limit behavior, per-user isolation (RLS).

---

## Open decisions (need a call before Phase 1)

1. **KDF:** Argon2id (+PBKDF2 fallback) vs. PBKDF2-only. → *recommend Argon2id.*
2. **Auth:** split-derivation now vs. OPAQUE now. → *recommend split-derivation, OPAQUE later.*
3. **Hosting:** Cloudflare (Workers+D1+R2) vs. Supabase vs. self-host. → *recommend Cloudflare for cost/ops.*
4. **Sync granularity:** single blob (v1) vs. per-record ciphertext. → *recommend single blob for v1.*
