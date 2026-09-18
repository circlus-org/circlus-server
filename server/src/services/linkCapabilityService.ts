import type { PublicKey } from '../../../shared/types';
import type {
  LinkCapabilityDescriptor,
  LinkCapabilityKind,
  LinkCapabilityProof,
  LinkCapabilityProofAction,
  LinkCapabilityRevocation
} from '../../../shared/linkCapability';
import { deriveIdentityIdFromPublicKey } from '../../../shared/identityId';
import { verifySignedRequest } from '../utils/crypto';
import crypto from 'crypto';

function deriveCapabilityId(publicKey: PublicKey): string | null {
  if (publicKey.algorithm !== 'ed25519') return null;
  try {
    const bytes = Buffer.from(publicKey.value, 'base64');
    if (bytes.length !== 32) return null;
    const digest = crypto.createHash('sha256').update(bytes).digest().subarray(0, 18);
    return `cap_${digest.toString('base64url')}`;
  } catch {
    return null;
  }
}

export async function verifyCapabilityDescriptor(params: {
  descriptor: LinkCapabilityDescriptor;
  issuerPublicKey: PublicKey;
  expectedKind: LinkCapabilityKind;
  expectedIssuerIdentityId: string;
  expectedTargetIdentityId?: string;
}): Promise<boolean> {
  const { descriptor, issuerPublicKey } = params;
  const payload = descriptor?.payload;
  if (
    descriptor?.type !== 'link-capability:descriptor'
    || descriptor?.signerId !== params.expectedIssuerIdentityId
    || payload?.version !== 2
    || payload?.purpose !== 'circlus-link-capability-v2'
    || payload?.kind !== params.expectedKind
    || payload?.issuerIdentityId !== params.expectedIssuerIdentityId
    || (params.expectedTargetIdentityId && payload?.targetIdentityId !== params.expectedTargetIdentityId)
    || payload?.capabilityPublicKey?.algorithm !== 'ed25519'
    || !payload?.capabilityId
    || deriveCapabilityId(payload.capabilityPublicKey) !== payload.capabilityId
    || !Number.isFinite(new Date(payload.expiresAt).getTime())
    || new Date(payload.expiresAt).getTime() <= Date.now()
  ) return false;
  if (await deriveIdentityIdFromPublicKey(issuerPublicKey) !== params.expectedIssuerIdentityId) return false;
  return verifySignedRequest(descriptor, issuerPublicKey);
}

export function verifyCapabilityProof(params: {
  proof: LinkCapabilityProof;
  descriptor: LinkCapabilityDescriptor;
  expectedAction: LinkCapabilityProofAction;
  expectedSubjectIdentityId?: string;
  expectedSubjectPublicKey?: PublicKey;
}): boolean {
  const { proof, descriptor } = params;
  const payload = proof?.payload;
  if (
    proof?.type !== 'link-capability:proof'
    || proof?.signerId !== descriptor.payload.capabilityId
    || payload?.version !== 2
    || payload?.purpose !== 'circlus-link-capability-proof-v2'
    || payload?.action !== params.expectedAction
    || payload?.capabilityId !== descriptor.payload.capabilityId
    || payload?.targetIdentityId !== descriptor.payload.targetIdentityId
    || proof.signerId !== payload.capabilityId
    || (params.expectedSubjectIdentityId && payload?.subjectIdentityId !== params.expectedSubjectIdentityId)
    || (params.expectedSubjectPublicKey && (
      payload?.subjectPublicKey?.algorithm !== params.expectedSubjectPublicKey.algorithm
      || payload?.subjectPublicKey?.value !== params.expectedSubjectPublicKey.value
    ))
  ) return false;
  return verifySignedRequest(proof, descriptor.payload.capabilityPublicKey);
}

export function verifyCapabilityRevocation(params: {
  revocation: LinkCapabilityRevocation;
  issuerPublicKey: PublicKey;
  capabilityId: string;
  issuerIdentityId: string;
}): boolean {
  const payload = params.revocation?.payload;
  return Boolean(
    params.revocation?.type === 'link-capability:revoke'
    && params.revocation?.signerId === params.issuerIdentityId
    && payload?.version === 2
    && payload?.purpose === 'circlus-link-capability-revocation-v2'
    && payload?.capabilityId === params.capabilityId
    && payload?.issuerIdentityId === params.issuerIdentityId
    && Number.isFinite(new Date(payload.revokedAt).getTime())
    && verifySignedRequest(params.revocation, params.issuerPublicKey)
  );
}
