import type {
  DeviceId,
  GroupEpochTransitionClaim,
  IdentityId
} from '../../../shared/types';
import { transaction } from '../db';
import { groupChatRepository } from '../db/repositories';

export class GroupChatKeyEpochPersistenceError extends Error {
  constructor(readonly kind: 'commitment_conflict') {
    super(kind);
  }
}

export async function claimAndPublishGroupChatEpochKey(params: {
  familyId: string;
  chatId: string;
  epoch: number;
  keyCommitment: string;
  proposerIdentityId: IdentityId;
  proposerDeviceId: DeviceId;
  signedEpochTransition: GroupEpochTransitionClaim;
  envelopes: Array<{ identityId: string; envelopeCiphertext: string }>;
  titleCiphertext: string;
  now?: number;
}) {
  const now = params.now ?? Date.now();
  return transaction(async (client) => {
    const claim = await groupChatRepository.claimEpochKey({
      familyId: params.familyId,
      chatId: params.chatId,
      epoch: params.epoch,
      keyCommitment: params.keyCommitment,
      proposerIdentityId: params.proposerIdentityId,
      proposerDeviceId: params.proposerDeviceId,
      signedEpochTransition: params.signedEpochTransition,
      createdAt: now
    }, client);
    if (!claim.won && claim.existing?.key_commitment !== params.keyCommitment) {
      throw new GroupChatKeyEpochPersistenceError('commitment_conflict');
    }

    await groupChatRepository.upsertKeyEnvelopes({
      familyId: params.familyId,
      chatId: params.chatId,
      epoch: params.epoch,
      createdAt: now,
      envelopes: params.envelopes.map((envelope) => ({
        ...envelope,
        publisherIdentityId: params.proposerIdentityId
      }))
    }, client);
    if (params.titleCiphertext) {
      await groupChatRepository.renameChat(
        params.familyId,
        params.chatId,
        params.titleCiphertext,
        now,
        client
      );
    }
    return claim;
  });
}
