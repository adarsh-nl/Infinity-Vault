const STORAGE_KEY = 'infinity_vault_investments';

class InvestmentStorage {
    static getInvestments() {
        const data = localStorage.getItem(STORAGE_KEY);
        if (!data) return [];
        try {
            const investments = JSON.parse(data);
            // Sanitize numeric values on read
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
        } catch (e) {
            console.error('Failed to parse investments', e);
            return [];
        }
    }

    static saveInvestments(investments) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(investments));
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

    static deleteInvestment(id) {
        let investments = this.getInvestments();
        investments = investments.filter(inv => inv.id !== id);
        this.saveInvestments(investments);
    }

    static getKPIs() {
        const investments = this.getInvestments();
        const now = new Date();

        let totalInvested = 0;
        let totalMaturity = 0;
        let weightedAnnualReturn = 0;

        investments.forEach(inv => {
            const amt = Number(inv.amount) || 0;
            const mat = Number(inv.maturity) || 0;
            totalInvested += amt;
            totalMaturity += mat;

            // Calculate annualized return for each investment
            if (amt > 0) {
                let days = inv.tenureDays;
                if (!days || days <= 0) {
                    // For non-FD: days elapsed from investment date to today
                    const invDate = inv.date ? new Date(inv.date) : now;
                    days = Math.max(1, Math.round((now - invDate) / (1000 * 60 * 60 * 24)));
                }
                const annualized = ((mat - amt) / amt) * 100 * (365 / days);
                // Weight by invested amount
                weightedAnnualReturn += annualized * amt;
            }
        });

        let returnsPercentage = 0;
        if (totalInvested > 0) {
            // Weighted average annualized return
            returnsPercentage = weightedAnnualReturn / totalInvested;
        }

        // Guard against floating point edge cases
        returnsPercentage = Math.round(returnsPercentage * 100) / 100;

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
