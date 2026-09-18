import { transaction } from '../db';
import { announcementChannelRepository } from '../db/repositories';

export class AnnouncementChannelKeyEpochPersistenceError extends Error {
  constructor(readonly kind: 'commitment_conflict') {
    super(kind);
  }
}

export async function claimAndPublishAnnouncementChannelEpochKey(params: {
  familyId: string;
  channelId: string;
  epoch: number;
  keyCommitment: string;
  proposerIdentityId: string;
  proposerDeviceId: string;
  signedEpochTransition: unknown;
  membershipStateId: string;
  envelopes: Array<{ identityId: string; envelopeCiphertext: string }>;
}) {
  return transaction(async (client) => {
    const claimed = await announcementChannelRepository.claimEpochKey({
      familyId: params.familyId,
      channelId: params.channelId,
      epoch: params.epoch,
      keyCommitment: params.keyCommitment,
      proposerIdentityId: params.proposerIdentityId,
      proposerDeviceId: params.proposerDeviceId,
      signedEpochTransition: params.signedEpochTransition,
      membershipStateId: params.membershipStateId,
    }, client);
    if (claimed.key_commitment !== params.keyCommitment) {
      throw new AnnouncementChannelKeyEpochPersistenceError('commitment_conflict');
    }

    await announcementChannelRepository.upsertKeyEnvelopes({
      familyId: params.familyId,
      channelId: params.channelId,
      epoch: params.epoch,
      publisherIdentityId: params.proposerIdentityId,
      membershipStateId: params.membershipStateId,
      envelopes: params.envelopes
    }, client);
    return claimed;
  });
}
