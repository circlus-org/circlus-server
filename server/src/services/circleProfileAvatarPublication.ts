import { createHash } from 'node:crypto';

export function circleProfileAvatarBlobId(
  identityId: string,
  publicationId: string
): string {
  return `av_${createHash('sha256')
    .update(`circlus-circle-profile-avatar-v1\u0000${identityId}\u0000${publicationId}`)
    .digest('base64url')
    .slice(0, 28)}`;
}
