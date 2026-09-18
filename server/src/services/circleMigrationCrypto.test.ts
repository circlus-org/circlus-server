import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  createMigrationSession,
  decryptMigrationSecret,
  decryptMigrationChunk,
  encryptMigrationChunk,
  encryptMigrationSecret,
  openMigrationSessionEnvelope,
  timingSafeHashEquals,
  validateMigrationPublicKey
} from './circleMigrationCrypto';

describe('Circle migration session crypto', () => {
  const previousSecretKey = process.env.CIRCLE_MIGRATION_SECRET_KEY_BASE64;

  beforeEach(() => {
    process.env.CIRCLE_MIGRATION_SECRET_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
  });

  afterAll(() => {
    if (previousSecretKey === undefined) {
      delete process.env.CIRCLE_MIGRATION_SECRET_KEY_BASE64;
    } else {
      process.env.CIRCLE_MIGRATION_SECRET_KEY_BASE64 = previousSecretKey;
    }
  });

  it('encrypts recoverable session credentials to the source ephemeral X25519 key', () => {
    const source = nacl.box.keyPair();
    const session = createMigrationSession(encodeBase64(source.publicKey));
    const credentials = openMigrationSessionEnvelope(
      session.envelope,
      encodeBase64(source.secretKey)
    );

    expect(credentials.sessionToken).toBe(session.token);
    expect(credentials.sessionKey).toBe(session.sessionKey);
    expect(timingSafeHashEquals(session.tokenHash, session.token)).toBe(true);
    expect(timingSafeHashEquals(session.sessionKeyHash, credentials.sessionKey)).toBe(true);
  });

  it('encrypts durable source credentials with authenticated encryption', () => {
    const encrypted = encryptMigrationSecret({ sessionToken: 'token', sessionKey: 'key' });
    expect(decryptMigrationSecret(encrypted)).toEqual({ sessionToken: 'token', sessionKey: 'key' });
    expect(() => decryptMigrationSecret({ ...encrypted, ciphertext: 'AAAA' })).toThrow();
  });

  it('encrypts migration chunks with XChaCha20-Poly1305 and bound metadata', () => {
    const key = Buffer.alloc(32, 11).toString('base64');
    const plaintext = Buffer.from('migration-jsonl-chunk');
    const encrypted = encryptMigrationChunk(key, plaintext, 'slot:file:0');
    expect(decryptMigrationChunk(key, encrypted, 'slot:file:0')).toEqual(plaintext);
    expect(() => decryptMigrationChunk(key, encrypted, 'slot:file:1')).toThrow();
    expect(() => decryptMigrationChunk(key, {
      ...encrypted,
      ciphertext: Buffer.from('tampered').toString('base64')
    }, 'slot:file:0')).toThrow();
  });

  it('rejects malformed or wrong-algorithm public keys', () => {
    const valid = encodeBase64(nacl.randomBytes(32));
    expect(validateMigrationPublicKey({ algorithm: 'ed25519', value: valid }, 'ed25519', 'owner')).toEqual({
      algorithm: 'ed25519',
      value: valid
    });
    expect(() => validateMigrationPublicKey(
      { algorithm: 'x25519', value: valid },
      'ed25519',
      'owner'
    )).toThrow('owner must use ed25519');
    expect(() => validateMigrationPublicKey(
      { algorithm: 'ed25519', value: encodeBase64(nacl.randomBytes(31)) },
      'ed25519',
      'owner'
    )).toThrow('owner must contain 32 bytes');
  });
});
