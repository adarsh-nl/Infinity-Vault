import { describe, it, expect } from 'vitest';
import Finance from '../finance.js';

describe('calculateFDMaturity — quarterly compounding', () => {
    it('compounds a 1-year FD quarterly', () => {
        // ₹100,000 @ 7% p.a. for 365 days == 100000 * (1 + 0.07/4)^4
        const m = Finance.calculateFDMaturity(100000, 7, 365);
        expect(m).toBeCloseTo(100000 * Math.pow(1 + 0.0175, 4), 2);
        expect(m).toBeGreaterThan(107000);
        expect(m).toBeLessThan(107300);
    });

    it('returns 0 for non-positive inputs', () => {
        expect(Finance.calculateFDMaturity(0, 7, 365)).toBe(0);
        expect(Finance.calculateFDMaturity(100000, 0, 365)).toBe(0);
        expect(Finance.calculateFDMaturity(100000, 7, 0)).toBe(0);
        expect(Finance.calculateFDMaturity(100000, 7, -5)).toBe(0);
    });
});

describe('calculateSIPMaturity — future value', () => {
    it('matches the closed-form SIP future-value formula', () => {
        const P = 5000, months = 12, annual = 12;
        const r = (annual / 100) / 12;
        const expected = P * (((Math.pow(1 + r, months) - 1) / r) * (1 + r));
        expect(Finance.calculateSIPMaturity(P, annual, months)).toBeCloseTo(expected, 6);
    });

    it('falls back to contributed total at 0% return', () => {
        expect(Finance.calculateSIPMaturity(5000, 0, 12)).toBe(60000);
    });

    it('grows above contributions when the rate is positive', () => {
        expect(Finance.calculateSIPMaturity(5000, 12, 12)).toBeGreaterThan(60000);
    });
});

describe('annualizedReturn', () => {
    it('is 10% for a 10% gain held exactly one year', () => {
        expect(Finance.annualizedReturn(10000, 11000, 365)).toBeCloseTo(10, 6);
    });

    it('annualizes a partial-year holding period', () => {
        // ~5% gain over half a year ≈ 10% p.a.
        expect(Finance.annualizedReturn(10000, 10500, 182.5)).toBeCloseTo(10, 1);
    });

    it('guards divide-by-zero (no invested amount or zero days)', () => {
        expect(Finance.annualizedReturn(0, 100, 365)).toBe(0);
        expect(Finance.annualizedReturn(10000, 11000, 0)).toBe(0);
    });

    it('returns negative for a loss', () => {
        expect(Finance.annualizedReturn(10000, 9000, 365)).toBeCloseTo(-10, 6);
    });
});

describe('daysBetween', () => {
    it('counts whole calendar days', () => {
        expect(Finance.daysBetween('2025-01-01', '2025-01-31')).toBe(30);
    });

    it('returns 0 for unparseable dates', () => {
        expect(Finance.daysBetween('not-a-date', '2025-01-31')).toBe(0);
    });
});
