import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { createOpaqueClaimToken, hashClaimToken } from '../utils/claimTokens';
import { getCircleMigrationRuntimeConfig } from '../config/serverRuntimeConfig';

export interface MigrationSessionEnvelope {
  algorithm: 'x25519-xsalsa20-poly1305';
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
}

export interface MigrationSessionCredentials {
  sessionToken: string;
  sessionKey: string;
}

export interface EncryptedMigrationSecret extends Record<string, unknown> {
  algorithm: 'aes-256-gcm';
  version: 1;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface EncryptedMigrationChunk {
  algorithm: 'xchacha20-poly1305';
  nonce: string;
  ciphertext: string;
  authTag: string;
}

export function migrationChunkAssociatedData(params: {
  migrationSlotId: string;
  migrationId: string;
  filePath: string;
  chunkIndex: number;
  chunkCount: number;
}): string {
  return canonicalizeChunkMetadata(params);
}

function canonicalizeChunkMetadata(value: {
  migrationSlotId: string;
  migrationId: string;
  filePath: string;
  chunkIndex: number;
  chunkCount: number;
}): string {
  return JSON.stringify({
    chunkCount: value.chunkCount,
    chunkIndex: value.chunkIndex,
    filePath: value.filePath,
    migrationId: value.migrationId,
    migrationSlotId: value.migrationSlotId
  });
}

function decodeFixedBase64(value: string, expectedLength: number, label: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(value);
  } catch {
    throw new Error(`${label} must be valid base64`);
  }
  if (decoded.length !== expectedLength) {
    throw new Error(`${label} must contain ${expectedLength} bytes`);
  }
  return decoded;
}

export function validateMigrationPublicKey(
  key: unknown,
  algorithm: 'ed25519' | 'x25519',
  label: string
): { algorithm: 'ed25519' | 'x25519'; value: string } {
  if (!key || typeof key !== 'object') {
    throw new Error(`${label} is required`);
  }
  const record = key as Record<string, unknown>;
  if (record.algorithm !== algorithm || typeof record.value !== 'string') {
    throw new Error(`${label} must use ${algorithm}`);
  }
  decodeFixedBase64(record.value, 32, label);
  return { algorithm, value: record.value };
}

export function createMigrationSession(sourceSessionPublicKeyBase64: string): {
  token: string;
  tokenHash: string;
  sessionKey: string;
  sessionKeyHash: string;
  envelope: MigrationSessionEnvelope;
} {
  const sourcePublicKey = decodeFixedBase64(sourceSessionPublicKeyBase64, nacl.box.publicKeyLength, 'sourceSessionPublicKey');
  const destinationEphemeralKeyPair = nacl.box.keyPair();
  const sessionKeyBytes = nacl.randomBytes(32);
  const token = createOpaqueClaimToken('msess');
  const sessionKey = encodeBase64(sessionKeyBytes);
  const credentials: MigrationSessionCredentials = {
    sessionToken: token,
    sessionKey
  };
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    Buffer.from(JSON.stringify(credentials), 'utf8'),
    nonce,
    sourcePublicKey,
    destinationEphemeralKeyPair.secretKey
  );

  return {
    token,
    tokenHash: hashClaimToken(token),
    sessionKey,
    sessionKeyHash: hashClaimToken(sessionKey),
    envelope: {
      algorithm: 'x25519-xsalsa20-poly1305',
      ephemeralPublicKey: encodeBase64(destinationEphemeralKeyPair.publicKey),
      nonce: encodeBase64(nonce),
      ciphertext: encodeBase64(ciphertext)
    }
  };
}

export function openMigrationSessionEnvelope(
  envelope: MigrationSessionEnvelope,
  sourceSessionSecretKeyBase64: string
): MigrationSessionCredentials {
  if (!envelope || envelope.algorithm !== 'x25519-xsalsa20-poly1305') {
    throw new Error('Unsupported migration session envelope');
  }
  const sourceSecretKey = decodeFixedBase64(
    sourceSessionSecretKeyBase64,
    nacl.box.secretKeyLength,
    'sourceSessionSecretKey'
  );
  const ephemeralPublicKey = decodeFixedBase64(
    envelope.ephemeralPublicKey,
    nacl.box.publicKeyLength,
    'ephemeralPublicKey'
  );
  const nonce = decodeFixedBase64(envelope.nonce, nacl.box.nonceLength, 'nonce');
  const ciphertext = decodeBase64(envelope.ciphertext);
  const plaintext = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, sourceSecretKey);
  if (!plaintext) {
    throw new Error('Migration session envelope authentication failed');
  }
  const parsed = JSON.parse(Buffer.from(plaintext).toString('utf8')) as Partial<MigrationSessionCredentials>;
  if (
    typeof parsed.sessionToken !== 'string'
    || !parsed.sessionToken.startsWith('msess_')
    || typeof parsed.sessionKey !== 'string'
  ) {
    throw new Error('Migration session envelope payload is invalid');
  }
  decodeFixedBase64(parsed.sessionKey, 32, 'sessionKey');
  return {
    sessionToken: parsed.sessionToken,
    sessionKey: parsed.sessionKey
  };
}

