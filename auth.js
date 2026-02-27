// auth.js — Lightweight client-side authentication
const AUTH_KEY = 'infinity_vault_auth';
const SESSION_KEY = 'infinity_vault_session';

class AuthManager {
    /**
     * Hash a password using SHA-256 via the Web Crypto API.
     * Returns a hex string.
     */
    static async hashPassword(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /** Check if a user account has been registered */
    static isRegistered() {
        return localStorage.getItem(AUTH_KEY) !== null;
    }

    /** Register a new user. Returns true on success. */
    static async register(username, password) {
        if (!username || !password) return false;
        const hash = await this.hashPassword(password);
        const authData = {
            username: username.trim().toLowerCase(),
            passwordHash: hash
        };
        localStorage.setItem(AUTH_KEY, JSON.stringify(authData));
        sessionStorage.setItem(SESSION_KEY, 'true');
        return true;
    }

    /** Attempt login. Returns true if credentials match. */
    static async login(username, password) {
        const stored = localStorage.getItem(AUTH_KEY);
        if (!stored) return false;

        try {
            const authData = JSON.parse(stored);
            const hash = await this.hashPassword(password);
            if (
                authData.username === username.trim().toLowerCase() &&
                authData.passwordHash === hash
            ) {
                sessionStorage.setItem(SESSION_KEY, 'true');
                return true;
            }
        } catch (e) {
            console.error('Auth check failed', e);
        }
        return false;
    }

    /** Logout — clears the session */
    static logout() {
        sessionStorage.removeItem(SESSION_KEY);
    }

    /** Check if the user is logged in for the current session */
    static isLoggedIn() {
        return sessionStorage.getItem(SESSION_KEY) === 'true';
    }

    /** Get the stored username */
    static getUsername() {
        const stored = localStorage.getItem(AUTH_KEY);
        if (!stored) return '';
        try {
            return JSON.parse(stored).username || '';
        } catch {
            return '';
        }
    }
}
