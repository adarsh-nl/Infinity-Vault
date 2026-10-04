// auth.js — password-based unlock for the envelope-encrypted local vault.
//
// A random Data-Encryption Key (DEK) encrypts the vault (see crypto.js /
// storage.js). The DEK is wrapped by a password-derived Key-Encryption Key
// (KEK) and, once set, by a recovery key. Only the wrapped DEK is stored; the
// password and KEK never leave the device. Login unwraps the DEK; a wrong
// password makes the AES-GCM unwrap fail. Password change re-wraps the DEK
// without re-encrypting the vault. Recovery unwraps the DEK via the recovery
// key. Existing v1 (plaintext) and v2 (single password key) accounts migrate
// to this v3 envelope on first login, losslessly.
//
// The DEK lives in memory for the session and is mirrored (as a JWK) into
// sessionStorage so a reload in the same tab stays unlocked; closing the tab
// clears it. At-rest data in localStorage stays ciphertext regardless.
const AUTH_KEY = 'infinity_vault_auth';
const SESSION_KEY = 'infinity_vault_session';
const SKEY = 'infinity_vault_skey'; // session-scoped DEK (JWK)
const VERIFIER_TOKEN = 'infinity-vault'; // legacy v2 verifier payload

class AuthManager {
    /** SHA-256 hex — retained only to verify + migrate legacy (v1) accounts. */
    static async hashPassword(password) {
        const data = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    static isRegistered() {
        return localStorage.getItem(AUTH_KEY) !== null;
    }

    static _readAuth() {
        try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; }
    }

    static _writeAuth(authData) {
        localStorage.setItem(AUTH_KEY, JSON.stringify(authData));
    }

    // ---- envelope helpers --------------------------------------------------

    /** Wrap `dek` under a password-derived KEK → { salt, iterations, wrappedDEK }. */
    static async _wrapWithPassword(dek, password) {
        const salt = VaultCrypto.randomBytes(16);
        const iterations = VaultCrypto.PBKDF2_ITERATIONS;
        const kek = await VaultCrypto.deriveWrappingKey(password, salt, iterations);
        const wrappedDEK = await VaultCrypto.wrapDEK(kek, dek);
        return { salt: VaultCrypto.bytesToB64(salt), iterations, wrappedDEK };
    }

    /** Wrap `dek` under a recovery-key-derived KEK → { salt, iterations, wrappedDEK }. */
    static async _wrapWithRecovery(dek, recoveryKey) {
        const salt = VaultCrypto.randomBytes(16);
        const iterations = VaultCrypto.PBKDF2_ITERATIONS;
        const kek = await VaultCrypto.deriveWrappingKey(VaultCrypto.normalizeRecoveryKey(recoveryKey), salt, iterations);
        const wrappedDEK = await VaultCrypto.wrapDEK(kek, dek);
        return { salt: VaultCrypto.bytesToB64(salt), iterations, wrappedDEK };
    }

    /** Unwrap the DEK from an envelope ({ salt, iterations, wrappedDEK }) with a secret. Null on failure. */
    static async _unwrap(envelope, secret) {
        try {
            const salt = VaultCrypto.b64ToBytes(envelope.salt);
            const kek = await VaultCrypto.deriveWrappingKey(secret, salt, envelope.iterations);
            return await VaultCrypto.unwrapDEK(kek, envelope.wrappedDEK);
        } catch {
            return null;
        }
    }

    // ---- registration ------------------------------------------------------

