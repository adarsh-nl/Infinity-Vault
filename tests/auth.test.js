import { beforeEach, describe, it, expect } from 'vitest';
import VaultCrypto from '../crypto.js';
import Finance from '../finance.js';
import { InvestmentStorage } from '../storage.js';
import { AuthManager } from '../auth.js';

function memStore() {
    const s = {};
    return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null),
        setItem: (k, v) => { s[k] = String(v); },
        removeItem: (k) => { delete s[k]; },
    };
}

beforeEach(() => {
    globalThis.Finance = Finance;
    globalThis.VaultCrypto = VaultCrypto;
    globalThis.InvestmentStorage = InvestmentStorage;
    globalThis.localStorage = memStore();
    globalThis.sessionStorage = memStore();
    InvestmentStorage.lock();
});

const seed = async () => {
    InvestmentStorage.addInvestment({ name: 'FD', type: 'Fixed Deposit', amount: 1000, maturity: 1100, date: '2025-01-01' });
    await InvestmentStorage.saveInvestments(InvestmentStorage.getInvestments()); // flush the encrypted write
};
const authRecord = () => JSON.parse(globalThis.localStorage.getItem('infinity_vault_auth'));

describe('register / login (v3 envelope)', () => {
    it('registers, returns a recovery key, and encrypts data at rest', async () => {
        const rk = await AuthManager.register('alice', 'pw123456');
        expect(typeof rk).toBe('string');
        expect(VaultCrypto.normalizeRecoveryKey(rk)).toMatch(/^[0-9A-F]{40}$/);
        expect(authRecord().v).toBe(3);
        expect(authRecord().wrappedDEK).toBeTruthy();
        expect(authRecord().recovery).toBeTruthy();
    });

    it('accepts the correct password and rejects the wrong one', async () => {
        await AuthManager.register('bob', 'right-pw');
        await seed();
        InvestmentStorage.lock();
        expect(await AuthManager.login('bob', 'wrong')).toBe(false);
        expect(await AuthManager.login('bob', 'right-pw')).toBe(true);
        expect(InvestmentStorage.getInvestments().some(i => i.name === 'FD')).toBe(true);
    });
});

describe('changePassword', () => {
    it('re-wraps the DEK: old fails, new works, data + recovery key intact', async () => {
        const rk = await AuthManager.register('carol', 'old-pw');
        await seed();
        expect(await AuthManager.changePassword('WRONG', 'new-pw')).toBe(false);
        expect(await AuthManager.changePassword('old-pw', 'new-pw')).toBe(true);

        InvestmentStorage.lock();
        expect(await AuthManager.login('carol', 'old-pw')).toBe(false);
        expect(await AuthManager.login('carol', 'new-pw')).toBe(true);
        expect(InvestmentStorage.getInvestments().length).toBe(1);

        // The recovery key is unaffected by a password change.
        InvestmentStorage.lock();
        expect(await AuthManager.resetWithRecoveryKey(rk, 'reset-pw')).toBe(true);
    });
});

describe('resetWithRecoveryKey', () => {
    it('recovers a forgotten password with the recovery key', async () => {
        const rk = await AuthManager.register('dave', 'forgotten');
        await seed();
        InvestmentStorage.lock();

        const wrongRk = VaultCrypto.generateRecoveryKey();
        expect(await AuthManager.resetWithRecoveryKey(wrongRk, 'x')).toBe(false);
        expect(await AuthManager.resetWithRecoveryKey(rk, 'brand-new')).toBe(true);
        expect(InvestmentStorage.getInvestments().length).toBe(1);

        InvestmentStorage.lock();
        expect(await AuthManager.login('dave', 'brand-new')).toBe(true);
    });
});

describe('setupRecoveryKey (for migrated users)', () => {
    it('creates a working recovery key for an unlocked session', async () => {
        await AuthManager.register('erin', 'pw');
        // Simulate a migrated account with no recovery envelope yet.
        const a = authRecord(); a.recovery = null; globalThis.localStorage.setItem('infinity_vault_auth', JSON.stringify(a));
        await seed();

        const rk = await AuthManager.setupRecoveryKey();
        expect(typeof rk).toBe('string');
        InvestmentStorage.lock();
        expect(await AuthManager.resetWithRecoveryKey(rk, 'after-setup')).toBe(true);
    });
});

describe('migration v2 → v3', () => {
    it('upgrades a legacy single-key account on login, losslessly', async () => {
        const salt = VaultCrypto.randomBytes(16);
        const iterations = 50000;
        const key = await VaultCrypto.deriveKey('legacy-pw', salt, iterations);
        const verifier = await VaultCrypto.encryptJSON(key, { check: 'infinity-vault' });
        globalThis.localStorage.setItem('infinity_vault_auth', JSON.stringify({
            v: 2, username: 'evan', kdf: 'PBKDF2', iterations, salt: VaultCrypto.bytesToB64(salt), verifier
        }));
        await InvestmentStorage.enableEncryption(key, [{ id: 'x', name: 'Legacy', type: 'Gold', amount: 5000, maturity: 6000, date: '2024-01-01' }]);
        InvestmentStorage.lock();

        expect(await AuthManager.login('evan', 'legacy-pw')).toBe(true);
        expect(authRecord().v).toBe(3);
        expect(InvestmentStorage.getInvestments()[0].name).toBe('Legacy');
    });
});
