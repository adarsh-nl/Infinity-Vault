import { describe, it, expect } from 'vitest';
import Finance from '../finance.js';

describe('xirr — dated cash-flow IRR', () => {
    it('solves a simple one-year 10% return', () => {
        const r = Finance.xirr([
            { amount: -1000, date: '2025-01-01' },
            { amount: 1100, date: '2026-01-01' }, // 365 days (2025 is not a leap year)
        ]);
        expect(r).toBeCloseTo(0.10, 4);
    });

    it('returns null without a sign change', () => {
        expect(Finance.xirr([{ amount: -1000, date: '2025-01-01' }, { amount: -50, date: '2025-06-01' }])).toBeNull();
        expect(Finance.xirr([{ amount: 1000, date: '2025-01-01' }, { amount: 50, date: '2025-06-01' }])).toBeNull();
    });

    it('returns null for fewer than two flows', () => {
        expect(Finance.xirr([{ amount: -1000, date: '2025-01-01' }])).toBeNull();
        expect(Finance.xirr([])).toBeNull();
    });
});

describe('xirrPercent — display helper', () => {
    it('returns 0 when unsolvable', () => {
        expect(Finance.xirrPercent([{ amount: -1, date: '2025-01-01' }])).toBe(0);
    });

    it('clamps an exploding short-period IRR to the display cap', () => {
        // 10x in a week annualizes to an astronomically large rate.
        const p = Finance.xirrPercent([
            { amount: -100, date: '2025-01-01' },
            { amount: 1000, date: '2025-01-08' },
        ]);
        expect(p).toBe(Finance.RETURN_MAX_PCT);
    });
});

describe('investmentReturn — per instrument', () => {
    it('matches CAGR for a lump-sum FD', () => {
        const fd = { type: 'Fixed Deposit', amount: 100000, maturity: 107186, date: '2025-01-01', maturityDate: '2026-01-01' };
        expect(Finance.investmentReturn(fd)).toBeCloseTo(7.19, 1);
    });

    it('is negative for a loss', () => {
        const stock = { type: 'Stocks', amount: 1000, maturity: 900, date: '2025-01-01' };
        expect(Finance.investmentReturn(stock, '2026-01-01')).toBeCloseTo(-10, 1);
    });

    it('correctly values a SIP by contribution timing (the fix)', () => {
        // ₹1,000/mo for 12 months growing at 1%/mo → FV ≈ 12,809, real rate ≈ 12.7% p.a.
        const maturity = Math.round(Finance.calculateSIPMaturity(1000, 12, 12));
        const sip = { type: 'SIP', amount: 12000, maturity, date: '2025-01-01', sipMonthly: 1000, sipDuration: 12 };

        const xirrPct = Finance.investmentReturn(sip);
        const simplePct = Finance.annualizedReturn(12000, maturity, 365);

        // The money-weighted return is ~12.7%, close to the true earned rate.
        expect(xirrPct).toBeGreaterThan(12);
        expect(xirrPct).toBeLessThan(13.3);
        // The old simple method understates it by roughly half (~6.7%).
        expect(simplePct).toBeLessThan(7);
        expect(xirrPct).toBeGreaterThan(simplePct * 1.5);
    });
});

describe('portfolioReturn — combined money-weighted return', () => {
    it('lies between the returns of its holdings', () => {
        const investments = [
            { type: 'Stocks', amount: 1000, maturity: 1100, date: '2025-01-01' },  // 10% over 1yr
            { type: 'Stocks', amount: 1000, maturity: 1050, date: '2025-01-01' },  // 5% over 1yr
        ];
        const p = Finance.portfolioReturn(investments, '2026-01-01');
        expect(p).toBeGreaterThan(5);
        expect(p).toBeLessThan(10);
    });

    it('returns 0 for an empty portfolio', () => {
        expect(Finance.portfolioReturn([], '2026-01-01')).toBe(0);
    });
});
