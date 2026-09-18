import { identityRepository, inviteRepository } from '../db/repositories';
import type { FindByTokenResult } from '../db/repositories/inviteRepository.queries';
import type { IdentityId } from '../../../shared/types';

/**
 * Check if invite is valid
 */
export function isInviteValid(invite: FindByTokenResult): boolean {
  if (invite.status !== 'active') {
    return false;
  }

  const now = new Date();
  if (now >= invite.expires_at) {
    return false;
  }

  if (invite.used_count >= invite.max_uses) {
    return false;
  }

  return true;
}

export async function isInviteCreatorActive(invite: FindByTokenResult): Promise<boolean> {
  if (invite.created_by === 'system') return true;
  const creator = await identityRepository.findByIdentityId(invite.family_id, invite.created_by as IdentityId);
  return creator?.status === 'active';
}

/**
 * Use an invite (increment usage and update status if exhausted)
 */
export async function useInvite(invite: FindByTokenResult): Promise<boolean> {
  if (!isInviteValid(invite)) {
    return false;
  }

  const familyId = invite.family_id;

  // Increment used count
  await inviteRepository.incrementUsedCount(familyId, invite.invite_id);

  // If this was the last use, mark as exhausted
  if (invite.used_count + 1 >= invite.max_uses) {
    await inviteRepository.updateStatus(familyId, invite.invite_id, 'exhausted');
  }

  return true;
}

/**
 * Validate and use invite by token
 */
export async function validateAndUseInviteToken(familyId: string, token: string): Promise<boolean> {
  const invite = await inviteRepository.findByToken(familyId, token);

  if (!invite) {
    return false;
  }

  return useInvite(invite);
}
