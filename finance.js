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
     * Simple (non-compounded) annualized return (% p.a.).
     *   ((maturity − invested) / invested) × 100 × (365 / days)
     *
     * Retained as a lightweight reference metric. The app now DISPLAYS money-
     * weighted XIRR everywhere (see investmentReturn / portfolioReturn) because
     * this simple form treats the whole corpus as invested on day 0 — which
     * UNDERSTATES any staggered-contribution instrument (e.g. SIPs), where most
     * of the money is deployed for less than the full period.
     */
    function annualizedReturn(invested, maturity, days) {
        const amt = Number(invested) || 0;
        const mat = Number(maturity) || 0;
        const d = Number(days) || 0;
        if (amt <= 0 || d <= 0) return 0;
        return ((mat - amt) / amt) * 100 * (365 / d);
    }

    // ---- XIRR: money-weighted, cash-flow-dated annualized return -----------
    const YEAR_MS = 365 * MS_PER_DAY;
    // IRR over a very short, high-gain holding period explodes toward infinity
    // once compounded/annualized. Clamp the DISPLAYED percentage to a readable
    // band; the underlying rate is still mathematically exact.
    const RETURN_MIN_PCT = -99.99;
    const RETURN_MAX_PCT = 9999.99;

    function _addDays(date, days) {
        return new Date(date.getTime() + days * MS_PER_DAY);
    }
    function _addMonths(date, months) {
        const d = new Date(date.getTime());
        d.setMonth(d.getMonth() + months);
        return d;
    }

    /**
     * XIRR — the annualized rate r that makes the net present value of a set of
     * dated cash flows zero. Convention: amount < 0 = money out (invested),
     * amount > 0 = money in (returned / current value).
     *
     * @param {Array<{amount:number, date:(string|number|Date)}>} rawFlows
     * @returns {number|null} rate as a fraction (0.12 = 12% p.a.), or null if
     *   it cannot be solved (fewer than two flows, or no sign change).
     *
     * Solved by bisection on [-0.999999, 100000]: for a normal investment NPV is
     * strictly decreasing in r (→+∞ as r→-1, <0 as r→∞), so the bracket always
     * contains exactly one root. Bisection is chosen over Newton for robustness.
     */
    function xirr(rawFlows) {
        if (!Array.isArray(rawFlows)) return null;
        const flows = rawFlows
            .map(f => ({ amount: Number(f.amount), t: new Date(f.date).getTime() }))
            .filter(f => isFinite(f.amount) && isFinite(f.t) && f.amount !== 0);
        if (flows.length < 2) return null;
        if (!flows.some(f => f.amount > 0) || !flows.some(f => f.amount < 0)) return null;

        const t0 = flows.reduce((min, f) => Math.min(min, f.t), Infinity);
        const npv = (rate) => flows.reduce(
            (sum, f) => sum + f.amount / Math.pow(1 + rate, (f.t - t0) / YEAR_MS), 0
        );

        let lo = -0.999999, hi = 100000;
        let flo = npv(lo);
        const fhi = npv(hi);
        if (!isFinite(flo) || !isFinite(fhi)) return null;
        if (flo === 0) return lo;
        if (fhi === 0) return hi;
        if ((flo < 0) === (fhi < 0)) {
            // No crossing inside the bracket. NPV is monotonically decreasing for
            // these single-sign-change flows, so both-positive means the true IRR
            // exceeds `hi` (an astronomically short high-gain period) and both-
            // negative means it is below `lo`. Return the reached bound; the
            // display layer (xirrPercent) clamps it to a readable cap.
            return flo > 0 ? hi : lo;
        }

        for (let i = 0; i < 128; i++) {
            const mid = (lo + hi) / 2;
            const fmid = npv(mid);
            if (fmid === 0) return mid;
            if ((flo < 0) === (fmid < 0)) { lo = mid; flo = fmid; }
            else { hi = mid; }
        }
        return (lo + hi) / 2;
    }

    /** XIRR as a clamped display percentage; 0 when it cannot be solved. */
    function xirrPercent(flows) {
        const r = xirr(flows);
        if (r == null || !isFinite(r)) return 0;
        return Math.max(RETURN_MIN_PCT, Math.min(RETURN_MAX_PCT, r * 100));
    }

    /**
     * Build the dated cash-flow series for a single investment as of `asOf`
     * (defaults to now). SIPs expand into one outflow per monthly contribution
     * plus the maturity inflow; lump-sum instruments are one outflow at purchase
     * and one inflow at maturity (FD) or valued today (everything else).
     */
    function investmentCashflows(inv, asOf) {
        asOf = asOf ? new Date(asOf) : new Date();
        const amount = Number(inv.amount) || 0;
        const maturity = Number(inv.maturity) || 0;
        const start = inv.date ? new Date(inv.date) : asOf;
        if (isNaN(start.getTime())) return [];

        if (inv.type === 'SIP' && inv.sipMonthly && inv.sipDuration) {
            const monthly = Number(inv.sipMonthly) || 0;
            const n = parseInt(inv.sipDuration, 10) || 0;
            const flows = [];
            for (let i = 0; i < n; i++) flows.push({ amount: -monthly, date: _addMonths(start, i) });
            flows.push({ amount: maturity, date: _addMonths(start, n) });
            return flows;
        }

        let terminal;
        if (inv.type === 'Fixed Deposit') {
            terminal = inv.maturityDate ? new Date(inv.maturityDate)
                : (inv.tenureDays ? _addDays(start, Number(inv.tenureDays)) : asOf);
        } else {
            terminal = asOf; // current value is valued as of today
        }
        if (isNaN(terminal.getTime()) || terminal <= start) {
            terminal = _addDays(start, Math.max(1, Number(inv.tenureDays) || 1));
        }
        return [{ amount: -amount, date: start }, { amount: maturity, date: terminal }];
    }

    /** Per-investment money-weighted return (% p.a.), clamped for display. */
    function investmentReturn(inv, asOf) {
        return xirrPercent(investmentCashflows(inv, asOf));
    }

    /** True portfolio return: XIRR over every investment's combined cash flows. */
    function portfolioReturn(investments, asOf) {
        if (!Array.isArray(investments) || investments.length === 0) return 0;
        const all = [];
        for (const inv of investments) {
            for (const f of investmentCashflows(inv, asOf)) all.push(f);
        }
        return xirrPercent(all);
    }

    return {
        daysBetween, calculateFDMaturity, calculateSIPMaturity, annualizedReturn,
        xirr, xirrPercent, investmentCashflows, investmentReturn, portfolioReturn,
        RETURN_MIN_PCT, RETURN_MAX_PCT,
    };
});
