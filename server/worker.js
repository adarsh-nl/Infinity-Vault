// Infinity Vault sync — Cloudflare Worker (REFERENCE SCAFFOLD).
//
// Implements the Phase 1 zero-knowledge API (docs/design/e2ee-sync-phase1.md §6).
// The executable behavioral spec for these endpoints is the in-memory mock in
// tests/sync.test.js — the client is verified against it. This Worker is NOT run
// by this repo's tests; deploy to Cloudflare to exercise it, and get a security
// review before production.
//
// KNOWN HARDENING TODOs (called out inline):
//  - server-side hashing uses PBKDF2 here; production should use Argon2id (WASM).
//  - add rate limiting on /prelogin + /session (Cloudflare rules or a KV counter).
//  - add email verification before first backup.

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const now = () => Date.now();
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

async function sha256Hex(str) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Server-side hash of the client authHash. TODO: replace with Argon2id (WASM).
async function serverHash(authHashB64, saltB64) {
  const key = await crypto.subtle.importKey('raw', b64d(authHashB64), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64d(saltB64), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return b64(bits);
}
// Constant-time-ish compare.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function uuid() { return crypto.randomUUID(); }
function randomToken() { return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, ''); }

const json = (obj, status, origin) => new Response(obj == null ? '' : JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', ...cors(origin) },
});
const err = (code, status, origin) => json({ error: code }, status, origin);
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

async function authUser(request, env) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return null;
  const row = await env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .bind(await sha256Hex(token)).first();
  if (!row || row.expires_at < now()) return null;
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
}

async function newSession(env, userId) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .bind(await sha256Hex(token), userId, now(), now() + SESSION_TTL_MS).run();
  return { token, expiresAt: now() + SESSION_TTL_MS };
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const url = new URL(request.url);
    const path = url.pathname;
    const body = ['POST', 'PUT'].includes(request.method) ? await request.json().catch(() => ({})) : null;

    try {
      // ---- register ----
      if (request.method === 'POST' && path === '/v1/account') {
        const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(body.email).first();
        if (exists) return err('email_taken', 409, origin);
        const id = uuid();
        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        await env.DB.prepare(
          `INSERT INTO users (id,email,auth_salt,auth_iters,server_salt,server_hash,kek_salt,kek_iters,wrapped_dek,recovery,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, body.email, body.authSalt, body.authIters, salt, await serverHash(body.authHash, salt),
          body.kekSalt, body.kekIters, JSON.stringify(body.wrappedDEK),
          body.recovery ? JSON.stringify(body.recovery) : null, now()).run();
        return json(await newSession(env, id), 201, origin);
      }

      // ---- prelogin (returns the client salt; dummy for unknown emails) ----
      if (request.method === 'POST' && path === '/v1/session/prelogin') {
        const u = await env.DB.prepare('SELECT auth_salt, auth_iters FROM users WHERE email = ?').bind(body.email).first();
        if (u) return json({ authSalt: u.auth_salt, authIters: u.auth_iters }, 200, origin);
        // Deterministic dummy salt per email → resists account enumeration.
        return json({ authSalt: (await sha256Hex('dummy:' + body.email)).slice(0, 24), authIters: 210000 }, 200, origin);
      }

      // ---- session (login) ----
      if (request.method === 'POST' && path === '/v1/session') {
        const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(body.email).first();
        if (!u || !safeEqual(await serverHash(body.authHash, u.server_salt), u.server_hash)) {
          return err('invalid_credentials', 401, origin);
        }
        const sess = await newSession(env, u.id);
        return json({
          ...sess,
          account: {
            kekSalt: u.kek_salt, kekIters: u.kek_iters,
            wrappedDEK: JSON.parse(u.wrapped_dek),
            recovery: u.recovery ? JSON.parse(u.recovery) : null,
            vaultVersion: u.vault_version,
          },
        }, 200, origin);
      }

      // ---- authenticated endpoints ----
      const user = await authUser(request, env);
      if (path.startsWith('/v1/vault') || path === '/v1/account/keys' ||
          (path === '/v1/account' && request.method === 'DELETE') || path === '/v1/session/logout') {
        if (!user) return err('unauthorized', 401, origin);
      }

      if (request.method === 'GET' && path === '/v1/vault') {
        const obj = await env.VAULT.get(`vault/${user.id}`);
        if (!obj) return new Response(null, { status: 204, headers: cors(origin) });
        return json({ vaultVersion: user.vault_version, ciphertext: await obj.text() }, 200, origin);
      }

      if (request.method === 'PUT' && path === '/v1/vault') {
        if ((body.baseVersion || 0) !== user.vault_version) {
          return json({ error: 'version_conflict', vaultVersion: user.vault_version }, 409, origin);
        }
        const nv = user.vault_version + 1;
        await env.VAULT.put(`vault/${user.id}`, body.ciphertext);
        await env.DB.prepare('UPDATE users SET vault_version = ?, vault_updated_at = ? WHERE id = ?')
          .bind(nv, now(), user.id).run();
        return json({ vaultVersion: nv }, 200, origin);
      }

      if (request.method === 'POST' && path === '/v1/account/keys') {
        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        await env.DB.prepare(
          'UPDATE users SET auth_salt=?, auth_iters=?, server_salt=?, server_hash=?, kek_salt=?, kek_iters=?, wrapped_dek=? WHERE id=?'
        ).bind(body.authSalt, body.authIters, salt, await serverHash(body.authHash, salt),
          body.kekSalt, body.kekIters, JSON.stringify(body.wrappedDEK), user.id).run();
        return json({}, 200, origin);
      }

      if (request.method === 'DELETE' && path === '/v1/account') {
        await env.VAULT.delete(`vault/${user.id}`);
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
        return new Response(null, { status: 204, headers: cors(origin) });
      }

      if (request.method === 'POST' && path === '/v1/session/logout') {
        const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
        return new Response(null, { status: 204, headers: cors(origin) });
      }

      return err('not_found', 404, origin);
    } catch (e) {
      return err('server_error', 500, origin);
    }
  },
};
