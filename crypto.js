// crypto.js — password-derived encryption for the local vault.
//
// Model: the login password is stretched with PBKDF2-SHA256 into a 256-bit
// AES-GCM key. The investment blob is encrypted with that key before it ever
// touches localStorage, so data at rest (and every exported/backed-up copy)
// is ciphertext. Wrong password ⇒ GCM authentication fails ⇒ decrypt throws.
//
// Loads as a browser global `VaultCrypto`, and imports under Node (Web Crypto
// is available as globalThis.crypto in Node 20+) for the test suite.
(function (root, factory) {
    const api = factory();
    root.VaultCrypto = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const subtle = () => (globalThis.crypto && globalThis.crypto.subtle);
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    // OWASP-recommended floor for PBKDF2-SHA256 (2023). Stored per-record so it
    // can be raised later without breaking existing vaults.
    const PBKDF2_ITERATIONS = 210000;

    // Chunked base64 — avoids call-stack overflow on large blobs (proof images).
    function bytesToB64(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }

    function b64ToBytes(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function randomBytes(n) {
        const a = new Uint8Array(n);
        globalThis.crypto.getRandomValues(a);
        return a;
    }

    /** Is real encryption available in this context? (Secure context + SubtleCrypto.) */
    function isSupported() {
        return !!subtle() && typeof globalThis.crypto.getRandomValues === 'function';
    }

    /** Derive an extractable AES-GCM key from a password + salt. */
    async function deriveKey(password, saltBytes, iterations) {
        const baseKey = await subtle().importKey(
            'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
        );
        return subtle().deriveKey(
            { name: 'PBKDF2', salt: saltBytes, iterations: iterations || PBKDF2_ITERATIONS, hash: 'SHA-256' },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            true, // extractable: allows stashing the key (as JWK) in sessionStorage for reloads
            ['encrypt', 'decrypt']
        );
    }

    /** Encrypt a JSON-serializable value → { v, iv, ct } (base64). */
    async function encryptJSON(key, obj) {
        const iv = randomBytes(12);
        const ct = await subtle().encrypt(
            { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))
        );
        return { v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) };
    }

    /** Decrypt a { v, iv, ct } blob. Throws if the key/password is wrong. */
    async function decryptJSON(key, blob) {
        const pt = await subtle().decrypt(
            { name: 'AES-GCM', iv: b64ToBytes(blob.iv) }, key, b64ToBytes(blob.ct)
        );
        return JSON.parse(dec.decode(pt));
    }

    /** True if a stored value looks like one of our encrypted blobs. */
    function isEncryptedBlob(value) {
        return !!value && typeof value === 'object'
            && typeof value.iv === 'string' && typeof value.ct === 'string';
    }

    async function exportKey(key) { return subtle().exportKey('jwk', key); }
    async function importKey(jwk) {
        return subtle().importKey('jwk', jwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    }

    return {
        PBKDF2_ITERATIONS, isSupported, randomBytes,
        bytesToB64, b64ToBytes, deriveKey, encryptJSON, decryptJSON,
        isEncryptedBlob, exportKey, importKey,
    };
});
