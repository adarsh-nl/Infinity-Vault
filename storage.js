const STORAGE_KEY = 'infinity_vault_investments';
const BACKUP_KEY = 'infinity_vault_backup_latest';

// ---- session state (module-scoped) -----------------------------------------
// The vault is decrypted once at unlock into `_cache`, which is the synchronous
// source of truth for the whole app. This lets getInvestments() stay sync (Web
// Crypto is async and rewiring every call site would be far riskier). At rest,
// data is always AES-GCM ciphertext keyed by the login password.
let _cache = null;                 // decrypted investments; null = not loaded into memory
let _key = null;                   // AES-GCM CryptoKey; null = plaintext mode (crypto unsupported / legacy)
let _persist = Promise.resolve();  // serializes async encrypted writes so they never race

// Safe even when crypto.js isn't loaded (e.g. a pure-logic test context).
function _looksEncrypted(v) {
    return typeof VaultCrypto !== 'undefined' && VaultCrypto.isEncryptedBlob(v);
}

class InvestmentStorage {
    // ---- session lifecycle -------------------------------------------------
    /** True once a session key is active (encrypted mode). */
    static hasKey() { return _key !== null; }

    /** The active data key (DEK) for the unlocked session, or null. */
    static getKey() { return _key; }

    /** The raw at-rest blob (ciphertext when encrypted) — this IS the sync payload. */
    static exportBlob() { return localStorage.getItem(STORAGE_KEY); }

    /** Replace the raw at-rest blob (e.g. a restored cloud backup); call reload() after. */
    static importBlob(raw) {
        if (raw == null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, String(raw));
    }

    /** Decrypt the vault into memory with `key`. Throws if the key is wrong. */
    static async unlock(key) {
        _key = key;
        _cache = await this._loadFrom(key);
        return _cache;
    }

    /** Re-derive the in-memory cache from disk using the active key. */
    static async reload() {
        _cache = await this._loadFrom(_key);
        return _cache;
    }

    static async _loadFrom(key) {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return []; }

        if (_looksEncrypted(parsed)) {
            if (!key) return [];                                   // locked — cannot read
            const data = await VaultCrypto.decryptJSON(key, parsed); // throws on wrong key
            return Array.isArray(data) ? data : [];
        }

