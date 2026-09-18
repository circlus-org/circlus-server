import nacl from 'tweetnacl';
import {
  auditDeviceEncryptionPublicKey,
  convertEd25519PublicKeyToX25519,
  decodeBase64PublicKey,
  hasDeviceRegistrationAttestationShape
} from './deviceEncryptionKeyAudit';

describe('device encryption key audit', () => {
  const signingKeyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));

  it('recognizes a device encryption key derived from the signing key', () => {
    const derived = convertEd25519PublicKeyToX25519(signingKeyPair.publicKey);
    expect(derived).not.toBeNull();
    expect(auditDeviceEncryptionPublicKey(
      Buffer.from(signingKeyPair.publicKey).toString('base64'),
      Buffer.from(derived!).toString('base64')
    )).toBe('derived-legacy');
  });

  it('recognizes an independent device encryption key', () => {
    const independent = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(11));
    expect(auditDeviceEncryptionPublicKey(
      Buffer.from(signingKeyPair.publicKey).toString('base64'),
      Buffer.from(independent.publicKey).toString('base64')
    )).toBe('independent');
  });

  it('rejects malformed or incorrectly sized public keys', () => {
    expect(decodeBase64PublicKey('not base64')).toBeNull();
    expect(decodeBase64PublicKey(Buffer.alloc(31).toString('base64'))).toBeNull();
    expect(auditDeviceEncryptionPublicKey('bad', 'bad')).toBe('invalid');
  });

  it('requires all current registration attestation sections', () => {
    expect(hasDeviceRegistrationAttestationShape({
      version: 1,
      identitySignedRequest: {},
      deviceKeyBinding: {}
    })).toBe(true);
    expect(hasDeviceRegistrationAttestationShape({
      version: 1,
      identitySignedRequest: {}
    })).toBe(false);
    expect(hasDeviceRegistrationAttestationShape({
      version: 1,
      identitySignedRequest: 'signed',
      deviceKeyBinding: 'bound'
    })).toBe(false);
    expect(hasDeviceRegistrationAttestationShape(null)).toBe(false);
  });
});
