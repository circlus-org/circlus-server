const CURVE_P = (1n << 255n) - 19n;

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function invertMod(value: bigint, modulus: bigint): bigint | null {
  let t = 0n;
  let nextT = 1n;
  let r = modulus;
  let nextR = mod(value, modulus);

  while (nextR !== 0n) {
    const quotient = r / nextR;
    [t, nextT] = [nextT, t - quotient * nextT];
    [r, nextR] = [nextR, r - quotient * nextR];
  }

  return r === 1n ? mod(t, modulus) : null;
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    result = (result << 8n) + BigInt(bytes[index]);
  }
  return result;
}

function bigIntToLittleEndian32(value: bigint): Uint8Array {
  const result = new Uint8Array(32);
  let remaining = mod(value, CURVE_P);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

export function decodeBase64PublicKey(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !value || /\s/.test(value)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) return null;
  const canonicalInput = value.replace(/=+$/, '');
  const canonicalDecoded = decoded.toString('base64').replace(/=+$/, '');
  return canonicalInput === canonicalDecoded ? new Uint8Array(decoded) : null;
}

/** Mirrors the Edwards-to-Montgomery conversion used by the client. */
export function convertEd25519PublicKeyToX25519(publicKey: Uint8Array): Uint8Array | null {
  if (publicKey.length !== 32) return null;

  const yBytes = publicKey.slice();
  yBytes[31] &= 0x7f;
  const y = littleEndianToBigInt(yBytes);
  if (y >= CURVE_P) return null;

  const denominatorInverse = invertMod(1n - y, CURVE_P);
  if (denominatorInverse === null) return null;
  return bigIntToLittleEndian32((1n + y) * denominatorInverse);
}

export type DeviceEncryptionKeyAuditResult = 'derived-legacy' | 'independent' | 'invalid';

export function hasDeviceRegistrationAttestationShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const hasObjectShape = (nested: unknown) => (
    Boolean(nested) && typeof nested === 'object' && !Array.isArray(nested)
  );
  return candidate.version === 1
    && hasObjectShape(candidate.identitySignedRequest)
    && hasObjectShape(candidate.deviceKeyBinding);
}

export function auditDeviceEncryptionPublicKey(
  signingPublicKeyBase64: unknown,
  encryptionPublicKeyBase64: unknown
): DeviceEncryptionKeyAuditResult {
  const signingPublicKey = decodeBase64PublicKey(signingPublicKeyBase64);
  const encryptionPublicKey = decodeBase64PublicKey(encryptionPublicKeyBase64);
  if (!signingPublicKey || !encryptionPublicKey) return 'invalid';

  const derivedEncryptionPublicKey = convertEd25519PublicKeyToX25519(signingPublicKey);
  if (!derivedEncryptionPublicKey) return 'invalid';
  return Buffer.from(derivedEncryptionPublicKey).equals(Buffer.from(encryptionPublicKey))
    ? 'derived-legacy'
    : 'independent';
}
