import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, decodeUTF8 } from 'tweetnacl-util';
import type { PublicKey, SignedRequest } from '../../../shared/types';
import { createSignatureMessage } from '../../../shared/signatureMessage';
import { getRequestLogger } from '../middleware/requestContext';

/**
 * Verify Ed25519 signature
 */
export function verifySignature(
  message: string,
  signature: string,
  publicKey: PublicKey
): boolean {
  if (publicKey.algorithm !== 'ed25519') {
    throw new Error('Only Ed25519 signatures are supported');
  }

  try {
    const messageBytes = decodeUTF8(message);
    const signatureBytes = decodeBase64(signature);
    const publicKeyBytes = decodeBase64(publicKey.value);

    return nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes
    );
  } catch (error) {
    getRequestLogger({ subsystem: 'cryptography' }).warn('signature_verification_failed', { error });
    return false;
  }
}

/**
 * Verify signed request
 */
export function verifySignedRequest<T>(
  request: SignedRequest<T>,
  devicePublicKey: PublicKey
): boolean {
  const { signature, ...rest } = request;
  const message = createSignatureMessage(rest);
  return verifySignature(message, signature, devicePublicKey);
}

/**
 * Generate random nonce
 */
export function generateNonce(): string {
  return encodeBase64(nacl.randomBytes(32));
}

/**
 * Compute identityId ("fingerprint" / identity_id) from public key
 */
export function computeFingerprint(publicKey: PublicKey): string {
  const publicKeyBytes = decodeBase64(publicKey.value);
  const hash = nacl.hash(publicKeyBytes);

  // Return first 32 bytes as hex
  return Array.from(hash.slice(0, 32))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Format identityId for display (groups of 4)
 */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(' ') || fingerprint;
}
