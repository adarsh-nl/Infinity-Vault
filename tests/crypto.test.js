import { describe, it, expect } from 'vitest';
import VaultCrypto from '../crypto.js';

// Node 20+ exposes Web Crypto as globalThis.crypto, so these run in CI unchanged.

describe('VaultCrypto', () => {
    it('reports supported in this environment', () => {
        expect(VaultCrypto.isSupported()).toBe(true);
    });

    it('base64 round-trips arbitrary bytes', () => {
        const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
        const b64 = VaultCrypto.bytesToB64(bytes);
        expect(Array.from(VaultCrypto.b64ToBytes(b64))).toEqual(Array.from(bytes));
    });

    it('encrypts then decrypts JSON with the same derived key', async () => {
        const salt = VaultCrypto.randomBytes(16);
        const key = await VaultCrypto.deriveKey('correct horse battery', salt, 50000);
        const blob = await VaultCrypto.encryptJSON(key, { a: 1, note: 'hello' });
        expect(VaultCrypto.isEncryptedBlob(blob)).toBe(true);
        expect(await VaultCrypto.decryptJSON(key, blob)).toEqual({ a: 1, note: 'hello' });
    });

    it('fails to decrypt with a wrong password', async () => {
        const salt = VaultCrypto.randomBytes(16);
        const right = await VaultCrypto.deriveKey('right', salt, 50000);
        const wrong = await VaultCrypto.deriveKey('wrong', salt, 50000);
        const blob = await VaultCrypto.encryptJSON(right, { secret: 42 });
        await expect(VaultCrypto.decryptJSON(wrong, blob)).rejects.toBeTruthy();
    });

    it('exports and re-imports a key (session resume across reload)', async () => {
        const salt = VaultCrypto.randomBytes(16);
        const key = await VaultCrypto.deriveKey('pw', salt, 50000);
        const reimported = await VaultCrypto.importKey(await VaultCrypto.exportKey(key));
        const blob = await VaultCrypto.encryptJSON(key, { x: 1 });
        expect(await VaultCrypto.decryptJSON(reimported, blob)).toEqual({ x: 1 });
    });
});
