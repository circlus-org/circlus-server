import type { IdentityId, PublicKey } from './types';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32EncodeNoPadding(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base64ToBytes(b64: string): Uint8Array {
  // Node.js
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  // Browser
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function canonicalizePublicKey(publicKey: PublicKey): Uint8Array {
  // Per current protocol choice: identityId is derived from *raw public key bytes only*.
  // (No algorithm prefix / domain separation.)
  return base64ToBytes(publicKey.value);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle API is not available (requires Node 20+ or a modern browser)');
  }
  // Avoid DOM lib typing requirements (BufferSource) so this can compile under server tsconfig (no DOM lib).
  const digest = await subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

/**
 * Derive a stable identityId from an identity public key.
 *
 * Rule:
 *   identityId = base32( SHA-256( canonical_public_key ) )[0:26]
 *
 * Canonical public key is:
 *   rawPublicKeyBytes
 *
 * Base32 is RFC4648 alphabet, uppercase, no padding.
 */
export async function deriveIdentityIdFromPublicKey(publicKey: PublicKey): Promise<IdentityId> {
  const canonical = canonicalizePublicKey(publicKey);
  const hash = await sha256(canonical);
  const b32 = base32EncodeNoPadding(hash);
  return b32.slice(0, 26) as IdentityId;
}
