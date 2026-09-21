import crypto from 'crypto';
import nacl from 'tweetnacl';
import { createSignatureMessage } from '../../../shared/signatureMessage';
import { deriveIdentityIdFromPublicKey } from '../../../shared/identityId';
import type { PublicKey, SignedRequest } from '../../../shared/types';
import type {
  LinkCapabilityDescriptor,
  LinkCapabilityProof
} from '../../../shared/linkCapability';
import {
  verifyCapabilityDescriptor,
  verifyCapabilityProof
} from './linkCapabilityService';

function publicKey(bytes: Uint8Array): PublicKey {
  return { algorithm: 'ed25519', value: Buffer.from(bytes).toString('base64') };
}

function sign<T>(type: string, signerId: string, payload: T, secretKey: Uint8Array): SignedRequest<T> {
  const unsigned = { type, timestamp: Date.now(), nonce: crypto.randomBytes(24).toString('base64'), signerId, payload };
  const signature = nacl.sign.detached(
    Buffer.from(createSignatureMessage(unsigned), 'utf8'),
    secretKey
  );
  return { ...unsigned, signature: Buffer.from(signature).toString('base64') };
}

describe('link capability verification', () => {
  test('accepts a holder proof and rejects a changed subject or action', async () => {
    const issuerKeys = nacl.sign.keyPair();
    const capabilityKeys = nacl.sign.keyPair();
    const subjectKeys = nacl.sign.keyPair();
    const issuerPublicKey = publicKey(issuerKeys.publicKey);
    const subjectPublicKey = publicKey(subjectKeys.publicKey);
    const issuerIdentityId = await deriveIdentityIdFromPublicKey(issuerPublicKey);
    const subjectIdentityId = await deriveIdentityIdFromPublicKey(subjectPublicKey);
    const capabilityId = `cap_${crypto.createHash('sha256')
      .update(capabilityKeys.publicKey)
      .digest()
      .subarray(0, 18)
      .toString('base64url')}`;
    const descriptor = sign(
      'link-capability:descriptor',
      issuerIdentityId,
      {
        version: 2 as const,
        purpose: 'circlus-link-capability-v2' as const,
        capabilityId,
        kind: 'call-link' as const,
        mode: 'unlimited' as const,
        issuerIdentityId,
        targetIdentityId: issuerIdentityId,
        capabilityPublicKey: publicKey(capabilityKeys.publicKey),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scope: {}
      },
      issuerKeys.secretKey
    ) as LinkCapabilityDescriptor;
    const proof = sign(
      'link-capability:proof',
      capabilityId,
      {
        version: 2 as const,
        purpose: 'circlus-link-capability-proof-v2' as const,
        capabilityId,
        action: 'call-link:call' as const,
        targetIdentityId: issuerIdentityId,
        subjectIdentityId,
        subjectPublicKey,
        context: { callSessionId: 'call_1' }
      },
      capabilityKeys.secretKey
    ) as LinkCapabilityProof;

    await expect(verifyCapabilityDescriptor({
      descriptor,
      issuerPublicKey,
      expectedKind: 'call-link',
      expectedIssuerIdentityId: issuerIdentityId,
      expectedTargetIdentityId: issuerIdentityId
    })).resolves.toBe(true);
    expect(verifyCapabilityProof({
      proof,
      descriptor,
      expectedAction: 'call-link:call',
      expectedSubjectIdentityId: subjectIdentityId,
      expectedSubjectPublicKey: subjectPublicKey
    })).toBe(true);
    expect(verifyCapabilityProof({
      proof,
      descriptor,
      expectedAction: 'call-link:register',
      expectedSubjectIdentityId: subjectIdentityId,
      expectedSubjectPublicKey: subjectPublicKey
    })).toBe(false);
    expect(verifyCapabilityProof({
      proof,
      descriptor,
      expectedAction: 'call-link:call',
      expectedSubjectIdentityId: 'another-identity',
      expectedSubjectPublicKey: subjectPublicKey
    })).toBe(false);
  });

  test('rejects legacy V1 capability descriptors and proofs', async () => {
    const issuerKeys = nacl.sign.keyPair();
    const capabilityKeys = nacl.sign.keyPair();
    const subjectKeys = nacl.sign.keyPair();
    const issuerPublicKey = publicKey(issuerKeys.publicKey);
    const subjectPublicKey = publicKey(subjectKeys.publicKey);
    const issuerIdentityId = await deriveIdentityIdFromPublicKey(issuerPublicKey);
    const subjectIdentityId = await deriveIdentityIdFromPublicKey(subjectPublicKey);
    const capabilityId = `cap_${crypto.createHash('sha256')
      .update(capabilityKeys.publicKey)
      .digest()
      .subarray(0, 18)
      .toString('base64url')}`;
    const descriptor = sign(
      'link-capability:descriptor',
      issuerIdentityId,
      {
        version: 2 as const,
        purpose: 'circlus-link-capability-v2' as const,
        capabilityId,
        kind: 'direct-guest' as const,
        mode: 'unlimited' as const,
        issuerIdentityId,
        targetIdentityId: issuerIdentityId,
        capabilityPublicKey: publicKey(capabilityKeys.publicKey),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scope: {}
      },
      issuerKeys.secretKey
    ) as LinkCapabilityDescriptor;
    const proof = sign(
      'link-capability:proof',
      capabilityId,
      {
        version: 2 as const,
        purpose: 'circlus-link-capability-proof-v2' as const,
        capabilityId,
        action: 'direct-guest:register' as const,
        targetIdentityId: issuerIdentityId,
        subjectIdentityId,
        subjectPublicKey,
        context: {}
      },
      capabilityKeys.secretKey
    ) as LinkCapabilityProof;

    await expect(verifyCapabilityDescriptor({
      descriptor: {
        ...descriptor,
        payload: { ...descriptor.payload, version: 1, purpose: 'circlus-link-capability-v1' }
      } as unknown as LinkCapabilityDescriptor,
      issuerPublicKey,
      expectedKind: 'direct-guest',
      expectedIssuerIdentityId: issuerIdentityId,
      expectedTargetIdentityId: issuerIdentityId
    })).resolves.toBe(false);

    expect(verifyCapabilityProof({
      proof: {
        ...proof,
        payload: { ...proof.payload, version: 1, purpose: 'circlus-link-capability-proof-v1' }
      } as unknown as LinkCapabilityProof,
      descriptor,
      expectedAction: 'direct-guest:register',
      expectedSubjectIdentityId: subjectIdentityId,
      expectedSubjectPublicKey: subjectPublicKey
    })).toBe(false);
  });
});
