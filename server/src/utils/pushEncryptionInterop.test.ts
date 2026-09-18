import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

type PushVector = {
  devicePrivateKeyRaw: string;
  plaintext: string;
  envelope: {
    epk: string;
    salt: string;
    iv: string;
    tag: string;
    ct: string;
  };
};

describe('mobile push encryption interoperability', () => {
  test('shared X25519/HKDF/AES-GCM vector decrypts with the server protocol', () => {
    const vector = JSON.parse(
      readFileSync(resolve(process.cwd(), '../shared/test-vectors/mobile-push-encryption-v1.json'), 'utf8')
    ) as PushVector;
    const pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
    const devicePrivateKey = crypto.createPrivateKey({
      key: Buffer.concat([pkcs8Prefix, Buffer.from(vector.devicePrivateKeyRaw, 'base64')]),
      format: 'der',
      type: 'pkcs8'
    });
    const ephemeralPublicKey = crypto.createPublicKey({
      key: Buffer.from(vector.envelope.epk, 'base64'),
      format: 'der',
      type: 'spki'
    });
    const sharedSecret = crypto.diffieHellman({
      privateKey: devicePrivateKey,
      publicKey: ephemeralPublicKey
    });
    const key = Buffer.from(crypto.hkdfSync(
      'sha256',
      sharedSecret,
      Buffer.from(vector.envelope.salt, 'base64'),
      Buffer.from('circlus-push-encryption-v1', 'utf8'),
      32
    ));
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(vector.envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(vector.envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(vector.envelope.ct, 'base64')),
      decipher.final()
    ]).toString('utf8');

    expect(plaintext).toBe(vector.plaintext);
  });
});
