-- Infinity Vault sync — D1 (SQLite) schema. See docs/design/e2ee-sync-phase1.md §5.
-- Everything here is opaque to the server: salts, an authHash *proof* (hashed
-- again server-side), and wrapped keys. No password, no plaintext, no vault data.

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,              -- uuid v4
  email             TEXT UNIQUE NOT NULL,
  email_verified    INTEGER NOT NULL DEFAULT 0,
  -- split-derivation auth
  auth_salt         TEXT NOT NULL,                 -- b64 (client PBKDF2 salt for authHash)
  auth_iters        INTEGER NOT NULL,
  server_salt       TEXT NOT NULL,                 -- b64 (server-side hash salt)
  server_hash       TEXT NOT NULL,                 -- hash(authHash, server_salt)  [see worker.js]
  -- account envelope (lets a new device reconstruct the DEK from the password)
  kek_salt          TEXT NOT NULL,                 -- b64
  kek_iters         INTEGER NOT NULL,
  wrapped_dek       TEXT NOT NULL,                 -- JSON {iv,ct}
  recovery          TEXT,                          -- JSON {salt,iterations,wrappedDEK} | NULL
  -- vault pointer (blob lives in R2 at vault/{id})
  vault_version     INTEGER NOT NULL DEFAULT 0,
  vault_updated_at  INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,                    -- sha256(token) hex
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
