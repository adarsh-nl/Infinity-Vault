// finance.js — pure financial math for Infinity Vault.
//
// Framework-free and side-effect-free. Loads two ways with no build step:
//   • Browser: `<script src="finance.js">` exposes a global `Finance` object.
//   • Tests/CI (Node + Vitest): `import { calculateFDMaturity } from './finance.js'`.
//
// Keep this file PURE — no DOM, no storage, no I/O — so it stays trivially
// testable. It is the one place financial formulas live; everything else calls in.
(function (root, factory) {
    const api = factory();
    root.Finance = api;                                   // browser global
    if (typeof module !== 'undefined' && module.exports) { // CommonJS (Vitest, CI)
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const MS_PER_DAY = 86400000;

    /** Whole days between two dates (accepts Date or date-string). */
    function daysBetween(start, end) {
        const s = new Date(start).getTime();
        const e = new Date(end).getTime();
        if (isNaN(s) || isNaN(e)) return 0;
        return Math.round((e - s) / MS_PER_DAY);
    }

    /**
     * Fixed Deposit maturity with quarterly compounding.
     *   M = P × (1 + r/4)^(4 × days/365)
     * Returns 0 for any non-positive input (matches the original UI contract).
     */
    function calculateFDMaturity(principal, annualRatePct, days) {
        if (!principal || !annualRatePct || !days || days <= 0) return 0;
        return principal * Math.pow(1 + (annualRatePct / 100) / 4, 4 * days / 365);
    }

    /**
     * SIP (monthly investment) future value.
     *   FV = P × [((1 + r)^n − 1) / r] × (1 + r),  r = monthly rate, n = months
     * Falls back to the plain contributed total when there is no growth rate.
     */
    function calculateSIPMaturity(monthly, annualRatePct, months) {
        if (!monthly || !months || months <= 0) return monthly * months;
        const r = (annualRatePct / 100) / 12;
        if (r === 0) return monthly * months;
        return monthly * (((Math.pow(1 + r, months) - 1) / r) * (1 + r));
    }

    /**
     * Simple annualized return (% p.a.), normalizing gain over the holding period.
     *   ((maturity − invested) / invested) × 100 × (365 / days)
     *
     * NOTE: this treats the full corpus as invested on day 0. That is correct for
     * lump-sum instruments (FD, one-off buys) but OVERSTATES SIPs, where money is
     * contributed monthly. Replacing this with XIRR is tracked as the next slice
     * (P1.2); it is extracted here unchanged so the refactor stays behavior-preserving.
     */
    function annualizedReturn(invested, maturity, days) {
        const amt = Number(invested) || 0;
        const mat = Number(maturity) || 0;
        const d = Number(days) || 0;
        if (amt <= 0 || d <= 0) return 0;
        return ((mat - amt) / amt) * 100 * (365 / d);
    }

    return { daysBetween, calculateFDMaturity, calculateSIPMaturity, annualizedReturn };
});