    /**
     * Register a new user. On success returns the one-time recovery key (string)
     * for the caller to display; returns `true` in the no-crypto fallback and
     * `false` on invalid input.
     */
    static async register(username, password) {
        if (!username || !password) return false;
        const uname = username.trim().toLowerCase();

        if (VaultCrypto.isSupported()) {
            const dek = await VaultCrypto.generateDEK();
            const pw = await this._wrapWithPassword(dek, password);
            const recoveryKey = VaultCrypto.generateRecoveryKey();
            const recovery = await this._wrapWithRecovery(dek, recoveryKey);

            this._writeAuth({
                v: 3, username: uname, kdf: 'PBKDF2',
                iterations: pw.iterations, salt: pw.salt, wrappedDEK: pw.wrappedDEK,
                recovery
            });

            // Encrypt any data already present under the new DEK.
            const existing = InvestmentStorage.getInvestments();
            await InvestmentStorage.enableEncryption(dek, existing);
            await this._establishSession(dek);
            return recoveryKey;
        }

        // Fallback: no Web Crypto (insecure context) — legacy plaintext account.
        const hash = await this.hashPassword(password);
        this._writeAuth({ v: 1, username: uname, passwordHash: hash });
        sessionStorage.setItem(SESSION_KEY, 'true');
        return true;
    }

    // ---- login + migration -------------------------------------------------

    /** Attempt login. Returns true if credentials match. */
    static async login(username, password) {
        const authData = this._readAuth();
        if (!authData) return false;
        if (authData.username !== username.trim().toLowerCase()) return false;

        // v3 envelope: unwrap the DEK with the password.
        if (authData.v === 3) {
            if (!VaultCrypto.isSupported()) return false;
            const dek = await this._unwrap(authData, password);
            if (!dek) return false;
            await this._establishSession(dek);
            return true;
        }

        // v2 single-key account: verify via the verifier, then migrate to v3.
        if (authData.v === 2 || authData.verifier) {
            if (!VaultCrypto.isSupported()) return false;
            const salt = VaultCrypto.b64ToBytes(authData.salt);
            const oldKey = await VaultCrypto.deriveKey(password, salt, authData.iterations);
            try {
                const check = await VaultCrypto.decryptJSON(oldKey, authData.verifier);
                if (!check || check.check !== VERIFIER_TOKEN) return false;
            } catch {
                return false;
            }
            await this._migrateToV3(authData.username, password, oldKey);
            return true;
        }

        // Legacy v1 plaintext account: verify the hash, then upgrade.
        const hash = await this.hashPassword(password);
        if (authData.passwordHash !== hash) return false;
        if (VaultCrypto.isSupported()) {
            await this._migrateToV3(authData.username, password, null);
        } else {
            sessionStorage.setItem(SESSION_KEY, 'true');
        }
        return true;
    }

    /**
     * Re-key an existing account to the v3 envelope. `oldKey` decrypts the
     * current vault (v2); pass null for v1 (data is plaintext on disk). No
     * recovery key is created here — migrated users are prompted to set one up
     * from Settings. Lossless.
     */
    static async _migrateToV3(uname, password, oldKey) {
        if (oldKey) await InvestmentStorage.unlock(oldKey); // decrypt current data into memory
        const data = InvestmentStorage.getInvestments();

        const dek = await VaultCrypto.generateDEK();
        const pw = await this._wrapWithPassword(dek, password);
        this._writeAuth({
            v: 3, username: uname, kdf: 'PBKDF2',
            iterations: pw.iterations, salt: pw.salt, wrappedDEK: pw.wrappedDEK,
            recovery: null
        });
        await InvestmentStorage.enableEncryption(dek, data); // re-encrypt under the DEK
        await this._establishSession(dek);
    }

    // ---- password change + recovery ----------------------------------------

    /** Change the password by re-wrapping the DEK. Returns true on success. */
    static async changePassword(currentPassword, newPassword) {
        const authData = this._readAuth();
        if (!authData || authData.v !== 3) return false;
        const dek = await this._unwrap(authData, currentPassword);
        if (!dek) return false; // current password wrong

        const pw = await this._wrapWithPassword(dek, newPassword);
        authData.salt = pw.salt;
        authData.iterations = pw.iterations;
        authData.wrappedDEK = pw.wrappedDEK;
        this._writeAuth(authData); // recovery envelope + DEK unchanged
        return true;
    }

    static hasRecoveryKey() {
        const a = this._readAuth();
        return !!(a && a.recovery);
    }

