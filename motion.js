// motion.js — the premium interaction layer for Infinity Vault.
//
// Dependency-free by design: Web Animations API + IntersectionObserver + rAF,
// served same-origin so the hardened CSP (script-src 'self') and the zero-build
// ethos are untouched. Every effect is transform/opacity-only (GPU-composited,
// 60fps) and gated behind `prefers-reduced-motion` — motion is an enhancement,
// never a dependency. The app works identically if this file is removed; all
// hooks in app.js are guarded (`window.Motion && …`).
//
// Public API (all no-ops under reduced motion where motion isn't essential):
//   Motion.enter(scope)            orchestrated entrance for 'auth' | 'dashboard'
//   Motion.unlock(done)            cinematic auth → dashboard transition
//   Motion.pageTransition(id)      crossfade a switched-in SPA section
//   Motion.countUp(el, value, fmt) tween a number to its new value
//   Motion.revealChildren(el, sel) stagger-reveal freshly-rendered children
(function (root) {
    'use strict';

    // ---- easing (never linear) ---------------------------------------------
    const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';   // expo-out: decisive, cinematic
    const EASE_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'; // gentle overshoot
    const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canHover = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
    const raf = requestAnimationFrame;

    // Small WAAPI helper with sane defaults.
    function animate(el, keyframes, { duration = 600, delay = 0, easing = EASE_OUT, fill = 'both' } = {}) {
        return el.animate(keyframes, { duration, delay, easing, fill });
    }

    // ====================================================================
    // 1. PROGRESSIVE REVEAL — staggered fade + rise, the backbone of the feel
    // ====================================================================
    // Why: progressive disclosure guides the eye top-to-bottom and lifts
    // perceived quality; a hierarchy of small delays reads as "composed".
    function revealGroup(elements, { stagger = 70, y = 18, duration = 620, baseDelay = 0 } = {}) {
        if (prefersReduced()) { elements.forEach((el) => (el.style.opacity = '')); return; }
        elements.forEach((el, i) => {
            animate(el, [
                { opacity: 0, transform: `translate3d(0, ${y}px, 0)` },
                { opacity: 1, transform: 'translate3d(0, 0, 0)' },
            ], { duration, delay: baseDelay + i * stagger });
        });
    }

    // Reveal the direct reveal-targets inside a container (cards, tables, headers).
    const REVEAL_SEL = '[data-reveal], .kpi-card, .chart-container, .settings-card, .table-container, .dashboard-header, .gold-price-banner';
    function revealScope(container, opts) {
        const targets = [...container.querySelectorAll(REVEAL_SEL)]
            .filter((el) => !el.classList.contains('hidden') && el.offsetParent !== null);
        revealGroup(targets, opts);
    }

    // Stagger freshly-rendered list rows (called after the table re-renders).
    function revealChildren(container, selector = 'tr') {
        if (!container || prefersReduced()) return;
        revealGroup([...container.querySelectorAll(selector)], { stagger: 45, y: 10, duration: 480 });
    }

    // ====================================================================
    // 2. HERO / AUTH ENTRANCE — split-line + word reveal for the wordmark
    // ====================================================================
    // Why: the auth screen is the first impression. A masked, staggered
    // reveal of the brand + form makes the product feel crafted from frame one.
    function splitWordmark(h1) {
        if (h1.dataset.split) return;                 // idempotent
        const text = h1.textContent.trim();
        h1.textContent = '';
        h1.dataset.split = '1';
        text.split(' ').forEach((word, wi, arr) => {
            const wrap = document.createElement('span');
            wrap.className = 'word-mask';
            const inner = document.createElement('span');
            inner.className = 'word-inner';
            inner.textContent = word;
            wrap.appendChild(inner);
            h1.appendChild(wrap);
            if (wi < arr.length - 1) h1.appendChild(document.createTextNode(' '));
        });
    }

    function enterAuth() {
        const container = document.querySelector('.auth-container');
        if (!container) return;
        const h1 = container.querySelector('.auth-logo h1');
        if (h1) splitWordmark(h1);
        if (prefersReduced()) return;

        const logo = container.querySelector('.auth-logo');
        const subtitle = container.querySelector('.auth-subtitle');
        const form = container.querySelector('.auth-form:not(.hidden)');
        const words = h1 ? [...h1.querySelectorAll('.word-inner')] : [];

        // Card itself: soft scale-in.
        animate(container, [
            { opacity: 0, transform: 'translate3d(0,24px,0) scale(0.985)' },
            { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
        ], { duration: 800 });

        // Wordmark: each word rises out of its clip mask.
        words.forEach((w, i) => animate(w, [
            { transform: 'translate3d(0,110%,0)' },
            { transform: 'translate3d(0,0,0)' },
        ], { duration: 760, delay: 260 + i * 90, easing: EASE_OUT }));

        // Logo mark, subtitle, then the form fields in sequence.
        const seq = [logo && logo.querySelector('.logo-icon'), subtitle,
        ...(form ? form.querySelectorAll('.form-group, .auth-error, .btn-primary, .link-btn') : [])].filter(Boolean);
        seq.forEach((el, i) => animate(el, [
            { opacity: 0, transform: 'translate3d(0,14px,0)' },
            { opacity: 1, transform: 'translate3d(0,0,0)' },
        ], { duration: 620, delay: 420 + i * 70 }));
    }

    // ====================================================================
    // 3. DASHBOARD ENTRANCE + cinematic unlock
    // ====================================================================
    function enterDashboard() {
        const dash = document.getElementById('dashboard');
        if (!dash) return;
        // Sidebar items cascade in; active page content reveals in a hierarchy.
        const navItems = [...dash.querySelectorAll('.nav-links li')];
        revealGroup(navItems, { stagger: 60, y: 8, duration: 520, baseDelay: 120 });
        const activePage = dash.querySelector('.page:not(.hidden)') || document.getElementById('page-dashboard');
        if (activePage) revealScope(activePage, { baseDelay: 180, stagger: 85 });
        placeNavIndicator(false);
    }

    // The auth card recedes and the dashboard rises to meet it — the "vault opens".
    function unlock(done) {
        const auth = document.getElementById('auth-screen');
        if (prefersReduced() || !auth) { if (done) done(); enterDashboard(); return; }
        const a = animate(auth, [
            { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
            { opacity: 0, transform: 'scale(1.04)', filter: 'blur(6px)' },
        ], { duration: 560, easing: EASE_OUT });
        a.onfinish = () => { if (done) done(); enterDashboard(); };
    }

    // ====================================================================
    // 4. SECTION (SPA page) TRANSITION — a soft crossfade + rise
    // ====================================================================
    function pageTransition(pageId) {
        const page = document.getElementById(pageId);
        if (!page || prefersReduced()) return;
        animate(page, [
            { opacity: 0, transform: 'translate3d(0,12px,0)' },
            { opacity: 1, transform: 'translate3d(0,0,0)' },
        ], { duration: 520 });
        revealScope(page, { baseDelay: 60, stagger: 70 });
        placeNavIndicator(true);
    }

    // ====================================================================
    // 5. NUMBER COUNT-UP — the finance-dashboard signature
    // ====================================================================
    // Why: watching invested/returns tick up (or tween on edit) reads as
    // "live" and premium (Stripe/Linear). Tweens from the last shown value, so
    // edits animate the *delta*, not a jarring reset.
    function countUp(el, target, format) {
        target = Number(target) || 0;
        const start = Number(el.dataset._v);
        const from = Number.isFinite(start) ? start : 0;
        el.dataset._v = String(target);
        if (prefersReduced() || from === target) { el.textContent = format(target); return; }
        const t0 = performance.now();
        const dur = 900;
        const ease = (t) => 1 - Math.pow(1 - t, 4); // quart-out
        (function tick(now) {
            const p = Math.min(1, (now - t0) / dur);
            el.textContent = format(from + (target - from) * ease(p));
            if (p < 1) raf(tick);
        })(t0);
    }

    // ====================================================================
    // 6. NAV INDICATOR — a sliding pill that tracks the active item
    // ====================================================================
    let navIndicator = null;
    function placeNavIndicator(animateMove) {
        const list = document.querySelector('.nav-links');
        const active = document.querySelector('.nav-links li.active');
        if (!list || !active) return;
        if (!navIndicator) {
            navIndicator = document.createElement('span');
            navIndicator.className = 'nav-indicator';
            list.appendChild(navIndicator);
        }
        const lr = list.getBoundingClientRect();
        const ar = active.getBoundingClientRect();
        const top = ar.top - lr.top;
        navIndicator.style.height = ar.height + 'px';
        if (animateMove && !prefersReduced()) {
            animate(navIndicator, [{ transform: `translateY(${navIndicator._y || top}px)` }, { transform: `translateY(${top}px)` }],
                { duration: 420, easing: EASE_SPRING });
        }
        navIndicator.style.transform = `translateY(${top}px)`;
        navIndicator._y = top;
        navIndicator.style.opacity = '1';
    }

    // ====================================================================
    // 7. MAGNETIC BUTTONS — the pointer pulls the CTA, spring-back on leave
    // ====================================================================
    function wireMagnetic(el, strength = 0.32) {
        if (!canHover()) return;
        const label = el.querySelector('span, i') || el;
        const onMove = (e) => {
            const r = el.getBoundingClientRect();
            const mx = e.clientX - (r.left + r.width / 2);
            const my = e.clientY - (r.top + r.height / 2);
            el.style.transform = `translate(${mx * strength}px, ${my * strength}px)`;
            if (label !== el) label.style.transform = `translate(${mx * strength * 0.4}px, ${my * strength * 0.4}px)`;
        };
        const reset = () => {
            animate(el, [{ transform: el.style.transform }, { transform: 'translate(0,0)' }], { duration: 520, easing: EASE_SPRING });
            el.style.transform = '';
            if (label !== el) label.style.transform = '';
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerleave', reset);
    }

    // ====================================================================
    // 8. CARD TILT + POINTER GLOW — layered depth, subtle (max ~5deg)
    // ====================================================================
    function wireTilt(card) {
        if (!canHover()) return;
        card.classList.add('tilt-card');
        const onMove = (e) => {
            const r = card.getBoundingClientRect();
            const px = (e.clientX - r.left) / r.width;
            const py = (e.clientY - r.top) / r.height;
            card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
            card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
            card.style.transform =
                `perspective(900px) rotateX(${(0.5 - py) * 5}deg) rotateY(${(px - 0.5) * 5}deg) translateZ(0)`;
        };
        const reset = () => {
            animate(card, [{ transform: card.style.transform }, { transform: 'perspective(900px) rotateX(0) rotateY(0)' }],
                { duration: 600, easing: EASE_SPRING });
            card.style.transform = '';
        };
        card.addEventListener('pointermove', onMove);
        card.addEventListener('pointerleave', reset);
    }

    // ====================================================================
    // 9. RIPPLE — tactile click feedback on buttons
    // ====================================================================
    function wireRipple(scope) {
        scope.addEventListener('pointerdown', (e) => {
            const btn = e.target.closest('.btn-primary, .btn-secondary, .btn-danger, .auth-btn');
            if (!btn || prefersReduced()) return;
            const r = btn.getBoundingClientRect();
            const ink = document.createElement('span');
            ink.className = 'ripple-ink';
            const size = Math.max(r.width, r.height) * 2;
            ink.style.width = ink.style.height = size + 'px';
            ink.style.left = e.clientX - r.left - size / 2 + 'px';
            ink.style.top = e.clientY - r.top - size / 2 + 'px';
            btn.appendChild(ink);
            ink.addEventListener('animationend', () => ink.remove());
        });
    }

    // ====================================================================
    // 10. PRELOADER — branded logo mark, fades to the entrance
    // ====================================================================
    function dismissPreloader() {
        const pre = document.getElementById('preloader');
        if (!pre) return;
        if (prefersReduced()) { pre.remove(); return; }
        const a = animate(pre, [{ opacity: 1 }, { opacity: 0 }], { duration: 520, delay: 320, easing: EASE_OUT });
        a.onfinish = () => pre.remove();
    }

    // ====================================================================
    // Wiring — apply autonomous behaviors once the DOM is ready
    // ====================================================================
    function init() {
        wireRipple(document.body);
        // Magnetic on the primary CTAs (hero + add-investment).
        document.querySelectorAll('.auth-btn, #add-investment-btn').forEach((b) => wireMagnetic(b));
        // Depth on the interactive surfaces.
        document.querySelectorAll('.kpi-card, .chart-container, .settings-card').forEach((c) => wireTilt(c));
        // Re-place the nav indicator on resize.
        addEventListener('resize', () => placeNavIndicator(false), { passive: true });
        dismissPreloader();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    root.Motion = {
        enter(scope) { scope === 'auth' ? enterAuth() : enterDashboard(); },
        unlock, pageTransition, countUp, revealChildren,
        // re-wire tilt/magnetic on nodes added later (e.g. rebuilt cards)
        wireTilt, wireMagnetic,
    };
})(window);