        // Plaintext on disk. If we hold a key, migrate it to ciphertext in place.
        const arr = Array.isArray(parsed) ? parsed : [];
        if (key) await this._writeEncrypted(arr, key);
        return arr;
    }

    /**
     * Turn on encryption with `key` and (re-)encrypt `investments`. Used at
     * registration, legacy migration, and password change (new key → re-encrypt).
     */
    static async enableEncryption(key, investments) {
        _key = key;
        _cache = Array.isArray(investments) ? investments : [];
        await this._writeEncrypted(_cache, key);
        // A backup encrypted under a prior key is no longer readable — drop it.
        localStorage.removeItem(BACKUP_KEY);
        return _cache;
    }

    /** Forget the key and plaintext cache (logout / tab close). */
    static lock() {
        _cache = null;
        _key = null;
        _persist = Promise.resolve();
    }

    static async _writeEncrypted(investments, key) {
        const blob = await VaultCrypto.encryptJSON(key || _key, investments);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    }

    // ---- reads -------------------------------------------------------------
    static _sanitize(investments) {
        // Coerce numeric values on read so downstream math is never fed strings.
        return investments.map(inv => ({
            ...inv,
            amount: parseFloat(inv.amount) || 0,
            maturity: parseFloat(inv.maturity) || 0,
            interestRate: inv.interestRate != null ? parseFloat(inv.interestRate) : null,
            tenureDays: inv.tenureDays != null ? parseInt(inv.tenureDays, 10) : null,
            goldWeight: inv.goldWeight != null ? parseFloat(inv.goldWeight) : null,
            goldPurchasePrice: inv.goldPurchasePrice != null ? parseFloat(inv.goldPurchasePrice) : null,
            proof: inv.proof || null
        }));
    }

    static getInvestments() {
        if (_cache !== null) return this._sanitize(_cache);
        // Not unlocked into memory — read whatever is on disk (plaintext / legacy).
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (_looksEncrypted(parsed)) return []; // locked: unreadable without a key
            return this._sanitize(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
            console.error('Failed to parse investments', e);
            return [];
        }
    }

    // ---- writes ------------------------------------------------------------
    static saveInvestments(investments) {
        _cache = investments; // in-memory truth updates synchronously
        if (_key) {
            // Encrypt-and-write off the critical path, serialized to avoid races.
            _persist = _persist
                .then(() => this._writeEncrypted(investments, _key))
                .catch(e => console.error('Encrypted save failed', e));
            return _persist;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(investments));
        return Promise.resolve();
    }

    static addInvestment(investment) {
        const investments = this.getInvestments();
        investment.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);

        // Convert string amounts to numbers safely
        investment.amount = parseFloat(investment.amount);
        investment.maturity = parseFloat(investment.maturity);

        investments.push(investment);

        // Sort by date descending
        investments.sort((a, b) => new Date(b.date) - new Date(a.date));

        this.saveInvestments(investments);
        return investment;
    }

    static updateInvestment(updated) {
        const investments = this.getInvestments();
        const idx = investments.findIndex(inv => inv.id === updated.id);
        if (idx === -1) return null;

        updated.amount = parseFloat(updated.amount);
        updated.maturity = parseFloat(updated.maturity);

        // Full replace of the record's fields (the form supplies every field for
        // the chosen type, nulling those that don't apply — e.g. FD → Gold).
        investments[idx] = { ...investments[idx], ...updated };

        // Keep the date-descending order in case the date changed.
        investments.sort((a, b) => new Date(b.date) - new Date(a.date));

        this.saveInvestments(investments);
        return investments[idx];
    }

    static deleteInvestment(id) {
        const investments = this.getInvestments().filter(inv => inv.id !== id);
        this.saveInvestments(investments);
    }

    static getInvestment(id) {
        return this.getInvestments().find(inv => inv.id === id) || null;
    }

    /**
     * Normalize an imported array into trusted investment records.
     * Coerces every field to its expected type, whitelists the asset type,
     * and rejects any `proof` that is not a data:image/* URL — so a hand-crafted
     * backup file cannot smuggle script or unexpected shapes into storage.
     * Returns null if the input is not an array.
     */
    static normalizeImported(arr) {
        if (!Array.isArray(arr)) return null;
        const TYPES = ['Fixed Deposit', 'SIP', 'Gold', 'Stocks', 'Mutual Fund', 'Crypto', 'Real Estate', 'Other'];
        const numOrNull = (v) => (v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : null);
        return arr
            .filter(x => x && typeof x === 'object' && !Array.isArray(x))
            .map(x => ({
                id: typeof x.id === 'string' && x.id ? x.id : Date.now().toString() + Math.random().toString(36).slice(2, 7),
                name: String(x.name == null ? '' : x.name).slice(0, 120),
                type: TYPES.includes(x.type) ? x.type : 'Other',
                amount: Number(x.amount) || 0,
                maturity: Number(x.maturity) || 0,
                date: typeof x.date === 'string' ? x.date : '',
                interestRate: numOrNull(x.interestRate),
                maturityDate: typeof x.maturityDate === 'string' ? x.maturityDate : null,
                tenureDays: x.tenureDays != null ? (parseInt(x.tenureDays, 10) || null) : null,
                sipMonthly: numOrNull(x.sipMonthly),
                sipDuration: numOrNull(x.sipDuration),
                sipRate: numOrNull(x.sipRate),
                goldWeight: numOrNull(x.goldWeight),
                goldPurchasePrice: numOrNull(x.goldPurchasePrice),
                proof: typeof x.proof === 'string' && x.proof.startsWith('data:image/') ? x.proof : null
            }));
    }

    /**
     * Validate an investment record built from the form. Returns an array of
     * human-readable error strings (empty === valid). Pure and DOM-free so it can
     * be unit-tested; it catches the semantic problems the HTML min/required
     * attributes cannot — zero amounts, out-of-range rates, a maturity date on or
     * before the start date, and typo-scale values.
     */
    static validate(inv) {
        const MAX_AMOUNT = 1e12;   // ₹1 trillion — far beyond any individual holding
        const MAX_RATE = 100;      // % p.a.
        const errors = [];
        const amount = Number(inv.amount) || 0;
        const maturity = Number(inv.maturity) || 0;

        if (!String(inv.name || '').trim()) errors.push('Please enter an investment name.');
        if (!inv.date) errors.push('Please choose a start date.');
        if (!(amount > 0)) errors.push('The invested amount must be greater than ₹0.');
        if (maturity < 0) errors.push('The value cannot be negative.');
        if (amount > MAX_AMOUNT || maturity > MAX_AMOUNT) errors.push('That amount looks too large — please double-check it.');

        if (inv.type === 'Fixed Deposit') {
            const r = Number(inv.interestRate);
            if (!(r >= 0 && r <= MAX_RATE)) errors.push('Interest rate must be between 0% and 100%.');
            if (!(Number(inv.tenureDays) > 0)) errors.push('The maturity date must be after the start date.');
        } else if (inv.type === 'SIP') {
            if (!(Number(inv.sipMonthly) > 0)) errors.push('Monthly amount must be greater than ₹0.');
            if (!(Number(inv.sipDuration) >= 1)) errors.push('Duration must be at least 1 month.');
            const r = Number(inv.sipRate);
            if (!(r >= 0 && r <= MAX_RATE)) errors.push('Expected return must be between 0% and 100%.');
        } else if (inv.type === 'Gold') {
            if (!(Number(inv.goldWeight) > 0)) errors.push('Weight must be greater than 0 grams.');
            if (!(Number(inv.goldPurchasePrice) > 0)) errors.push('Purchase price must be greater than ₹0.');
        }
        return errors;
    }

    // ---- backups -----------------------------------------------------------
    /**
     * Best-effort snapshot of the raw stored bytes (ciphertext or plaintext) to a
     * single rolling backup key. Called before destructive actions and on load so
     * an accidental wipe or bad import is recoverable. Never throws.
     */
    static backupNow() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            let count;
            if (_cache !== null) {
                count = _cache.length;
            } else {
                const parsed = JSON.parse(raw);
                count = Array.isArray(parsed) ? parsed.length : null;
            }
            if (count === 0) return false; // don't clobber a good backup with nothing
            localStorage.setItem(BACKUP_KEY, JSON.stringify({
                timestamp: new Date().toISOString(),
                count,
                blob: raw // stored exactly as-is: encrypted stays encrypted
            }));
            return true;
        } catch (e) {
            console.warn('Backup skipped (storage may be full)', e);
            return false;
        }
    }

    /** Return the latest backup metadata, or null. */
    static getBackup() {
        try {
            const b = JSON.parse(localStorage.getItem(BACKUP_KEY));
            if (b && (typeof b.blob === 'string' || Array.isArray(b.data))) return b;
        } catch { }
        return null;
    }

    /** Restore the latest backup over current data, refreshing the cache. */
    static async restoreBackup() {
        const b = this.getBackup();
        if (!b) return null;
        // `blob` is the new format; `data` supports backups written by an earlier version.
        const raw = typeof b.blob === 'string' ? b.blob : JSON.stringify(b.data || []);
        localStorage.setItem(STORAGE_KEY, raw);
        if (_key || _cache !== null) await this.reload(); // re-encrypts if the blob was plaintext
        return b;
    }

    // ---- derived data ------------------------------------------------------
    static getKPIs() {
        const investments = this.getInvestments();
        const now = new Date();

        let totalInvested = 0;
        let totalMaturity = 0;
        investments.forEach(inv => {
            totalInvested += Number(inv.amount) || 0;
            totalMaturity += Number(inv.maturity) || 0;
        });

        // Money-weighted portfolio return (XIRR over every investment's dated
        // cash flows) — correctly accounts for staggered SIP contributions.
        const returnsPercentage = Math.round(Finance.portfolioReturn(investments, now) * 100) / 100;

        return {
            totalInvested,
            totalMaturity,
            returnsPercentage
        };
    }

    static getDiversificationData() {
        const investments = this.getInvestments();
        const typeMap = {};

        investments.forEach(inv => {
            const type = inv.type;
            if (!typeMap[type]) {
                typeMap[type] = 0;
            }
            // Use current/maturity value for diversification weight
            typeMap[type] += inv.maturity;
        });

        return typeMap;
    }
}

// Export for the test runner (Vitest/Node). No-op in the browser, where
// `InvestmentStorage` is already a global from this classic script.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { InvestmentStorage };
}
