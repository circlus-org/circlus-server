import { announcementChannelRepository, identityRepository } from '../db/repositories';

export async function canReadAnnouncementChannel(
  familyId: string,
  channelId: string,
  identityId: string
): Promise<boolean> {
  const channel = await announcementChannelRepository.findById(familyId, channelId);
  if (!channel || channel.status !== 'active') return false;
  if (channel.owner_identity_id === identityId) return true;
  const identity = await identityRepository.findByIdentityId(familyId, identityId);
  if (identity?.status === 'active' && (identity.role === 'owner' || identity.role === 'member')) return true;
  const subscription = await announcementChannelRepository.findSubscriptionForIdentity(
    familyId,
    channelId,
    identityId
  );
  return subscription?.status === 'active';
}
