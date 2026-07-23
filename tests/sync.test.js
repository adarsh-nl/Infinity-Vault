import { beforeEach, describe, it, expect } from 'vitest';
import VaultCrypto from '../crypto.js';
import Finance from '../finance.js';
import { InvestmentStorage } from '../storage.js';
import { AuthManager } from '../auth.js';
import Sync from '../sync.js';

// ---- in-memory mock of the Phase 1 backend (implements the API contract) ----
function makeServer() {
    const db = { users: {}, sessions: {}, vaults: {} };
    const requests = [];
    let n = 0;
    const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => (obj ? JSON.stringify(obj) : '') });
    const uidFromAuth = (headers) => db.sessions[(headers.Authorization || '').replace('Bearer ', '')];
    const userById = (id) => Object.values(db.users).find(u => u.id === id);

    const transport = async (url, opts) => {
        const path = url; // apiBase '' in tests
        const body = opts.body ? JSON.parse(opts.body) : null;
        requests.push({ method: opts.method, path, body });
        const H = opts.headers || {};

        if (opts.method === 'POST' && path === '/v1/account') {
            if (db.users[body.email]) return resp(409, { error: 'email_taken' });
            const id = 'u' + (++n); db.users[body.email] = { id, ...body, vaultVersion: 0 };
            const token = 't' + (++n); db.sessions[token] = id;
            return resp(201, { token, expiresAt: 'x' });
        }
        if (opts.method === 'POST' && path === '/v1/session/prelogin') {
            const u = db.users[body.email];
            return resp(200, u ? { authSalt: u.authSalt, authIters: u.authIters } : { authSalt: 'AAAAAAAAAAAAAAAAAAAAAA==', authIters: 210000 });
        }
        if (opts.method === 'POST' && path === '/v1/session') {
            const u = db.users[body.email];
            if (!u || u.authHash !== body.authHash) return resp(401, { error: 'invalid_credentials' });
            const token = 't' + (++n); db.sessions[token] = u.id;
            return resp(200, { token, expiresAt: 'x', account: { kekSalt: u.kekSalt, kekIters: u.kekIters, wrappedDEK: u.wrappedDEK, recovery: u.recovery, vaultVersion: u.vaultVersion } });
        }
        if (opts.method === 'GET' && path === '/v1/vault') {
            const uid = uidFromAuth(H); if (!uid) return resp(401, { error: 'unauthorized' });
            const v = db.vaults[uid]; if (!v) return resp(204, null);
            return resp(200, { vaultVersion: v.version, ciphertext: v.ciphertext });
        }
        if (opts.method === 'PUT' && path === '/v1/vault') {
            const uid = uidFromAuth(H); if (!uid) return resp(401, { error: 'unauthorized' });
            const cur = db.vaults[uid]; const curV = cur ? cur.version : 0;
            if ((body.baseVersion || 0) !== curV) return resp(409, { error: 'version_conflict', vaultVersion: curV });
            const nv = curV + 1; db.vaults[uid] = { version: nv, ciphertext: body.ciphertext };
            userById(uid).vaultVersion = nv;
            return resp(200, { vaultVersion: nv });
        }
        if (opts.method === 'POST' && path === '/v1/account/keys') {
            const uid = uidFromAuth(H); if (!uid) return resp(401, { error: 'unauthorized' });
            Object.assign(userById(uid), body);
            return resp(200, {});
        }
        if (opts.method === 'DELETE' && path === '/v1/account') {
            const uid = uidFromAuth(H); if (!uid) return resp(401, { error: 'unauthorized' });
            const email = Object.keys(db.users).find(e => db.users[e].id === uid);
            delete db.users[email]; delete db.vaults[uid];
            return resp(204, null);
        }
        return resp(404, { error: 'not_found' });
    };
    return { transport, db, requests };
}

function memStore() {
    const s = {};
    return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null),
        setItem: (k, v) => { s[k] = String(v); },
        removeItem: (k) => { delete s[k]; },
    };
}

