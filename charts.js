// charts.js
class DashboardCharts {
    constructor() {
        this.diversificationChart = null;
        this.projectionChart = null;
        this.returnsChart = null;
        this.typePerformanceChart = null;
        this.timelineChart = null;
    }

    initCharts() {
        this.renderDiversificationChart();
        this.renderProjectionChart();
        this.renderReturnsChart();
        this.renderTypePerformanceChart();
        this.renderTimelineChart();
    }

    updateCharts() {
        this.initCharts();
    }

    getThemeColors() {
        const isDark = document.body.classList.contains('dark-theme');
        return {
            text: isDark ? '#94a3b8' : '#64748b',
            textBright: isDark ? '#f8fafc' : '#1e293b',
            grid: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
        };
    }

    formatINR(value) {
        return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
    }

    tickINR(value) {
        if (value >= 10000000) return '₹' + (value / 10000000).toFixed(1) + 'Cr';
        if (value >= 100000) return '₹' + (value / 100000).toFixed(1) + 'L';
        if (value >= 1000) return '₹' + (value / 1000).toFixed(1) + 'k';
        return '₹' + value;
    }

    // ---- Chart 1: Diversification Donut ----
    renderDiversificationChart() {
        const ctx = document.getElementById('diversificationChart');
        if (!ctx) return;

        const data = InvestmentStorage.getDiversificationData();
        const labels = Object.keys(data);
        const values = Object.values(data);
        const { textBright } = this.getThemeColors();
        const palette = ['#818cf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#f472b6', '#fb923c'];

        if (this.diversificationChart) this.diversificationChart.destroy();
        this.diversificationChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels.length ? labels : ['No Data'],
                datasets: [{
                    data: values.length ? values : [1],
                    backgroundColor: values.length ? palette.slice(0, labels.length) : ['#334155'],
                    borderWidth: 0, hoverOffset: 4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, cutout: '70%',
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { color: textBright, font: { family: "'Inter', sans-serif" }, usePointStyle: true, padding: 20 }
                    },
                    tooltip: { callbacks: { label: (c) => !values.length ? ' No Investments' : `${c.label}: ${this.formatINR(c.parsed)}` } }
                }
            }
        });
    }

    // ---- Chart 2: Projected Growth Bar ----
    renderProjectionChart() {
        const ctx = document.getElementById('projectionChart');
        if (!ctx) return;
        const kpis = InvestmentStorage.getKPIs();
        const { text, grid } = this.getThemeColors();

        if (this.projectionChart) this.projectionChart.destroy();
        this.projectionChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['Total Invested', 'Maturity / Current'],
                datasets: [{
                    label: 'Amount (₹)',
                    data: [kpis.totalInvested || 0, kpis.totalMaturity || 0],
                    backgroundColor: ['#818cf8', '#34d399'],
                    borderRadius: 8, barPercentage: 0.6
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Amount: ${this.formatINR(c.parsed.y)}` } } },
                scales: {
                    y: { beginAtZero: true, grid: { color: grid }, ticks: { color: text, callback: (v) => this.tickINR(v) } },
                    x: { grid: { display: false }, ticks: { color: text, font: { weight: '500' } } }
                }
            }
        });
    }

    // ---- Chart 3: Returns by Investment (Horizontal Bar) ----
    renderReturnsChart() {
        const ctx = document.getElementById('returnsChart');
        if (!ctx) return;

        const investments = InvestmentStorage.getInvestments();
        const now = new Date();
        const labels = [];
        const data = [];
        const colors = [];

        investments.forEach(inv => {
            const amt = Number(inv.amount) || 0;
            if (amt <= 0) return;
            const ret = Finance.investmentReturn(inv, now); // money-weighted (XIRR)
            labels.push(inv.name.length > 20 ? inv.name.slice(0, 18) + '…' : inv.name);
            data.push(Math.round(ret * 100) / 100);
            colors.push(ret >= 0 ? '#34d399' : '#f87171');
        });

        const { text, grid } = this.getThemeColors();
        const barHeight = Math.max(200, labels.length * 36);
        ctx.parentElement.style.height = barHeight + 'px';

        if (this.returnsChart) this.returnsChart.destroy();
        if (labels.length === 0) {
            ctx.parentElement.style.height = '200px';
            return;
        }

        this.returnsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{ label: 'Return % (p.a.)', data, backgroundColor: colors, borderRadius: 6, barPercentage: 0.7 }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.x}% p.a.` } } },
                scales: {
                    x: { grid: { color: grid }, ticks: { color: text, callback: (v) => v + '%' } },
                    y: { grid: { display: false }, ticks: { color: text, font: { size: 12 } } }
                }
            }
        });
    }

    // ---- Chart 4: Type-Wise Performance (Grouped Bar) ----
    renderTypePerformanceChart() {
        const ctx = document.getElementById('typePerformanceChart');
        if (!ctx) return;

        const investments = InvestmentStorage.getInvestments();
        const typeMap = {};
        investments.forEach(inv => {
            if (!typeMap[inv.type]) typeMap[inv.type] = { invested: 0, maturity: 0 };
            typeMap[inv.type].invested += Number(inv.amount) || 0;
            typeMap[inv.type].maturity += Number(inv.maturity) || 0;
        });

        const labels = Object.keys(typeMap);
        const invested = labels.map(t => typeMap[t].invested);
        const maturity = labels.map(t => typeMap[t].maturity);
        const { text, grid } = this.getThemeColors();

        if (this.typePerformanceChart) this.typePerformanceChart.destroy();
        if (labels.length === 0) return;

        this.typePerformanceChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { label: 'Invested', data: invested, backgroundColor: '#818cf8', borderRadius: 6, barPercentage: 0.7 },
                    { label: 'Maturity', data: maturity, backgroundColor: '#34d399', borderRadius: 6, barPercentage: 0.7 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: text, font: { family: "'Inter', sans-serif" }, usePointStyle: true, padding: 16 } },
                    tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${this.formatINR(c.parsed.y)}` } }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: grid }, ticks: { color: text, callback: (v) => this.tickINR(v) } },
                    x: { grid: { display: false }, ticks: { color: text } }
                }
            }
        });
    }

    // ---- Chart 5: Monthly Investment Timeline (Line) ----
    renderTimelineChart() {
        const ctx = document.getElementById('timelineChart');
        if (!ctx) return;

        const investments = InvestmentStorage.getInvestments();
        if (investments.length === 0) {
            if (this.timelineChart) this.timelineChart.destroy();
            return;
        }

        // Group by month and cumulate
        const monthMap = {};
        investments.forEach(inv => {
            if (!inv.date) return;
            const key = inv.date.slice(0, 7); // YYYY-MM
            monthMap[key] = (monthMap[key] || 0) + (Number(inv.amount) || 0);
        });

        const sortedMonths = Object.keys(monthMap).sort();
        let cumulative = 0;
        const cumulativeData = sortedMonths.map(m => {
            cumulative += monthMap[m];
            return cumulative;
        });

        const labels = sortedMonths.map(m => {
            const [y, mo] = m.split('-');
            return new Date(y, mo - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        });

        const { text, grid } = this.getThemeColors();

        if (this.timelineChart) this.timelineChart.destroy();
        this.timelineChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Cumulative Invested',
                    data: cumulativeData,
                    borderColor: '#818cf8',
                    backgroundColor: 'rgba(129,140,248,0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: '#818cf8',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    borderWidth: 3
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (c) => `Total: ${this.formatINR(c.parsed.y)}` } }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: grid }, ticks: { color: text, callback: (v) => this.tickINR(v) } },
                    x: { grid: { display: false }, ticks: { color: text, maxRotation: 45, minRotation: 0 } }
                }
            }
        });
    }
}
