import { beforeEach, describe, it, expect } from 'vitest';
import Finance from '../finance.js';
import { InvestmentStorage } from '../storage.js';

// storage.js reads two browser globals at call time: `Finance` and `localStorage`.
// Provide an in-memory localStorage and the real Finance module for each test.
function makeLocalStorage() {
    const s = {};
    return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null),
        setItem: (k, v) => { s[k] = String(v); },
        removeItem: (k) => { delete s[k]; },
    };
}

beforeEach(() => {
    globalThis.Finance = Finance;
    globalThis.localStorage = makeLocalStorage();
    InvestmentStorage.lock(); // reset module-scoped cache/key between tests
});

describe('normalizeImported — untrusted backup hardening', () => {
    it('rejects a non-array payload', () => {
        expect(InvestmentStorage.normalizeImported('nope')).toBeNull();
    });

    it('drops non-object rows and coerces numeric fields', () => {
        const r = InvestmentStorage.normalizeImported([
            { name: 'A', type: 'Gold', amount: '100', maturity: '120' }, 'junk', null, 3,
        ]);
        expect(r).toHaveLength(1);
        expect(r[0].amount).toBe(100);
        expect(typeof r[0].amount).toBe('number');
    });

    it('whitelists the asset type and rejects non-image proof', () => {
        const r = InvestmentStorage.normalizeImported([
            { name: 'x', type: 'Evil', proof: 'javascript:alert(1)' },
            { name: 'y', type: 'Gold', proof: 'data:image/png;base64,AAAA' },
        ]);
        expect(r[0].type).toBe('Other');
        expect(r[0].proof).toBeNull();
        expect(r[1].proof).toBe('data:image/png;base64,AAAA');
    });
});

describe('backup / restore', () => {
    it('round-trips through an accidental clear', async () => {
        InvestmentStorage.saveInvestments([
            { id: '1', name: 'FD', type: 'Fixed Deposit', amount: 1000, maturity: 1100, date: '2025-01-01' },
        ]);
        expect(InvestmentStorage.backupNow()).toBe(true);
        InvestmentStorage.saveInvestments([]); // simulate a mistaken "Clear All"
        expect(InvestmentStorage.getInvestments()).toHaveLength(0);

        const restored = await InvestmentStorage.restoreBackup();
        expect(restored.count).toBe(1);
        expect(InvestmentStorage.getInvestments()).toHaveLength(1);
        expect(InvestmentStorage.getInvestments()[0].amount).toBe(1000);
    });

    it('never overwrites a good backup with empty data', () => {
        InvestmentStorage.saveInvestments([
            { id: '1', name: 'FD', type: 'Fixed Deposit', amount: 1000, maturity: 1100 },
        ]);
        InvestmentStorage.backupNow();
        InvestmentStorage.saveInvestments([]);
        expect(InvestmentStorage.backupNow()).toBe(false);
        expect(InvestmentStorage.getBackup().count).toBe(1);
    });
});

describe('updateInvestment', () => {
    it('edits an existing record in place, preserving its id', () => {
        const created = InvestmentStorage.addInvestment({ name: 'Old', type: 'Stocks', amount: 1000, maturity: 1100, date: '2025-01-01' });
        InvestmentStorage.updateInvestment({ id: created.id, name: 'New', type: 'Stocks', amount: 2000, maturity: 2500, date: '2025-01-01' });

        const all = InvestmentStorage.getInvestments();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(created.id);
        expect(all[0].name).toBe('New');
        expect(all[0].amount).toBe(2000);
        expect(all[0].maturity).toBe(2500);
    });

    it('nulls fields that do not apply after a type change (FD → Gold)', () => {
        const fd = InvestmentStorage.addInvestment({ name: 'FD', type: 'Fixed Deposit', amount: 1000, maturity: 1100, date: '2025-01-01', interestRate: 7, tenureDays: 365 });
        InvestmentStorage.updateInvestment({ id: fd.id, name: 'Coin', type: 'Gold', amount: 500, maturity: 600, date: '2025-01-01', interestRate: null, tenureDays: null, goldWeight: 1 });

        const inv = InvestmentStorage.getInvestment(fd.id);
        expect(inv.type).toBe('Gold');
        expect(inv.interestRate).toBeNull();
        expect(inv.goldWeight).toBe(1);
    });

    it('returns null for an unknown id and leaves data untouched', () => {
        InvestmentStorage.addInvestment({ name: 'A', type: 'Stocks', amount: 1, maturity: 2, date: '2025-01-01' });
        expect(InvestmentStorage.updateInvestment({ id: 'nope', name: 'X' })).toBeNull();
        expect(InvestmentStorage.getInvestments()).toHaveLength(1);
    });
});

describe('getKPIs', () => {
    it('aggregates totals and weighted annualized return', () => {
        InvestmentStorage.saveInvestments([
            { id: '1', name: 'FD', type: 'Fixed Deposit', amount: 10000, maturity: 11000, tenureDays: 365, date: '2025-01-01' },
        ]);
        const k = InvestmentStorage.getKPIs();
        expect(k.totalInvested).toBe(10000);
        expect(k.totalMaturity).toBe(11000);
        expect(k.returnsPercentage).toBeCloseTo(10, 2);
    });
});