// Simulate a device by swapping the storage globals + resetting module caches.
function useDevice(dev) {
    globalThis.localStorage = dev.local;
    globalThis.sessionStorage = dev.session;
    InvestmentStorage.lock();
}
function newDevice() { return { local: memStore(), session: memStore() }; }

let server;
beforeEach(() => {
    globalThis.Finance = Finance;
    globalThis.VaultCrypto = VaultCrypto;
    globalThis.InvestmentStorage = InvestmentStorage;
    globalThis.AuthManager = AuthManager;
    server = makeServer();
    Sync.setTransport(server.transport);
});

describe('E2EE sync — enable, backup, restore on a second device', () => {
    it('round-trips the vault across devices without leaking plaintext', async () => {
        const deviceA = newDevice();
        useDevice(deviceA);

        // Device A: local account + a distinctively-named investment
        await AuthManager.register('alice', 'pw12345');
        InvestmentStorage.addInvestment({ name: 'SECRET_HDFC_FD', type: 'Fixed Deposit', amount: 100000, maturity: 107186, date: '2025-01-01', maturityDate: '2026-01-01', interestRate: 7, tenureDays: 365 });
        await InvestmentStorage.saveInvestments(InvestmentStorage.getInvestments());

        Sync.configure('');
        await Sync.enable('alice@example.com', 'pw12345');
        expect(Sync.status().enabled).toBe(true);
        expect(server.db.vaults[server.db.users['alice@example.com'].id]).toBeTruthy();

        // Zero-knowledge: no request body ever contains the plaintext name.
        const wire = JSON.stringify(server.requests);
        expect(wire).not.toContain('SECRET_HDFC_FD');

        // Device B: fresh storage, signs in + restores
        const deviceB = newDevice();
        useDevice(deviceB);
        Sync.configure('');
        await Sync.signIn('alice@example.com', 'pw12345');
        await Sync.restore('pw12345');

        const restored = InvestmentStorage.getInvestments();
        expect(restored).toHaveLength(1);
        expect(restored[0].name).toBe('SECRET_HDFC_FD');
        expect(restored[0].amount).toBe(100000);
    });

    it('rejects a wrong password on restore (cannot unwrap the DEK)', async () => {
        const a = newDevice(); useDevice(a);
        await AuthManager.register('bob', 'right-pw');
        Sync.configure(''); await Sync.enable('bob@example.com', 'right-pw');

        const b = newDevice(); useDevice(b);
        Sync.configure('');
        await Sync.signIn('bob@example.com', 'wrong-pw'); // server auth still passes? no:
        // signIn computes authHash from wrong pw → server 401
        // (assert the failure explicitly below instead)
        await expect(Sync.restore('wrong-pw')).rejects.toThrow();
    });

    it('signIn fails with the wrong password (authHash mismatch)', async () => {
        const a = newDevice(); useDevice(a);
        await AuthManager.register('carol', 'right-pw');
        Sync.configure(''); await Sync.enable('carol@example.com', 'right-pw');

        const b = newDevice(); useDevice(b);
        Sync.configure('');
        await expect(Sync.signIn('carol@example.com', 'wrong-pw')).rejects.toMatchObject({ status: 401 });
    });
});

describe('backup CAS', () => {
    it('rejects a stale baseVersion with 409 version_conflict', async () => {
        const a = newDevice(); useDevice(a);
        await AuthManager.register('dave', 'pw');
        InvestmentStorage.addInvestment({ name: 'X', type: 'Stocks', amount: 100, maturity: 120, date: '2025-01-01' });
        await InvestmentStorage.saveInvestments(InvestmentStorage.getInvestments());
        Sync.configure(''); await Sync.enable('dave@example.com', 'pw'); // version now 1

        // Force a stale local version, then attempt a backup → conflict.
        const cfg = JSON.parse(a.local.getItem('infinity_vault_sync')); cfg.vaultVersion = 0;
        a.local.setItem('infinity_vault_sync', JSON.stringify(cfg));
        await expect(Sync.backupNow()).rejects.toThrow('version_conflict');
    });
});
