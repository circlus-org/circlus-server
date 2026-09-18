import { announcementChannelRepository } from '../db/repositories';
import type { PublicKey, SignedRequest } from '../../../shared/types';
import { verifySignedRequest } from '../utils/crypto';

export function buildPublicPublicationUrl(
  publicBaseUrl: string | null | undefined,
  channelSlug: string | null | undefined,
  publicationSlug: string | null | undefined
): string | undefined {
  if (!publicBaseUrl || !channelSlug || !publicationSlug) return undefined;
  return `${publicBaseUrl.replace(/\/$/, '')}/channels/${encodeURIComponent(channelSlug)}/posts/${encodeURIComponent(publicationSlug)}/`;
}

export function buildPublicChannelUrl(
  publicBaseUrl: string | null | undefined,
  channelSlug: string | null | undefined
): string | undefined {
  if (!publicBaseUrl || !channelSlug) return undefined;
  return `${publicBaseUrl.replace(/\/$/, '')}/channels/${encodeURIComponent(channelSlug)}/`;
}

export function channelPostResult(
  post: Awaited<ReturnType<typeof announcementChannelRepository.listPosts>>[number]
) {
  return {
    postId: post.post_id,
    channelId: post.channel_id,
    sequence: Number(post.post_sequence),
    authorIdentityId: post.author_identity_id,
    authorDeviceId: post.author_device_id,
    clientPostId: post.client_post_id,
    clientCreatedAt: post.client_created_at === null ? null : Number(post.client_created_at),
    epoch: Number(post.epoch),
    ciphertext: post.ciphertext,
    notificationPreviewCiphertext: post.notification_preview_ciphertext,
    authorSignature: post.author_signature,
    authorClaim: post.author_signed_claim,
    authorDevicePublicKey: post.author_device_public_key_algorithm && post.author_device_public_key_value
      ? { algorithm: post.author_device_public_key_algorithm, value: post.author_device_public_key_value }
      : null,
    authorDeviceEncryptionPublicKey: post.author_device_encryption_public_key_algorithm && post.author_device_encryption_public_key_value
      ? { algorithm: post.author_device_encryption_public_key_algorithm, value: post.author_device_encryption_public_key_value }
      : null,
    authorDeviceRegistrationAttestation: post.author_device_registration_attestation || null,
    authorIdentityPublicKey: post.author_identity_public_key_algorithm && post.author_identity_public_key_value
      ? { algorithm: post.author_identity_public_key_algorithm, value: post.author_identity_public_key_value }
      : null,
    revision: Number(post.revision),
    createdAt: post.created_at.toISOString(),
    updatedAt: post.updated_at.toISOString(),
    editedAt: post.edited_at?.toISOString() || null,
    deletedAt: post.deleted_at?.toISOString() || null
  };
}

export function validateChannelPostClaim(params: {
  claim: SignedRequest<Record<string, unknown>> | null | undefined;
  type: 'channel:post:create' | 'channel:post:edit';
  expectedPayload: Record<string, unknown>;
  deviceId: string;
  devicePublicKey: PublicKey;
}): boolean {
  const claim = params.claim;
  if (!claim || claim.type !== params.type || claim.signerId !== params.deviceId) return false;
  return JSON.stringify(claim.payload || {}) === JSON.stringify(params.expectedPayload)
    && verifySignedRequest(claim, params.devicePublicKey);
}