    /**
     * Create (or replace) the recovery key for the current unlocked session.
     * Returns the one-time recovery key string, or null if locked/unsupported.
     */
    static async setupRecoveryKey() {
        const authData = this._readAuth();
        const dek = typeof InvestmentStorage !== 'undefined' ? InvestmentStorage.getKey() : null;
        if (!authData || authData.v !== 3 || !dek) return null;
        const recoveryKey = VaultCrypto.generateRecoveryKey();
        authData.recovery = await this._wrapWithRecovery(dek, recoveryKey);
        this._writeAuth(authData);
        return recoveryKey;
    }

    /**
     * Reset the password using the recovery key (for a forgotten password).
     * Unwraps the DEK via the recovery envelope and re-wraps it under the new
     * password. Returns true on success, false if the recovery key is invalid.
     */
    static async resetWithRecoveryKey(recoveryKey, newPassword) {
        const authData = this._readAuth();
        if (!authData || authData.v !== 3 || !authData.recovery) return false;
        const dek = await this._unwrap(authData.recovery, VaultCrypto.normalizeRecoveryKey(recoveryKey));
        if (!dek) return false;

        const pw = await this._wrapWithPassword(dek, newPassword);
        authData.salt = pw.salt;
        authData.iterations = pw.iterations;
        authData.wrappedDEK = pw.wrappedDEK;
        this._writeAuth(authData);
        await this._establishSession(dek);
        return true;
    }

    // ---- cloud sync support (E2EE, Phase 1) --------------------------------

    /**
     * The account envelope for upload: the non-secret key material a new device
     * needs to reconstruct the DEK from the password. All opaque to the server.
     */
    static getAccountEnvelope() {
        const a = this._readAuth();
        if (!a || a.v !== 3) return null;
        return { kekSalt: a.salt, kekIters: a.iterations, wrappedDEK: a.wrappedDEK, recovery: a.recovery || null };
    }

    /**
     * Install an account restored from the cloud onto this device: write the v3
     * envelope, drop in the (already-decrypted-capable) vault ciphertext, and
     * unlock with the DEK the caller unwrapped from the server envelope.
     */
    static async installAccount(email, account, dek, ciphertext) {
        this._writeAuth({
            v: 3, username: String(email).trim().toLowerCase(), kdf: 'PBKDF2',
            iterations: account.kekIters, salt: account.kekSalt,
            wrappedDEK: account.wrappedDEK, recovery: account.recovery || null
        });
        InvestmentStorage.importBlob(ciphertext); // ciphertext from GET /vault (or null)
        await this._establishSession(dek);        // stores DEK + decrypts the blob into memory
    }

    // ---- session lifecycle -------------------------------------------------

    /** Resume an existing session after a page reload (same tab). */
    static async resume() {
        const jwkStr = sessionStorage.getItem(SKEY);
        if (jwkStr && VaultCrypto.isSupported()) {
            try {
                const key = await VaultCrypto.importKey(JSON.parse(jwkStr));
                await InvestmentStorage.unlock(key);
                return true;
            } catch {
                return false;
            }
        }
        // Plaintext / legacy session: only resumable if on-disk data isn't encrypted.
        const raw = localStorage.getItem('infinity_vault_investments');
        if (!raw) return true;
        try {
            const parsed = JSON.parse(raw);
            return !VaultCrypto.isEncryptedBlob(parsed);
        } catch {
            return true;
        }
    }

    static async _establishSession(dek) {
        sessionStorage.setItem(SESSION_KEY, 'true');
        try {
            sessionStorage.setItem(SKEY, JSON.stringify(await VaultCrypto.exportKey(dek)));
        } catch { /* non-extractable / no crypto — reload will require re-login */ }
        if (!InvestmentStorage.hasKey()) {
            await InvestmentStorage.unlock(dek);
        }
    }

    static logout() {
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SKEY);
        if (typeof InvestmentStorage !== 'undefined') InvestmentStorage.lock();
    }

    static isLoggedIn() {
        return sessionStorage.getItem(SESSION_KEY) === 'true';
    }

    static getUsername() {
        const authData = this._readAuth();
        return authData && authData.username ? authData.username : '';
    }
}

// Export for the test runner (Vitest/Node). No-op in the browser.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AuthManager };
}
