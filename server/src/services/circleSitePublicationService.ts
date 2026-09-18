import {
  circleSitePublicationAssetRepository,
  circleSitePublicationRepository,
  type CircleSitePublicationBodyFormat,
  type DBCircleSitePublication,
} from '../db/repositories';
import { transaction } from '../db';
import { publicSiteGeneratorService } from './publicSiteGeneratorService';

export class PublicationAssetsNotReadyError extends Error {}
export class PublicationAlreadyPublishedError extends Error {}
export class PublicationStateChangedError extends Error {}

export type PublishChannelPostInput = {
  familyId: string;
  channelId: string;
  sourceLinkId?: string | null;
  sourceChannelPostId: string;
  authorIdentityId: string;
  title: string;
  summary?: string | null;
  body: string;
  bodyFormat: CircleSitePublicationBodyFormat;
  assetIds: string[];
  existingPublishedBehavior: 'reject' | 'return';
};

/**
 * Owns the publication transaction for every route that turns a channel
 * post into public content. The supplied asset list is always interpreted
 * as the complete desired state, including an empty list for text-only posts.
 */
export class CircleSitePublicationService {
  async publishChannelPost(
    input: PublishChannelPostInput
  ): Promise<DBCircleSitePublication> {
    const slug = await publicSiteGeneratorService.generateUniqueSlug(input.familyId, input.title);
    let changed = false;

    const publication = await transaction(async (client) => {
      const existing = await circleSitePublicationRepository.findBySourceChannelPostForUpdate(
        input.familyId,
        input.sourceChannelPostId,
        client
      );
      if (existing?.status === 'published') {
        if (input.existingPublishedBehavior === 'return') return existing;
        throw new PublicationAlreadyPublishedError();
      }
      if (existing && existing.status !== 'unpublished') {
        throw new PublicationStateChangedError();
      }

      const target = existing
        ? await circleSitePublicationRepository.update(
            input.familyId,
            existing.publication_id,
            {
              title: input.title,
              summary: input.summary ?? null,
              body: input.body,
              bodyFormat: input.bodyFormat,
            },
            client
          )
        : await circleSitePublicationRepository.create({
            familyId: input.familyId,
            channelId: input.channelId,
            sourceLinkId: input.sourceLinkId ?? null,
            sourceChannelPostId: input.sourceChannelPostId,
            authorIdentityId: input.authorIdentityId,
            slug,
            title: input.title,
            summary: input.summary ?? null,
            body: input.body,
            bodyFormat: input.bodyFormat,
          }, client);
      if (!target) throw new PublicationStateChangedError();

      const attachedAssets = await circleSitePublicationAssetRepository.replaceForPublication({
        familyId: input.familyId,
        publicationId: target.publication_id,
        sourceChannelPostId: input.sourceChannelPostId,
        uploaderIdentityId: input.authorIdentityId,
        assetIds: input.assetIds,
      }, client);
      if (attachedAssets === null) throw new PublicationAssetsNotReadyError();

      changed = true;
      if (!existing) return target;
      const republished = await circleSitePublicationRepository.setStatus(
        input.familyId,
        target.publication_id,
        'published',
        client
      );
      if (!republished) throw new PublicationStateChangedError();
      return republished;
    });

    if (changed) {
      await publicSiteGeneratorService.regenerateSite(input.familyId);
    }
    return publication;
  }
}

export const circleSitePublicationService = new CircleSitePublicationService();
