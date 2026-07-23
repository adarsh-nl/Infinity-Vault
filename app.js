// app.js
document.addEventListener('DOMContentLoaded', () => {
    // ===================== UTILITIES =====================
    const formatCurrency = (amount) => {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency', currency: 'INR', maximumFractionDigits: 0
        }).format(amount);
    };

    const formatDate = (dateString) => {
        if (!dateString) return '—';
        return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(dateString));
    };

    // Escape user-controlled strings before they enter innerHTML. Investment
    // names (and imported JSON) are attacker-influenced, so anything rendered
    // via template strings must pass through here to prevent stored XSS.
    const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    // Financial formulas live in finance.js (loaded before this script) so they
    // can be unit-tested in isolation. Alias them for readability below.
    const { calculateFDMaturity, calculateSIPMaturity, investmentReturn, daysBetween } = Finance;

    // Promise-based confirmation dialog — replaces blocking window.confirm() with
    // the app's own modal. Resolves true on confirm, false on cancel/Escape/overlay.
    const confirmDialog = ({ title, message, confirmText = 'Confirm', danger = false }) => {
        const overlay = document.getElementById('confirm-modal');
        const dialog = overlay.querySelector('.confirm-dialog');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        okBtn.textContent = confirmText;
        okBtn.className = danger ? 'btn-danger' : 'btn-primary';
        dialog.classList.toggle('danger', !!danger);

        return new Promise((resolve) => {
            const returnFocus = document.activeElement;
            const detachTrap = attachFocusTrap(overlay);
            const finish = (value) => {
                overlay.classList.add('hidden');
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onOverlay);
                document.removeEventListener('keydown', onKey);
                detachTrap();
                if (returnFocus && returnFocus.focus) returnFocus.focus();
                resolve(value);
            };
            const onOk = () => finish(true);
            const onCancel = () => finish(false);
            const onOverlay = (e) => { if (e.target === overlay) finish(false); };
            const onKey = (e) => { if (e.key === 'Escape') finish(false); };
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            overlay.addEventListener('click', onOverlay);
            document.addEventListener('keydown', onKey);
            overlay.classList.remove('hidden');
            okBtn.focus(); // Enter/Space then activates the action; Escape cancels
        });
    };

    // Inline validation feedback inside the investment modal.
    const showModalError = (msg) => {
        const el = document.getElementById('modal-error');
        el.textContent = msg;
        el.classList.remove('hidden');
    };
    const clearModalError = () => document.getElementById('modal-error').classList.add('hidden');

    // --- Modal focus management: keep Tab inside an open dialog ---
    const getFocusable = (container) =>
        [...container.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
            .filter(el => el.offsetParent !== null); // visible only

    const attachFocusTrap = (modalEl) => {
        const handler = (e) => {
            if (e.key !== 'Tab') return;
            const f = getFocusable(modalEl);
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        modalEl.addEventListener('keydown', handler);
        return () => modalEl.removeEventListener('keydown', handler);
    };

    // ===================== GOLD PRICE MANAGER =====================
    const GOLD_CACHE_KEY = 'infinity_vault_gold_cache';
    let liveGoldPricePerGram = null;

    const getCachedGoldPrice = () => {
        try {
            const cached = JSON.parse(localStorage.getItem(GOLD_CACHE_KEY));
            if (cached && cached.pricePerGram) return cached;
        } catch { }
        return null;
    };

    const cacheGoldPrice = (pricePerGram) => {
        localStorage.setItem(GOLD_CACHE_KEY, JSON.stringify({
            pricePerGram,
            timestamp: new Date().toISOString()
        }));
    };

    const updateGoldBanner = (pricePerGram, timestamp) => {
        const banner = document.getElementById('gold-price-banner');
        const priceEl = document.getElementById('gold-price-value');
        const updatedEl = document.getElementById('gold-last-updated');

        // Show banner if there are any gold investments OR we have a price
        const investments = InvestmentStorage.getInvestments();
        const hasGold = investments.some(inv => inv.type === 'Gold');

        if (pricePerGram && hasGold) {
            banner.classList.remove('hidden');
            priceEl.textContent = `₹${Math.round(pricePerGram).toLocaleString('en-IN')}/gram`;
            if (timestamp) {
                const t = new Date(timestamp);
                updatedEl.textContent = `Updated: ${t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
            }
        } else if (!hasGold) {
            banner.classList.add('hidden');
        }
    };

    const updateGoldInvestments = (pricePerGram) => {
        if (!pricePerGram) return;
        const investments = InvestmentStorage.getInvestments();
        let changed = false;
        investments.forEach(inv => {
            if (inv.type === 'Gold' && inv.goldWeight) {
                const newMaturity = Math.round(inv.goldWeight * pricePerGram);
                if (inv.maturity !== newMaturity) {
                    inv.maturity = newMaturity;
                    changed = true;
                }
            }
        });
        if (changed) {
            InvestmentStorage.saveInvestments(investments);
        }
    };

    const fetchGoldPrice = async () => {
        // Live spot gold from gold-api.com (free, no key, returns USD per troy oz).
        // Replaces api.metals.live, which is no longer reachable.
        try {
            const res = await fetch('https://api.gold-api.com/price/XAU');
            if (res.ok) {
                const data = await res.json();
                // { price: <USD per troy ounce>, symbol: "XAU", ... }
                const usdPerOz = data && typeof data.price === 'number' ? data.price : null;
                if (usdPerOz && usdPerOz > 0) {
                    // Convert: 1 troy oz = 31.1035g. Get a live USD→INR rate, fallback to 83.5.
                    let usdToInr = 83.5;
                    try {
                        const fxRes = await fetch('https://open.er-api.com/v6/latest/USD');
                        if (fxRes.ok) {
                            const fxData = await fxRes.json();
                            if (fxData.rates && fxData.rates.INR) usdToInr = fxData.rates.INR;
                        }
                    } catch { }
                    const pricePerGram = (usdPerOz / 31.1035) * usdToInr;
                    liveGoldPricePerGram = pricePerGram;
                    cacheGoldPrice(pricePerGram);
                    updateGoldBanner(pricePerGram, new Date().toISOString());
                    updateGoldInvestments(pricePerGram);
                    return pricePerGram;
                }
            }
        } catch (e) {
            console.warn('Gold fetch failed, using cache', e);
        }

        // Fallback to cache
        const cached = getCachedGoldPrice();
        if (cached) {
            liveGoldPricePerGram = cached.pricePerGram;
            updateGoldBanner(cached.pricePerGram, cached.timestamp);
            updateGoldInvestments(cached.pricePerGram);
            return cached.pricePerGram;
        }
        return null;
    };

    // ===================== AUTH FLOW =====================
    const authScreen = document.getElementById('auth-screen');
    const dashboardEl = document.getElementById('dashboard');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const loginError = document.getElementById('login-error');
    const registerError = document.getElementById('register-error');
    const logoutBtn = document.getElementById('logout-btn');
    const greetingText = document.getElementById('greeting-text');

    const showDashboard = () => {
        authScreen.classList.add('hidden');
        dashboardEl.classList.remove('hidden');
        const username = AuthManager.getUsername();
        if (username) greetingText.textContent = `Welcome back, ${username}. Track your wealth growth securely.`;
        InvestmentStorage.backupNow(); // snapshot last-good state at the start of the session
        updateDashboard();
        fetchGoldPrice().then(() => updateDashboard()); // refresh after gold update
    };

    const showAuth = () => {
        authScreen.classList.remove('hidden');
        dashboardEl.classList.add('hidden');
        if (AuthManager.isRegistered()) {
            loginForm.classList.remove('hidden');
            registerForm.classList.add('hidden');
        } else {
            loginForm.classList.add('hidden');
            registerForm.classList.remove('hidden');
        }
    };

    // Restore the session on load. With encryption on, the derived key is
    // re-imported from sessionStorage and the vault decrypted before we render.
    (async () => {
        if (AuthManager.isLoggedIn() && await AuthManager.resume()) {
            showDashboard();
        } else {
            AuthManager.logout(); // clear a stale flag we can't honor (e.g. no key)
            showAuth();
        }
    })();

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.classList.add('hidden');
        const ok = await AuthManager.login(document.getElementById('login-username').value, document.getElementById('login-password').value);
        if (ok) showDashboard(); else loginError.classList.remove('hidden');
    });

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        registerError.classList.add('hidden');
        const pw = document.getElementById('register-password').value;
        const cf = document.getElementById('register-confirm').value;
        if (pw.length < 4) { registerError.textContent = 'Password must be at least 4 characters.'; registerError.classList.remove('hidden'); return; }
        if (pw !== cf) { registerError.textContent = 'Passwords do not match.'; registerError.classList.remove('hidden'); return; }
        await AuthManager.register(document.getElementById('register-username').value, pw);
        showDashboard();
    });

    logoutBtn.addEventListener('click', () => { AuthManager.logout(); showAuth(); });

    // ===================== PAGE NAVIGATION =====================
    const navItems = document.querySelectorAll('.nav-links li');
    const pages = document.querySelectorAll('.page');

    const switchPage = (pageId) => {
        pages.forEach(p => { p.classList.remove('active-page'); p.classList.add('hidden'); });
        const target = document.getElementById(pageId);
        if (target) { target.classList.remove('hidden'); target.classList.add('active-page'); }
        navItems.forEach(li => li.classList.toggle('active', li.dataset.page === pageId));
        if (pageId === 'page-dashboard') updateDashboard();
        if (pageId === 'page-investments') renderAllInvestments();
    };

    navItems.forEach(li => {
        li.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); switchPage(li.dataset.page); });
    });

    document.getElementById('view-all-btn').addEventListener('click', () => switchPage('page-investments'));
    document.getElementById('add-investment-btn-2').addEventListener('click', () => openModal());

    // ===================== CHARTS =====================
    const charts = new DashboardCharts();

    // ===================== UI ELEMENTS =====================
    const addInvestmentBtn = document.getElementById('add-investment-btn');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const cancelModalBtn = document.getElementById('cancel-modal-btn');
    const modal = document.getElementById('investment-modal');
    const form = document.getElementById('add-investment-form');
    const kpiInvested = document.getElementById('kpi-total-invested');
    const kpiMaturity = document.getElementById('kpi-total-maturity');
    const kpiReturns = document.getElementById('kpi-total-returns');
    const tbody = document.getElementById('investments-tbody');
    const emptyState = document.getElementById('empty-state');
    const tableContainer = document.querySelector('#page-dashboard .table-container');
    const themeToggleBtn = document.getElementById('toggle-theme-btn');
    const invTypeSelect = document.getElementById('inv-type');
    const fdFields = document.getElementById('fd-fields');
    const sipFields = document.getElementById('sip-fields');
    const goldFields = document.getElementById('gold-fields');
    const genericFields = document.getElementById('generic-fields');
    const invDateInput = document.getElementById('inv-date');

    // FD elements
    const invAmountInput = document.getElementById('inv-amount');
    const invRateInput = document.getElementById('inv-rate');
    const invMaturityDate = document.getElementById('inv-maturity-date');
    const fdTenureDisplay = document.getElementById('fd-tenure-display');
    const fdMaturityDisplay = document.getElementById('fd-maturity-display');

    // SIP elements
    const sipMonthly = document.getElementById('sip-monthly');
    const sipMonths = document.getElementById('sip-months');
    const sipReturnRate = document.getElementById('sip-return-rate');
    const sipInvestedDisplay = document.getElementById('sip-invested-display');
    const sipMaturityDisplay = document.getElementById('sip-maturity-display');
    const sipGainDisplay = document.getElementById('sip-gain-display');

    // Gold elements
    const goldWeight = document.getElementById('gold-weight');
    const goldPurchasePrice = document.getElementById('gold-purchase-price');
    const goldInvestedDisplay = document.getElementById('gold-invested-display');
    const goldLiveDisplay = document.getElementById('gold-live-display');

    // Proof elements
    const invProofInput = document.getElementById('inv-proof');
    const proofPreviewContainer = document.getElementById('proof-preview-container');
    const proofPreviewImg = document.getElementById('proof-preview-img');
    const proofModal = document.getElementById('proof-modal');
    const closeProofBtn = document.getElementById('close-proof-btn');
    const proofDisplayImg = document.getElementById('proof-display-img');
    let currentProofBase64 = null;

    // Modal mode: null = adding a new investment, otherwise the id being edited.
    const modalTitle = document.getElementById('modal-title');
    const modalSubmitBtn = document.getElementById('modal-submit-btn');
    let editingId = null;

    // ===================== FORM FIELD TOGGLE =====================
    const allConditionalInputs = [
        invAmountInput, invRateInput, invMaturityDate,
        sipMonthly, sipMonths, sipReturnRate,
        goldWeight, goldPurchasePrice,
        document.getElementById('generic-amount'), document.getElementById('inv-maturity')
    ];

    const updateFieldVisibility = () => {
        const type = invTypeSelect.value;
        [fdFields, sipFields, goldFields, genericFields].forEach(f => f.classList.add('hidden'));
        allConditionalInputs.forEach(el => { if (el) el.removeAttribute('required'); });

        if (type === 'Fixed Deposit') {
            fdFields.classList.remove('hidden');
            [invAmountInput, invRateInput, invMaturityDate].forEach(el => el.setAttribute('required', ''));
        } else if (type === 'SIP') {
            sipFields.classList.remove('hidden');
            [sipMonthly, sipMonths, sipReturnRate].forEach(el => el.setAttribute('required', ''));
        } else if (type === 'Gold') {
            goldFields.classList.remove('hidden');
            [goldWeight, goldPurchasePrice].forEach(el => el.setAttribute('required', ''));
        } else {
            genericFields.classList.remove('hidden');
            [document.getElementById('generic-amount'), document.getElementById('inv-maturity')].forEach(el => el.setAttribute('required', ''));
        }
    };

    invTypeSelect.addEventListener('change', () => { updateFieldVisibility(); clearModalError(); });

    // ===================== LIVE PREVIEWS =====================
    const updateFDPreview = () => {
        const principal = parseFloat(invAmountInput.value) || 0;
        const rate = parseFloat(invRateInput.value) || 0;
        const start = invDateInput.value ? new Date(invDateInput.value) : null;
        const end = invMaturityDate.value ? new Date(invMaturityDate.value) : null;
        if (start && end && end > start) {
            const days = daysBetween(start, end);
            fdTenureDisplay.textContent = `${days} days`;
            fdMaturityDisplay.textContent = (principal > 0 && rate > 0) ? formatCurrency(Math.round(calculateFDMaturity(principal, rate, days))) : '₹ —';
        } else {
            fdTenureDisplay.textContent = '— days';
            fdMaturityDisplay.textContent = '₹ —';
        }
    };

    const updateSIPPreview = () => {
        const m = parseFloat(sipMonthly.value) || 0;
        const n = parseInt(sipMonths.value) || 0;
        const r = parseFloat(sipReturnRate.value) || 0;
        const total = m * n;
        sipInvestedDisplay.textContent = total > 0 ? formatCurrency(total) : '₹ —';
        if (m > 0 && n > 0) {
            const mat = Math.round(calculateSIPMaturity(m, r, n));
            sipMaturityDisplay.textContent = formatCurrency(mat);
            sipGainDisplay.textContent = formatCurrency(mat - total);
        } else {
            sipMaturityDisplay.textContent = '₹ —';
            sipGainDisplay.textContent = '₹ —';
        }
    };

    const updateGoldPreview = () => {
        const w = parseFloat(goldWeight.value) || 0;
        const pp = parseFloat(goldPurchasePrice.value) || 0;
        const invested = w * pp;
        goldInvestedDisplay.textContent = invested > 0 ? formatCurrency(Math.round(invested)) : '₹ —';
        if (liveGoldPricePerGram && w > 0) {
            goldLiveDisplay.textContent = formatCurrency(Math.round(w * liveGoldPricePerGram));
        } else {
            goldLiveDisplay.textContent = '₹ — (fetching...)';
        }
    };

    [invAmountInput, invRateInput, invDateInput, invMaturityDate].forEach(el => el.addEventListener('input', updateFDPreview));
    invMaturityDate.addEventListener('change', updateFDPreview);
    [sipMonthly, sipMonths, sipReturnRate].forEach(el => el.addEventListener('input', updateSIPPreview));
    [goldWeight, goldPurchasePrice].forEach(el => el.addEventListener('input', updateGoldPreview));

    // ===================== THEME TOGGLE =====================
    const toggleTheme = () => {
        document.body.classList.toggle('dark-theme');
        const isDark = document.body.classList.contains('dark-theme');
        themeToggleBtn.innerHTML = isDark ? '<i class="ph-fill ph-sun"></i> Light Mode' : '<i class="ph-fill ph-moon"></i> Dark Mode';
        setTimeout(() => charts.updateCharts(), 0);
    };
    if (!document.body.classList.contains('dark-theme')) themeToggleBtn.innerHTML = '<i class="ph-fill ph-moon"></i> Dark Mode';
    themeToggleBtn.addEventListener('click', toggleTheme);

    // ===================== MODAL =====================
    let modalDetachTrap = null;
    let modalReturnFocus = null;
    const activateModalFocus = () => {
        modalReturnFocus = document.activeElement; // the control that opened the modal
        modalDetachTrap = attachFocusTrap(modal);
        document.getElementById('inv-name').focus();
    };

    const openModal = () => {
        editingId = null;
        modalTitle.textContent = 'Add New Investment';
        modalSubmitBtn.textContent = 'Save Investment';
        clearModalError();
        modal.classList.remove('hidden');
        updateFieldVisibility();
        updateGoldPreview();
        activateModalFocus();
    };

    // Open the modal pre-filled with an existing investment for editing.
    const openEditModal = (inv) => {
        form.reset();
        clearModalError();
        editingId = inv.id;
        modalTitle.textContent = 'Edit Investment';
        modalSubmitBtn.textContent = 'Save Changes';

        document.getElementById('inv-name').value = inv.name || '';
        invTypeSelect.value = inv.type;
        invDateInput.value = inv.date || '';
        updateFieldVisibility();

        if (inv.type === 'Fixed Deposit') {
            invAmountInput.value = inv.amount ?? '';
            invRateInput.value = inv.interestRate ?? '';
            invMaturityDate.value = inv.maturityDate || '';
            updateFDPreview();
        } else if (inv.type === 'SIP') {
            sipMonthly.value = inv.sipMonthly ?? '';
            sipMonths.value = inv.sipDuration ?? '';
            sipReturnRate.value = inv.sipRate ?? '';
            updateSIPPreview();
        } else if (inv.type === 'Gold') {
            goldWeight.value = inv.goldWeight ?? '';
            goldPurchasePrice.value = inv.goldPurchasePrice ?? '';
            updateGoldPreview();
        } else {
            document.getElementById('generic-amount').value = inv.amount ?? '';
            document.getElementById('inv-maturity').value = inv.maturity ?? '';
        }

        // Carry the existing proof forward unless the user picks a new file.
        currentProofBase64 = inv.proof || null;
        if (inv.proof) {
            proofPreviewImg.src = inv.proof;
            proofPreviewContainer.classList.remove('hidden');
        } else {
            proofPreviewContainer.classList.add('hidden');
        }

        modal.classList.remove('hidden');
        activateModalFocus();
    };

    const closeModal = () => {
        modal.classList.add('hidden');
        form.reset();
        editingId = null;
        modalTitle.textContent = 'Add New Investment';
        modalSubmitBtn.textContent = 'Save Investment';
        updateFieldVisibility();
        fdTenureDisplay.textContent = '— days'; fdMaturityDisplay.textContent = '₹ —';
        sipInvestedDisplay.textContent = '₹ —'; sipMaturityDisplay.textContent = '₹ —'; sipGainDisplay.textContent = '₹ —';
        goldInvestedDisplay.textContent = '₹ —'; goldLiveDisplay.textContent = '₹ — (fetching...)';
        currentProofBase64 = null;
        proofPreviewContainer.classList.add('hidden');
        clearModalError();
        if (modalDetachTrap) { modalDetachTrap(); modalDetachTrap = null; }
        if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
    };
    addInvestmentBtn.addEventListener('click', openModal);
    closeModalBtn.addEventListener('click', closeModal);
    cancelModalBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    // Image compression for proof
    invProofInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) {
            currentProofBase64 = null;
            proofPreviewContainer.classList.add('hidden');
            return;
        }
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const MAX_WIDTH = 800;
                if (width > MAX_WIDTH) {
                    height = Math.round((height * MAX_WIDTH) / width);
                    width = MAX_WIDTH;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                currentProofBase64 = canvas.toDataURL('image/jpeg', 0.6);
                proofPreviewImg.src = currentProofBase64;
                proofPreviewContainer.classList.remove('hidden');
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });

    let proofDetachTrap = null, proofReturnFocus = null;
    const openProofModal = (src, trigger) => {
        proofReturnFocus = trigger || document.activeElement;
        proofDisplayImg.src = src;
        proofModal.classList.remove('hidden');
        proofDetachTrap = attachFocusTrap(proofModal);
        closeProofBtn.focus();
    };
    const closeProofModal = () => {
        proofModal.classList.add('hidden');
        if (proofDetachTrap) { proofDetachTrap(); proofDetachTrap = null; }
        if (proofReturnFocus && proofReturnFocus.focus) proofReturnFocus.focus();
    };
    closeProofBtn.addEventListener('click', closeProofModal);
    proofModal.addEventListener('click', (e) => { if (e.target === proofModal) closeProofModal(); });
    proofModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProofModal(); });

    // ===================== FORM SUBMISSION =====================
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const type = invTypeSelect.value;
        let amount = 0, maturity = 0;
        let interestRate = null, maturityDate = null, tenureDays = null;
        let sipMonthlyAmt = null, sipDuration = null, sipRate = null;
        let goldWeightVal = null, goldPurchasePriceVal = null;

        if (type === 'Fixed Deposit') {
            amount = parseFloat(invAmountInput.value) || 0;
            interestRate = parseFloat(invRateInput.value) || 0;
            maturityDate = invMaturityDate.value;
            tenureDays = daysBetween(invDateInput.value, maturityDate);
            maturity = Math.round(calculateFDMaturity(amount, interestRate, tenureDays));
        } else if (type === 'SIP') {
            sipMonthlyAmt = parseFloat(sipMonthly.value) || 0;
            sipDuration = parseInt(sipMonths.value) || 0;
            sipRate = parseFloat(sipReturnRate.value) || 0;
            amount = sipMonthlyAmt * sipDuration;
            maturity = Math.round(calculateSIPMaturity(sipMonthlyAmt, sipRate, sipDuration));
            tenureDays = Math.round(sipDuration * 30.44);
        } else if (type === 'Gold') {
            goldWeightVal = parseFloat(goldWeight.value) || 0;
            goldPurchasePriceVal = parseFloat(goldPurchasePrice.value) || 0;
            amount = Math.round(goldWeightVal * goldPurchasePriceVal);
            maturity = liveGoldPricePerGram ? Math.round(goldWeightVal * liveGoldPricePerGram) : amount;
        } else {
            amount = parseFloat(document.getElementById('generic-amount').value) || 0;
            maturity = parseFloat(document.getElementById('inv-maturity').value) || 0;
        }

        const record = {
            name: document.getElementById('inv-name').value,
            type, amount, maturity,
            date: invDateInput.value,
            interestRate, maturityDate, tenureDays,
            sipMonthly: sipMonthlyAmt, sipDuration, sipRate,
            goldWeight: goldWeightVal, goldPurchasePrice: goldPurchasePriceVal,
            proof: currentProofBase64
        };

        // Semantic validation beyond the HTML min/required checks (e.g. amount > 0,
        // maturity date after start date). Show the first problem and stop.
        const errors = InvestmentStorage.validate(record);
        if (errors.length) { showModalError(errors[0]); return; }
        clearModalError();

        if (editingId) {
            record.id = editingId;
            InvestmentStorage.updateInvestment(record);
        } else {
            InvestmentStorage.addInvestment(record);
        }

        closeModal();
        updateDashboard();
        renderAllInvestments();
    });

    // ===================== TABLE ACTIONS =====================
    const handleTableAction = async (e) => {
        const editBtn = e.target.closest('.edit-btn');
        if (editBtn) {
            const inv = InvestmentStorage.getInvestment(editBtn.dataset.id);
            if (inv) openEditModal(inv);
            return;
        }
        const deleteBtn = e.target.closest('.delete-btn');
        if (deleteBtn) {
            const inv = InvestmentStorage.getInvestment(deleteBtn.dataset.id);
            const label = inv && inv.name ? `“${inv.name}”` : 'This investment';
            const ok = await confirmDialog({
                title: 'Delete investment?',
                message: `${label} will be permanently removed. This can't be undone.`,
                confirmText: 'Delete',
                danger: true
            });
            if (ok) {
                InvestmentStorage.deleteInvestment(deleteBtn.dataset.id);
                updateDashboard();
                renderAllInvestments();
            }
            return;
        }
        const proofBtn = e.target.closest('.view-proof-btn');
        if (proofBtn) {
            openProofModal(proofBtn.dataset.proof, proofBtn);
        }
    };
    tbody.addEventListener('click', handleTableAction);
    document.getElementById('all-investments-tbody').addEventListener('click', handleTableAction);

    // ===================== BUILD TABLE ROW =====================
    const buildRow = (inv) => {
        const tr = document.createElement('tr');
        const amt = Number(inv.amount) || 0;
        const mat = Number(inv.maturity) || 0;
        const isProfit = mat >= amt;
        // Money-weighted return (XIRR) — accounts for SIP contribution timing.
        const invReturn = amt > 0 ? Math.round(investmentReturn(inv) * 100) / 100 : 0;

        let typeExtra = '';
        if (inv.type === 'Fixed Deposit' && inv.interestRate) {
            typeExtra = `<br><small style="color:var(--text-muted)">${Number(inv.interestRate)}% · ${Number(inv.tenureDays) || '—'}d</small>`;
        } else if (inv.type === 'SIP' && inv.sipMonthly) {
            typeExtra = `<br><small style="color:var(--text-muted)">₹${(Number(inv.sipMonthly) || 0).toLocaleString('en-IN')}/mo · ${Number(inv.sipDuration) || 0}mo</small>`;
        } else if (inv.type === 'Gold' && inv.goldWeight) {
            typeExtra = `<br><small style="color:var(--text-muted)">${Number(inv.goldWeight)}g</small>`;
        }

        const nameLabel = escapeHtml(inv.name);
        // proof is validated to be a data:image/* URL on import; escape defensively.
        let proofBtnHtml = inv.proof
            ? `<button class="view-proof-btn" data-proof="${escapeHtml(inv.proof)}" title="View Proof" aria-label="View proof for ${nameLabel}" style="margin-right:0.5rem"><i class="ph-bold ph-image" aria-hidden="true"></i></button>`
            : '';

        tr.innerHTML = `
            <td><strong>${escapeHtml(inv.name)}</strong></td>
            <td><span class="type-badge">${escapeHtml(inv.type)}</span>${typeExtra}</td>
            <td>${formatCurrency(amt)}</td>
            <td style="color:var(--${isProfit ? 'success' : 'danger'})">${formatCurrency(mat)}</td>
            <td style="color:var(--${isProfit ? 'success' : 'danger'});font-weight:600">${isProfit ? '+' : ''}${invReturn}%</td>
            <td>${formatDate(inv.date)}</td>
            <td>
                ${proofBtnHtml}
                <button class="edit-btn" data-id="${inv.id}" title="Edit" aria-label="Edit ${nameLabel}" style="margin-right:0.5rem"><i class="ph-bold ph-pencil-simple" aria-hidden="true"></i></button>
                <button class="delete-btn" data-id="${inv.id}" title="Delete" aria-label="Delete ${nameLabel}"><i class="ph-bold ph-trash" aria-hidden="true"></i></button>
            </td>
        `;
        return tr;
    };

    // ===================== DASHBOARD RENDER =====================
    const updateDashboard = () => {
        const kpis = InvestmentStorage.getKPIs();
        kpiInvested.textContent = formatCurrency(kpis.totalInvested);
        kpiMaturity.textContent = formatCurrency(kpis.totalMaturity);
        const rFmt = kpis.returnsPercentage.toFixed(2) + '%';
        kpiReturns.textContent = (kpis.returnsPercentage > 0 ? '+' : '') + rFmt;
        kpiReturns.className = 'kpi-value ' + (kpis.returnsPercentage >= 0 ? 'positive' : 'negative');

        // Show/hide gold banner
        const cached = getCachedGoldPrice();
        const investments = InvestmentStorage.getInvestments();
        const hasGold = investments.some(inv => inv.type === 'Gold');
        if (hasGold && (liveGoldPricePerGram || cached)) {
            updateGoldBanner(liveGoldPricePerGram || cached?.pricePerGram, cached?.timestamp);
        } else if (!hasGold) {
            document.getElementById('gold-price-banner').classList.add('hidden');
        }

        charts.initCharts();

        // Render recent (up to 5)
        tbody.innerHTML = '';
        if (investments.length === 0) {
            emptyState.classList.remove('hidden');
            tableContainer.classList.add('hidden');
        } else {
            emptyState.classList.add('hidden');
            tableContainer.classList.remove('hidden');
            investments.slice(0, 5).forEach(inv => tbody.appendChild(buildRow(inv)));
        }
    };

    // ===================== INVESTMENTS PAGE =====================
    let currentFilter = 'All';
    let currentSearch = '';

    const renderAllInvestments = () => {
        let investments = InvestmentStorage.getInvestments();
        const allTbody = document.getElementById('all-investments-tbody');
        const allEmpty = document.getElementById('all-empty-state');
        const allTable = document.querySelector('#page-investments .table-container');

        if (currentFilter !== 'All') investments = investments.filter(inv => inv.type === currentFilter);
        if (currentSearch) {
            const q = currentSearch.toLowerCase();
            investments = investments.filter(inv => inv.name.toLowerCase().includes(q));
        }

        allTbody.innerHTML = '';
        if (investments.length === 0) {
            allEmpty.classList.remove('hidden');
            allTable.classList.add('hidden');
        } else {
            allEmpty.classList.add('hidden');
            allTable.classList.remove('hidden');
            investments.forEach(inv => allTbody.appendChild(buildRow(inv)));
        }
    };

    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            currentFilter = chip.dataset.filter;
            renderAllInvestments();
        });
    });

    document.getElementById('inv-search').addEventListener('input', (e) => {
        currentSearch = e.target.value;
        renderAllInvestments();
    });

    // ===================== SETTINGS =====================
    const passwordForm = document.getElementById('change-password-form');
    const passwordMsg = document.getElementById('password-msg');
    const showMsg = (el, text, type) => {
        el.textContent = text;
        el.className = `settings-msg ${type}`;
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 4000);
    };

    passwordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const current = document.getElementById('current-password').value;
        const newPass = document.getElementById('new-password').value;
        const confirmNew = document.getElementById('confirm-new-password').value;
        const username = AuthManager.getUsername();
        const valid = await AuthManager.login(username, current);
        if (!valid) { showMsg(passwordMsg, 'Current password is incorrect.', 'error'); return; }
        if (newPass.length < 4) { showMsg(passwordMsg, 'New password must be at least 4 characters.', 'error'); return; }
        if (newPass !== confirmNew) { showMsg(passwordMsg, 'New passwords do not match.', 'error'); return; }
        await AuthManager.register(username, newPass);
        showMsg(passwordMsg, 'Password updated successfully!', 'success');
        passwordForm.reset();
    });

    document.getElementById('export-btn').addEventListener('click', () => {
        const data = InvestmentStorage.getInvestments();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `infinity-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        showMsg(document.getElementById('data-msg'), 'Data exported successfully!', 'success');
    });

    document.getElementById('import-file').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target.result);
                const imported = InvestmentStorage.normalizeImported(parsed);
                if (!imported) throw new Error('Invalid');
                InvestmentStorage.backupNow(); // snapshot current data before overwriting
                InvestmentStorage.saveInvestments(imported);
                updateDashboard(); renderAllInvestments();
                showMsg(document.getElementById('data-msg'), `Imported ${imported.length} investments!`, 'success');
            } catch { showMsg(document.getElementById('data-msg'), 'Invalid JSON file.', 'error'); }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    document.getElementById('clear-data-btn').addEventListener('click', async () => {
        const ok = await confirmDialog({
            title: 'Clear all data?',
            message: 'Every investment will be permanently deleted. A backup is kept so you can restore.',
            confirmText: 'Clear everything',
            danger: true
        });
        if (ok) {
            InvestmentStorage.backupNow(); // keep a recoverable snapshot before wiping
            InvestmentStorage.saveInvestments([]);
            updateDashboard(); renderAllInvestments();
            showMsg(document.getElementById('data-msg'), 'All data cleared. Use “Restore backup” if this was a mistake.', 'success');
        }
    });

    const restoreBackupBtn = document.getElementById('restore-backup-btn');
    if (restoreBackupBtn) {
        restoreBackupBtn.addEventListener('click', async () => {
            const backup = InvestmentStorage.getBackup();
            if (!backup) {
                showMsg(document.getElementById('data-msg'), 'No backup available yet.', 'error');
                return;
            }
            const when = new Date(backup.timestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
            const ok = await confirmDialog({
                title: 'Restore backup?',
                message: `Restore ${backup.count} investment(s) from the backup saved on ${when}? This replaces your current data.`,
                confirmText: 'Restore'
            });
            if (ok) {
                await InvestmentStorage.restoreBackup();
                updateDashboard(); renderAllInvestments();
                showMsg(document.getElementById('data-msg'), `Restored ${backup.count} investments from backup.`, 'success');
            }
        });
    }

    // ===================== INIT =====================
    updateFieldVisibility();
});
