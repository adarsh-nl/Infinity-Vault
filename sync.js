// sync.js — E2EE cloud backup/restore client (Phase 1).
//
// Zero-knowledge: the server only ever receives ciphertext, salts, and an
// authHash proof — never the password, the keys, or any investment field. The
// vault at rest in localStorage is ALREADY an AES-GCM blob under the DEK, so a
// backup uploads that blob verbatim and a restore writes it back — no new
// crypto path (see docs/design/e2ee-sync-phase1.md).
//
// This module is the client half only; it talks to the API contract via an
// injectable transport (defaults to `fetch`), so it is testable without a
// network. It is NOT wired into the app UI yet — that waits for a real backend.
//
// Loads as a browser global `Sync`; imports under Node for tests.
(function (root, factory) {
    const api = factory();
    root.Sync = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const SYNC_KEY = 'infinity_vault_sync';         // localStorage: config + envelope
    const TOKEN_KEY = 'infinity_vault_sync_token';  // sessionStorage: bearer token
    const AUTH_ITERS = 210000;

    // Injectable transport (a fetch-like fn). Tests supply an in-memory server.
    let _fetch = (typeof fetch !== 'undefined') ? fetch.bind(globalThis) : null;
    let _now = () => new Date().toISOString();
    function setTransport(fn) { _fetch = fn; }
    function _setClock(fn) { _now = fn; } // test hook

    function _cfg() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch { return {}; } }
    function _saveCfg(c) { localStorage.setItem(SYNC_KEY, JSON.stringify(c)); }
    function _token() { return sessionStorage.getItem(TOKEN_KEY); }

    async function _api(method, path, body, auth) {
        const headers = { 'Content-Type': 'application/json' };
        if (auth) headers['Authorization'] = 'Bearer ' + (_token() || '');
        const res = await _fetch(_cfg().apiBase + path, {
            method, headers, body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) {
            const err = new Error(data.error || ('http_' + res.status));
            err.status = res.status; err.data = data;
            throw err;
        }
        return data;
    }

    /** Point the client at an API origin (persisted). */
    function configure(apiBase) { const c = _cfg(); c.apiBase = apiBase; _saveCfg(c); }

    /** Enable sync from the current unlocked local vault (registers + first backup). */
    async function enable(email, password) {
        const env = AuthManager.getAccountEnvelope();
        if (!env) throw new Error('locked'); // must be a v3 account
        const authSalt = VaultCrypto.randomBytes(16);
        const authHash = await VaultCrypto.deriveAuthHash(password, authSalt, AUTH_ITERS);

        const { token } = await _api('POST', '/v1/account', {
            email, authSalt: VaultCrypto.bytesToB64(authSalt), authIters: AUTH_ITERS, authHash,
            kekSalt: env.kekSalt, kekIters: env.kekIters, wrappedDEK: env.wrappedDEK, recovery: env.recovery
        });
        sessionStorage.setItem(TOKEN_KEY, token);

        const c = _cfg();
        Object.assign(c, { enabled: true, email, authSalt: VaultCrypto.bytesToB64(authSalt), authIters: AUTH_ITERS, vaultVersion: 0 });
        _saveCfg(c);
        await backupNow();
        return true;
    }

    async function prelogin(email) { return _api('POST', '/v1/session/prelogin', { email }); }

    /** Sign in on any device; caches the token + account envelope for restore(). */
    async function signIn(email, password) {
        const pre = await prelogin(email);
        const authHash = await VaultCrypto.deriveAuthHash(password, VaultCrypto.b64ToBytes(pre.authSalt), pre.authIters);
        const { token, account } = await _api('POST', '/v1/session', { email, authHash });
        sessionStorage.setItem(TOKEN_KEY, token);

        const c = _cfg();
        Object.assign(c, { enabled: true, email, authSalt: pre.authSalt, authIters: pre.authIters, vaultVersion: account.vaultVersion, account });
        _saveCfg(c);
        return account;
    }

    /** Restore the vault to THIS device using the signed-in account + password. */
    async function restore(password) {
        const c = _cfg();
        const account = c.account;
        if (!account) throw new Error('not_signed_in');

        const kek = await VaultCrypto.deriveWrappingKey(password, VaultCrypto.b64ToBytes(account.kekSalt), account.kekIters);
        let dek;
        try { dek = await VaultCrypto.unwrapDEK(kek, account.wrappedDEK); }
        catch { throw new Error('bad_password'); }

        const vault = await _api('GET', '/v1/vault', null, true); // {vaultVersion, ciphertext} or {}
        await AuthManager.installAccount(c.email, account, dek, vault.ciphertext || null);
        c.vaultVersion = vault.vaultVersion || 0;
        _saveCfg(c);
        return true;
    }

    /** Upload the current at-rest ciphertext blob (no re-encryption). */
    async function backupNow() {
        const c = _cfg();
        const ciphertext = InvestmentStorage.exportBlob();
        if (ciphertext == null) return false;
        try {
            const { vaultVersion } = await _api('PUT', '/v1/vault', { ciphertext, baseVersion: c.vaultVersion || 0 }, true);
            Object.assign(c, { vaultVersion, lastBackup: _now(), dirty: false });
            _saveCfg(c);
            return true;
        } catch (e) {
            if (e.status === 409) { // another device pushed a newer version
                const err = new Error('version_conflict');
                err.serverVersion = e.data && e.data.vaultVersion;
                throw err;
            }
            throw e;
        }
    }

    /** After a local password change, resync the auth proof + re-wrapped DEK. */
    async function pushKeys(password) {
        const env = AuthManager.getAccountEnvelope();
        if (!env) throw new Error('locked');
        const authSalt = VaultCrypto.randomBytes(16);
        const authHash = await VaultCrypto.deriveAuthHash(password, authSalt, AUTH_ITERS);
        await _api('POST', '/v1/account/keys', {
            authSalt: VaultCrypto.bytesToB64(authSalt), authIters: AUTH_ITERS, authHash,
            kekSalt: env.kekSalt, kekIters: env.kekIters, wrappedDEK: env.wrappedDEK
        }, true);
        const c = _cfg();
        Object.assign(c, { authSalt: VaultCrypto.bytesToB64(authSalt), authIters: AUTH_ITERS });
        _saveCfg(c);
    }

    /** Flip the "needs backup" flag on a local mutation. */
    function markDirty() { const c = _cfg(); if (c.enabled) { c.dirty = true; _saveCfg(c); } }

    function status() {
        const c = _cfg();
        return {
            enabled: !!c.enabled, email: c.email || null,
            lastBackup: c.lastBackup || null, vaultVersion: c.vaultVersion || 0,
            dirty: !!c.dirty, signedIn: !!_token()
        };
    }

    function signOut() { sessionStorage.removeItem(TOKEN_KEY); }

    async function disableAndDelete() {
        try { await _api('DELETE', '/v1/account', null, true); } finally {
            sessionStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(SYNC_KEY);
        }
    }

    return {
        configure, setTransport, _setClock,
        enable, prelogin, signIn, restore, backupNow, pushKeys,
        markDirty, status, signOut, disableAndDelete,
    };
});