function migrationSecretMasterKey(): Buffer {
  const raw = getCircleMigrationRuntimeConfig().secretKeyBase64 || '';
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    key = Buffer.alloc(0);
  }
  if (!raw || key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) {
    throw new Error('CIRCLE_MIGRATION_SECRET_KEY_BASE64 must contain exactly 32 base64-encoded bytes');
  }
  return key;
}

export function encryptMigrationSecret(value: unknown): EncryptedMigrationSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', migrationSecretMasterKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ]);
  return {
    algorithm: 'aes-256-gcm',
    version: 1,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
}

export function decryptMigrationSecret<T>(value: unknown): T {
  if (!value || typeof value !== 'object') {
    throw new Error('Encrypted migration secret is missing');
  }
  const encrypted = value as Partial<EncryptedMigrationSecret>;
  if (
    encrypted.algorithm !== 'aes-256-gcm'
    || encrypted.version !== 1
    || typeof encrypted.iv !== 'string'
    || typeof encrypted.ciphertext !== 'string'
    || typeof encrypted.authTag !== 'string'
  ) {
    throw new Error('Encrypted migration secret has an unsupported format');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    migrationSecretMasterKey(),
    Buffer.from(encrypted.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function quarterRound(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  state[a] = (state[a]! + state[b]!) >>> 0;
  state[d] = rotateLeft32((state[d]! ^ state[a]!) >>> 0, 16);
  state[c] = (state[c]! + state[d]!) >>> 0;
  state[b] = rotateLeft32((state[b]! ^ state[c]!) >>> 0, 12);
  state[a] = (state[a]! + state[b]!) >>> 0;
  state[d] = rotateLeft32((state[d]! ^ state[a]!) >>> 0, 8);
  state[c] = (state[c]! + state[d]!) >>> 0;
  state[b] = rotateLeft32((state[b]! ^ state[c]!) >>> 0, 7);
}

function hChaCha20(key: Buffer, noncePrefix: Buffer): Buffer {
  if (key.length !== 32 || noncePrefix.length !== 16) {
    throw new Error('HChaCha20 requires a 32-byte key and 16-byte nonce prefix');
  }
  const constants = Buffer.from('expand 32-byte k', 'ascii');
  const state = new Uint32Array(16);
  for (let index = 0; index < 4; index += 1) state[index] = constants.readUInt32LE(index * 4);
  for (let index = 0; index < 8; index += 1) state[index + 4] = key.readUInt32LE(index * 4);
  for (let index = 0; index < 4; index += 1) state[index + 12] = noncePrefix.readUInt32LE(index * 4);
  for (let round = 0; round < 10; round += 1) {
    quarterRound(state, 0, 4, 8, 12);
    quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14);
    quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15);
    quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13);
    quarterRound(state, 3, 4, 9, 14);
  }
  const output = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((wordIndex, outputIndex) => {
    output.writeUInt32LE(state[wordIndex]!, outputIndex * 4);
  });
  return output;
}

function xChaChaParameters(keyBase64: string, nonceBase64: string): {
  subkey: Buffer;
  nonce: Buffer;
} {
  const key = Buffer.from(decodeFixedBase64(keyBase64, 32, 'migrationChunkKey'));
  const nonce24 = Buffer.from(decodeFixedBase64(nonceBase64, 24, 'migrationChunkNonce'));
  const subkey = hChaCha20(key, nonce24.subarray(0, 16));
  const nonce = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  return { subkey, nonce };
}

export function encryptMigrationChunk(
  keyBase64: string,
  plaintext: Buffer,
  associatedData: string
): EncryptedMigrationChunk {
  const nonce24 = crypto.randomBytes(24);
  const { subkey, nonce } = xChaChaParameters(keyBase64, nonce24.toString('base64'));
  const cipher = crypto.createCipheriv('chacha20-poly1305', subkey, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(associatedData, 'utf8'), { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: 'xchacha20-poly1305',
    nonce: nonce24.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
}

export function decryptMigrationChunk(
  keyBase64: string,
  encrypted: EncryptedMigrationChunk,
  associatedData: string
): Buffer {
  if (encrypted?.algorithm !== 'xchacha20-poly1305') {
    throw new Error('Unsupported migration chunk encryption');
  }
  const { subkey, nonce } = xChaChaParameters(keyBase64, encrypted.nonce);
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('chacha20-poly1305', subkey, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(associatedData, 'utf8'), { plaintextLength: ciphertext.length });
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function timingSafeHashEquals(expectedHash: string | null | undefined, candidateSecret: string): boolean {
  if (!expectedHash || !candidateSecret) return false;
  const actualHash = hashClaimToken(candidateSecret);
  const expected = Buffer.from(expectedHash, 'utf8');
  const actual = Buffer.from(actualHash, 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
