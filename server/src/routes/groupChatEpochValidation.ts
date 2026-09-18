import type {
  GroupEpochTransitionClaim,
  GroupEpochTransitionPayload,
  PublicKey
} from '../../../shared/types';
import { verifySignedRequest } from '../utils/crypto';

type VerifyEpochClaim = (
  claim: GroupEpochTransitionClaim,
  publicKey: PublicKey
) => boolean;

export function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function parseGk2PublisherIdentityId(envelopeCiphertext: string): string | null {
  if (!envelopeCiphertext.startsWith('gk2:')) return null;
  const rest = envelopeCiphertext.slice('gk2:'.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  const publisherIdentityId = rest.slice(0, separator).trim();
  return publisherIdentityId || null;
}

export function validateGroupEpochTransitionClaim(params: {
  claim: GroupEpochTransitionClaim | undefined;
  chatId: string;
  epoch: number;
  previousEpoch: number | null;
  keyCommitment: string;
  proposerIdentityId: string;
  proposerDeviceId: string;
  proposerDevicePublicKey: PublicKey;
  verifyClaim?: VerifyEpochClaim;
}): { ok: true } | { ok: false; message: string } {
  const { claim } = params;
  if (!claim || claim.type !== 'grp:epoch-transition') {
    return { ok: false, message: 'signedEpochTransition is required' };
  }
  if (claim.signerId !== params.proposerDeviceId) {
    return { ok: false, message: 'Epoch transition signer mismatch' };
  }

  const payload = claim.payload as GroupEpochTransitionPayload | undefined;
  const matches =
    payload?.version === 1
    && payload?.purpose === 'group-epoch-transition-v1'
    && payload?.chatId === params.chatId
    && payload?.epoch === params.epoch
    && payload?.previousEpoch === params.previousEpoch
    && payload?.keyCommitment === params.keyCommitment
    && payload?.proposerIdentityId === params.proposerIdentityId
    && payload?.proposerDeviceId === params.proposerDeviceId;
  if (!matches) {
    return { ok: false, message: 'Epoch transition payload mismatch' };
  }

  const verifyClaim = params.verifyClaim || verifySignedRequest;
  if (!verifyClaim(claim, params.proposerDevicePublicKey)) {
    return { ok: false, message: 'Invalid epoch transition signature' };
  }
  return { ok: true };
}
