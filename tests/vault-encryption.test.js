import { beforeEach, describe, it, expect } from 'vitest';
import VaultCrypto from '../crypto.js';
import Finance from '../finance.js';
import { InvestmentStorage } from '../storage.js';

const DATA_KEY = 'infinity_vault_investments';

function makeLocalStorage() {
    const s = {};
    return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null),
        setItem: (k, v) => { s[k] = String(v); },
        removeItem: (k) => { delete s[k]; },
    };
}

async function keyFor(pw) {
    const salt = VaultCrypto.randomBytes(16);
    return VaultCrypto.deriveKey(pw, salt, 50000);
}

beforeEach(() => {
    globalThis.Finance = Finance;
    globalThis.VaultCrypto = VaultCrypto;
    globalThis.localStorage = makeLocalStorage();
    InvestmentStorage.lock();
});

const sample = [{ id: '1', name: 'HDFC FD', type: 'Fixed Deposit', amount: 1000, maturity: 1100, date: '2025-01-01' }];

describe('encrypted-at-rest storage', () => {
    it('writes ciphertext to disk — plaintext is never persisted', async () => {
        const key = await keyFor('pw');
        await InvestmentStorage.enableEncryption(key, sample);
        const raw = globalThis.localStorage.getItem(DATA_KEY);
        expect(raw).not.toContain('HDFC');                 // the name must be unreadable
        expect(VaultCrypto.isEncryptedBlob(JSON.parse(raw))).toBe(true);
    });

    it('unlock with the right key restores the data', async () => {
        const key = await keyFor('pw');
        await InvestmentStorage.enableEncryption(key, sample);
        InvestmentStorage.lock();
        expect(InvestmentStorage.getInvestments()).toHaveLength(0); // locked: unreadable
        await InvestmentStorage.unlock(key);
        expect(InvestmentStorage.getInvestments()[0].name).toBe('HDFC FD');
    });

    it('unlock with a wrong key throws and data stays protected', async () => {
        const key = await keyFor('right');
        await InvestmentStorage.enableEncryption(key, sample);
        InvestmentStorage.lock();
        await expect(InvestmentStorage.unlock(await keyFor('wrong'))).rejects.toBeTruthy();
    });

    it('subsequent saves persist as ciphertext and reload decrypts them', async () => {
        const key = await keyFor('pw');
        await InvestmentStorage.enableEncryption(key, []);
        InvestmentStorage.addInvestment({ name: 'Gold', type: 'Gold', amount: 500, maturity: 600, date: '2025-02-01' });
        await InvestmentStorage.saveInvestments(InvestmentStorage.getInvestments()); // await the async write chain
        expect(VaultCrypto.isEncryptedBlob(JSON.parse(globalThis.localStorage.getItem(DATA_KEY)))).toBe(true);
        await InvestmentStorage.reload();
        expect(InvestmentStorage.getInvestments().some(i => i.name === 'Gold')).toBe(true);
    });

    it('backup + restore round-trips encrypted data', async () => {
        const key = await keyFor('pw');
        await InvestmentStorage.enableEncryption(key, sample);
        expect(InvestmentStorage.backupNow()).toBe(true);
        await InvestmentStorage.saveInvestments([]); // clear
        expect(InvestmentStorage.getInvestments()).toHaveLength(0);
        await InvestmentStorage.restoreBackup();
        expect(InvestmentStorage.getInvestments()[0].name).toBe('HDFC FD');
    });
});
