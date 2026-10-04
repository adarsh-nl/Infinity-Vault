import { describe, it, expect } from 'vitest';
import VaultCrypto from '../crypto.js';

// Prove that a DEK wrapped by a password/recovery KEK round-trips, by encrypting
// with the original DEK and decrypting with the unwrapped one.
async function sameKey(dekA, dekB) {
    const blob = await VaultCrypto.encryptJSON(dekA, { probe: 'ok' });
    return (await VaultCrypto.decryptJSON(dekB, blob)).probe === 'ok';
}

describe('envelope encryption (DEK / KEK)', () => {
    it('wraps and unwraps a DEK with a password-derived KEK', async () => {
        const dek = await VaultCrypto.generateDEK();
        const salt = VaultCrypto.randomBytes(16);
        const wrapped = await VaultCrypto.wrapDEK(await VaultCrypto.deriveWrappingKey('pw', salt, 50000), dek);
        const dek2 = await VaultCrypto.unwrapDEK(await VaultCrypto.deriveWrappingKey('pw', salt, 50000), wrapped);
        expect(await sameKey(dek, dek2)).toBe(true);
    });

    it('fails to unwrap with the wrong password', async () => {
        const dek = await VaultCrypto.generateDEK();
        const salt = VaultCrypto.randomBytes(16);
        const wrapped = await VaultCrypto.wrapDEK(await VaultCrypto.deriveWrappingKey('right', salt, 50000), dek);
        const wrongKek = await VaultCrypto.deriveWrappingKey('wrong', salt, 50000);
        await expect(VaultCrypto.unwrapDEK(wrongKek, wrapped)).rejects.toBeTruthy();
    });

    it('recovery key round-trips, tolerant of formatting on re-entry', async () => {
        const dek = await VaultCrypto.generateDEK();
        const rk = VaultCrypto.generateRecoveryKey();
        const salt = VaultCrypto.randomBytes(16);
        const wrapped = await VaultCrypto.wrapDEK(
            await VaultCrypto.deriveWrappingKey(VaultCrypto.normalizeRecoveryKey(rk), salt, 50000), dek);
        // Re-enter lower-cased with spaces instead of dashes.
        const messy = rk.toLowerCase().replace(/-/g, '  ');
        const dek2 = await VaultCrypto.unwrapDEK(
            await VaultCrypto.deriveWrappingKey(VaultCrypto.normalizeRecoveryKey(messy), salt, 50000), wrapped);
        expect(await sameKey(dek, dek2)).toBe(true);
    });

    it('generates a 160-bit, grouped recovery key', () => {
        const rk = VaultCrypto.generateRecoveryKey();
        expect(VaultCrypto.normalizeRecoveryKey(rk)).toMatch(/^[0-9A-F]{40}$/);
        expect(rk).toContain('-');
    });
});
