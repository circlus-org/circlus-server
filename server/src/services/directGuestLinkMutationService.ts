import { transaction } from '../db';
import {
  announcementChannelRepository,
  directGuestLinkRepository
} from '../db/repositories';
import type { AnnouncementChannelRecord } from '../db/repositories/announcementChannelRepository';
import { publicSiteGeneratorService } from './publicSiteGeneratorService';

type DirectGuestLinkCreateInput = Parameters<typeof directGuestLinkRepository.create>[0];

export class DirectGuestLinkMutationError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'INVALID_REQUEST' | 'NOT_FOUND',
    message: string
  ) {
    super(message);
  }
}

export async function createDirectGuestLink(params: {
  link: DirectGuestLinkCreateInput;
  requestedChannelId: string | null;
}) {
  if (params.link.autoSubscribeToChannel && !params.requestedChannelId) {
    throw new DirectGuestLinkMutationError(
      400,
      'INVALID_REQUEST',
      'An existing channel is required for channel subscription'
    );
  }
  if (params.link.publicSiteVisible && !params.link.autoSubscribeToChannel) {
    throw new DirectGuestLinkMutationError(
      400,
      'INVALID_REQUEST',
      'A public guest link requires explicit channel subscription'
    );
  }

  const outcome = await transaction(async (client) => {
    const created = await directGuestLinkRepository.create(params.link, client);
    let announcementChannel: AnnouncementChannelRecord | null = null;

    if (params.link.autoSubscribeToChannel && params.requestedChannelId) {
      announcementChannel = await announcementChannelRepository.attachLink({
        familyId: params.link.familyId,
        channelId: params.requestedChannelId,
        linkId: created.link_id,
        ownerIdentityId: params.link.hostIdentityId
      }, client);
      if (!announcementChannel) {
        throw new DirectGuestLinkMutationError(
          400,
          'INVALID_REQUEST',
          'The selected channel is not available for this guest link'
        );
      }
    }

    if (announcementChannel && params.link.publicSiteVisible) {
      await announcementChannelRepository.updatePublicSite({
        familyId: params.link.familyId,
        channelId: announcementChannel.channel_id,
        visible: true,
        slug: params.link.publicSiteChannelSlug ?? null,
        ctaLabel: params.link.publicSiteCtaLabel ?? null,
        introTitle: params.link.publicSiteIntroTitle ?? null,
        introText: params.link.publicSiteIntroText ?? null,
        introImageUrl: params.link.publicSiteIntroImageUrl ?? null,
        guestLinkId: created.link_id
      }, client);
    }
    return { created, announcementChannel };
  });

  if (params.link.publicSiteVisible) {
    await publicSiteGeneratorService.regenerateSite(params.link.familyId);
  }
  return outcome;
}

export async function revokeDirectGuestLink(params: {
  familyId: string;
  linkId: string;
  hostIdentityId: string;
}) {
  const outcome = await transaction(async (client) => {
    const revoked = await directGuestLinkRepository.revoke(
      params.familyId,
      params.linkId,
      params.hostIdentityId,
      client
    );
    if (!revoked) return null;

    const linkedChannel = revoked.public_site_visible
      ? null
      : await announcementChannelRepository.findByLink(params.familyId, params.linkId, client);
    await announcementChannelRepository.clearPublicGuestLink(params.familyId, params.linkId, client);
    return { revoked, linkedChannel };
  });

  if (!outcome) {
    throw new DirectGuestLinkMutationError(404, 'NOT_FOUND', 'Direct guest link not found');
  }
  if (outcome.revoked.public_site_visible || outcome.linkedChannel?.public_site_visible) {
    await publicSiteGeneratorService.regenerateSite(params.familyId);
  }
  return outcome;
}
