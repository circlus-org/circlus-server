import crypto from 'crypto';

// Context string for HKDF - versioned so we can change the scheme later
const HKDF_INFO = Buffer.from('circlus-push-encryption-v1', 'utf8');

export type EncryptedPushEnvelope = {
  // Encrypted payload wrapper sent to notification_central inside the normal payload field.
  // android_client detects this by checking payload.type === 'encrypted'.
  type: 'encrypted';
  // Encryption scheme version - allows future migration to hybrid PQC (v2)
  v: 1;
  // Ephemeral X25519 public key (DER SPKI, base64) used for this message
  epk: string;
  // HKDF salt (base64)
  salt: string;
  // AES-256-GCM nonce (base64)
  iv: string;
  // GCM authentication tag (base64)
  tag: string;
  // Ciphertext (base64)
  ct: string;
};

/**
 * Encrypt a push payload for a specific device using X25519 ECDH + HKDF-SHA256 + AES-256-GCM.
 *
 * @param deviceX25519PublicKeyBase64 - Device's X25519 public key in DER SPKI format, base64-encoded.
 *   Registered by android_client at endpoint registration time.
 * @param payload - The PushPayload object to encrypt.
 * @returns An EncryptedPushEnvelope to be sent in place of the plaintext payload.
 */
export function encryptPushPayload(
  deviceX25519PublicKeyBase64: string,
  payload: object
): EncryptedPushEnvelope {
  const devicePublicKeyDer = Buffer.from(deviceX25519PublicKeyBase64, 'base64');
  const devicePublicKey = crypto.createPublicKey({
    key: devicePublicKeyDer,
    format: 'der',
    type: 'spki'
  });

  const ephemeralKeyPair = crypto.generateKeyPairSync('x25519');

  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeralKeyPair.privateKey,
    publicKey: devicePublicKey
  });

  const salt = crypto.randomBytes(32);
  const derivedKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, 32)
  );

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const ephemeralPublicKeyDer = ephemeralKeyPair.publicKey.export({ format: 'der', type: 'spki' });

  return {
    type: 'encrypted',
    v: 1,
    epk: Buffer.from(ephemeralPublicKeyDer).toString('base64'),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ciphertext.toString('base64')
  };
}
