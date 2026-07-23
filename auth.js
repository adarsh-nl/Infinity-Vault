// auth.js — password-based unlock for the encrypted local vault.
//
// The login password is stretched with PBKDF2 into the AES-GCM key that
// encrypts the investment data (see crypto.js / storage.js). The password is
// NEVER stored — only a random salt, the iteration count, and a small
// "verifier" blob that the correct key can decrypt. A wrong password makes the
// verifier's GCM check fail, so login is rejected without any password compare.
//
// The derived key lives in memory for the session and is mirrored (as a JWK)
// into sessionStorage so a page reload in the same tab stays unlocked; closing
// the tab clears it (auto-lock). Persistent at-rest data in localStorage stays
// ciphertext regardless.
const AUTH_KEY = 'infinity_vault_auth';
const SESSION_KEY = 'infinity_vault_session';
const SKEY = 'infinity_vault_skey'; // session-scoped derived key (JWK)
const VERIFIER_TOKEN = 'infinity-vault';

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

    /** Register a new user. Returns true on success. */
    static async register(username, password) {
        if (!username || !password) return false;
        const uname = username.trim().toLowerCase();

        if (VaultCrypto.isSupported()) {
            const salt = VaultCrypto.randomBytes(16);
            const iterations = VaultCrypto.PBKDF2_ITERATIONS;
            const key = await VaultCrypto.deriveKey(password, salt, iterations);
            const verifier = await VaultCrypto.encryptJSON(key, { check: VERIFIER_TOKEN });

            localStorage.setItem(AUTH_KEY, JSON.stringify({
                v: 2, username: uname, kdf: 'PBKDF2', hash: 'SHA-256',
                iterations, salt: VaultCrypto.bytesToB64(salt), verifier
            }));

            // Preserve any data already present (e.g. a password change re-encrypts
            // the current portfolio under the new key).
            const existing = InvestmentStorage.getInvestments();
            await InvestmentStorage.enableEncryption(key, existing);
            await this._establishSession(key);
            return true;
        }

        // Fallback: no Web Crypto (insecure context) — legacy plaintext account.
        const hash = await this.hashPassword(password);
        localStorage.setItem(AUTH_KEY, JSON.stringify({ v: 1, username: uname, passwordHash: hash }));
        sessionStorage.setItem(SESSION_KEY, 'true');
        return true;
    }

    /** Attempt login. Returns true if credentials match. */
    static async login(username, password) {
        const authData = this._readAuth();
        if (!authData) return false;
        if (authData.username !== username.trim().toLowerCase()) return false;

        if (authData.v === 2 || authData.verifier) {
            if (!VaultCrypto.isSupported()) return false;
            const salt = VaultCrypto.b64ToBytes(authData.salt);
            const key = await VaultCrypto.deriveKey(password, salt, authData.iterations);
            try {
                const check = await VaultCrypto.decryptJSON(key, authData.verifier);
                if (!check || check.check !== VERIFIER_TOKEN) return false;
            } catch {
                return false; // wrong password → GCM auth tag mismatch
            }
            await this._establishSession(key);
            return true;
        }

        // Legacy v1 account: verify the SHA-256 hash, then upgrade to encrypted.
        const hash = await this.hashPassword(password);
        if (authData.passwordHash !== hash) return false;
        if (VaultCrypto.isSupported()) {
            await this._migrateLegacy(authData.username, password);
        } else {
            sessionStorage.setItem(SESSION_KEY, 'true');
        }
        return true;
    }

    /** Upgrade a plaintext (v1) account + data to PBKDF2 + AES-GCM, losslessly. */
    static async _migrateLegacy(uname, password) {
        const existing = InvestmentStorage.getInvestments(); // plaintext, read before we change anything
        const salt = VaultCrypto.randomBytes(16);
        const iterations = VaultCrypto.PBKDF2_ITERATIONS;
        const key = await VaultCrypto.deriveKey(password, salt, iterations);
        const verifier = await VaultCrypto.encryptJSON(key, { check: VERIFIER_TOKEN });

        localStorage.setItem(AUTH_KEY, JSON.stringify({
            v: 2, username: uname, kdf: 'PBKDF2', hash: 'SHA-256',
            iterations, salt: VaultCrypto.bytesToB64(salt), verifier
        }));
        await InvestmentStorage.enableEncryption(key, existing); // encrypts data at rest
        await this._establishSession(key);
    }

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

    static async _establishSession(key) {
        sessionStorage.setItem(SESSION_KEY, 'true');
        try {
            sessionStorage.setItem(SKEY, JSON.stringify(await VaultCrypto.exportKey(key)));
        } catch { /* non-extractable / no crypto — reload will require re-login */ }
        if (!InvestmentStorage.hasKey()) {
            await InvestmentStorage.unlock(key);
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
