import type {
  DeviceId,
  DirectEpochTransitionClaim,
  IdentityId
} from '../../../shared/types';
import { transaction } from '../db';
import { messageRepository } from '../db/repositories';

export class DirectKeyEpochPersistenceError extends Error {
  constructor(readonly kind: 'epoch_state_conflict' | 'commitment_conflict') {
    super(kind);
  }
}

export async function claimAndPublishDirectEpochKey(params: {
  familyId: string;
  directChatId: string;
  epoch: number;
  keyCommitment: string;
  proposerIdentityId: IdentityId;
  proposerDeviceId: DeviceId;
  signedEpochTransition: DirectEpochTransitionClaim;
  envelopes: Array<{ identityId: IdentityId; envelopeCiphertext: string }>;
  advanceEpoch: boolean;
}) {
  return transaction(async (client) => {
    if (params.advanceEpoch) {
      const advancedEpoch = await messageRepository.ensureDirectEpochState(
        params.familyId,
        params.directChatId,
        params.epoch,
        client
      );
      if (advancedEpoch !== params.epoch) {
        throw new DirectKeyEpochPersistenceError('epoch_state_conflict');
      }
    }

    const claim = await messageRepository.claimDirectEpochKey({
      familyId: params.familyId,
      directChatId: params.directChatId,
      epoch: params.epoch,
      keyCommitment: params.keyCommitment,
      proposerIdentityId: params.proposerIdentityId,
      proposerDeviceId: params.proposerDeviceId,
      signedEpochTransition: params.signedEpochTransition
    }, client);
    if (claim.existing && claim.existing.key_commitment !== params.keyCommitment) {
      throw new DirectKeyEpochPersistenceError('commitment_conflict');
    }

    for (const envelope of params.envelopes) {
      await messageRepository.upsertDirectKeyEnvelope({
        familyId: params.familyId,
        directChatId: params.directChatId,
        epoch: params.epoch,
        identityId: envelope.identityId,
        envelopeCiphertext: envelope.envelopeCiphertext,
        publisherIdentityId: params.proposerIdentityId
      }, client);
    }
    return claim;
  });
}
