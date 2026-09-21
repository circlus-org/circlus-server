import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  circleSiteSettingsRepository,
  circleSitePublicationAssetRepository,
  circleSitePublicationRepository,
  announcementChannelRepository,
  familyDomainRepository,
} from '../db/repositories';
import { configService } from './configService';
import { getPublicSiteProductUrl, isBlockedManagedHost } from '../utils/publicSiteDomainPolicy';
import { normalizeSelfHostedPublicSiteImageUrl } from '../utils/publicSiteImageUrl';
import {
  slugify,
  renderPublicationBodyToHtml,
  buildHomepageHtml,
  buildChannelHtml,
  buildPostHtml,
  buildSitemapXml,
  buildRobotsTxt,
  buildFeedJson,
  buildPublicationTimeScript,
  type SiteChannel,
  type SitePost,
  type SiteRenderContext,
} from './publicSiteRenderer';
import { getStorageRuntimeConfig } from '../config/serverRuntimeConfig';

export interface ResolvedSiteConfig {
  familyId: string;
  enabled: boolean;
  indexingEnabled: boolean;
  siteTitle: string;
  siteDescription: string | null;
  coverImageUrl: string | null;
  theme: string;
}

export interface PublicSiteGenerationReport {
  status: 'generated' | 'site_disabled';
  channelCount: number;
  publicationCount: number;
  generatedFileCount: number;
  canonicalBaseUrl: string;
}

export class PublicSiteGeneratorService {
  private readonly regenerationQueues = new Map<string, Promise<void>>();

  private get rootDir(): string {
    return getStorageRuntimeConfig().publicSite.rootDir;
  }

  private get tmpDir(): string {
    return path.join(this.rootDir, '_tmp');
  }

  async ensureDirectories(): Promise<void> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
  }

  siteDir(familyId: string): string {
    return path.join(this.rootDir, familyId);
  }

  async getResolvedSiteConfig(familyId: string): Promise<ResolvedSiteConfig> {
    const settings = await circleSiteSettingsRepository.findByFamilyId(familyId);
    const serverName = await configService.getServerName(familyId);
    return {
      familyId,
      enabled: settings?.enabled ?? false,
      indexingEnabled: settings?.indexing_enabled ?? false,
      siteTitle: settings?.site_title || serverName || 'Public Circle Site',
      siteDescription: settings?.site_description ?? null,
      coverImageUrl: normalizeSelfHostedPublicSiteImageUrl(settings?.cover_image_url),
      theme: settings?.theme || 'default',
    };
  }

  /** Derives a family-unique post slug from a title, appending -2, -3, ... on collision. */
  async generateUniqueSlug(familyId: string, title: string): Promise<string> {
    const base = slugify(title);
    let candidate = base;
    let attempt = 1;
    while (await circleSitePublicationRepository.findBySlug(familyId, candidate)) {
      attempt += 1;
      candidate = `${base}-${attempt}`;
    }
    return candidate;
  }

  /** Renders the full site for a family and atomically swaps it into place. Single entry point for all site regeneration. */
  async regenerateSite(familyId: string): Promise<void> {
    const previous = this.regenerationQueues.get(familyId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await this.regenerateSiteNow(familyId);
      });
    this.regenerationQueues.set(familyId, current);

    try {
      await current;
    } finally {
      if (this.regenerationQueues.get(familyId) === current) {
        this.regenerationQueues.delete(familyId);
      }
    }
  }

  async regeneratePendingMigrationSite(
    familyId: string,
    canonicalBaseUrl: string,
    targetHost: string
  ): Promise<PublicSiteGenerationReport> {
    return this.regenerateSiteNow(familyId, {
      canonicalBaseUrl: canonicalBaseUrl.replace(/\/$/, ''),
      targetHost
    });
  }

  private async regenerateSiteNow(
    familyId: string,
    migrationTarget?: { canonicalBaseUrl: string; targetHost: string }
  ): Promise<PublicSiteGenerationReport> {
    await this.ensureDirectories();

    const config = await this.getResolvedSiteConfig(familyId);
    const domain = migrationTarget
      ? null
      : await familyDomainRepository.findCurrentByFamilyId(familyId);
    const canonicalBaseUrl = migrationTarget?.canonicalBaseUrl
      || (domain?.public_base_url || '').replace(/\/$/, '');
    const targetHost = migrationTarget?.targetHost || domain?.host;

    if (!config.enabled || !canonicalBaseUrl || isBlockedManagedHost(targetHost)) {
      // Nothing to render; if a previous generation exists, remove it so serving
      // falls back to the disabled placeholder.
      await this.removeSiteDir(familyId);
      return {
        status: 'site_disabled',
        channelCount: 0,
        publicationCount: 0,
        generatedFileCount: 0,
        canonicalBaseUrl
      };
    }

    const visibleChannels = await announcementChannelRepository.listPublicSiteVisible(familyId);

    const channels: SiteChannel[] = [];
    const allPosts: SitePost[] = [];

    for (const announcementChannel of visibleChannels) {
      if (!announcementChannel.public_site_slug || !this.isSafePathSegment(announcementChannel.public_site_slug)) continue;
      const publications = await circleSitePublicationRepository.listPublishedByChannel(
        familyId,
        announcementChannel.channel_id
      );
      const posts: SitePost[] = await Promise.all(publications
        .filter((pub) => this.isSafePathSegment(pub.slug))
        .map(async (pub) => {
          const assets = await circleSitePublicationAssetRepository.listByPublication(
            familyId,
            pub.publication_id
          );
          return {
          slug: pub.slug,
          channelSlug: announcementChannel.public_site_slug!,
          title: pub.title,
          summary: pub.summary,
          bodyHtml: renderPublicationBodyToHtml(pub.body, pub.title, pub.body_format),
          assets: assets.map((asset) => ({
            assetId: asset.asset_id,
            kind: asset.kind,
            fileName: asset.original_file_name,
            mimeType: asset.mime_type,
            sizeBytes: Number(asset.size_bytes),
            width: asset.width,
            height: asset.height,
            altText: asset.alt_text,
            url: `/media/${encodeURIComponent(asset.asset_id)}/${encodeURIComponent(asset.original_file_name)}`,
          })),
          publishedAt: pub.published_at || pub.created_at,
          };
        }));

      const channel: SiteChannel = {
        slug: announcementChannel.public_site_slug,
        title: announcementChannel.public_site_intro_title || config.siteTitle,
        introText: announcementChannel.public_site_intro_text || announcementChannel.description || null,
        introImageUrl: normalizeSelfHostedPublicSiteImageUrl(
          announcementChannel.public_site_intro_image_url
        ),
        ctaLabel: announcementChannel.public_site_cta_label || null,
        guestLinkUrl: announcementChannel.public_site_guest_link_url || null,
        posts,
      };
      channels.push(channel);
      allPosts.push(...posts);
    }

    allPosts.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    const ctx: SiteRenderContext = {
      siteTitle: config.siteTitle,
      siteDescription: config.siteDescription,
      coverImageUrl: config.coverImageUrl,
      canonicalBaseUrl,
      productUrl: getPublicSiteProductUrl(),
      indexingEnabled: config.indexingEnabled,
      channels,
      allPosts,
    };

    await this.writeSiteAtomically(familyId, ctx);
    return {
      status: 'generated',
      channelCount: channels.length,
      publicationCount: allPosts.length,
      generatedFileCount: 5 + channels.length + allPosts.length,
      canonicalBaseUrl
    };
  }

  private isSafePathSegment(value: string): boolean {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
  }

  private async writeSiteAtomically(familyId: string, ctx: SiteRenderContext): Promise<void> {
    const tempDir = path.join(this.tmpDir, `${familyId}.${randomUUID()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    await fs.promises.writeFile(path.join(tempDir, 'index.html'), buildHomepageHtml(ctx));
    await fs.promises.writeFile(path.join(tempDir, 'sitemap.xml'), buildSitemapXml(ctx));
    await fs.promises.writeFile(path.join(tempDir, 'robots.txt'), buildRobotsTxt(ctx));
    await fs.promises.writeFile(path.join(tempDir, 'feed.json'), buildFeedJson(ctx));
    await fs.promises.writeFile(path.join(tempDir, 'publication-time.js'), buildPublicationTimeScript());

    for (const channel of ctx.channels) {
      const channelDir = path.join(tempDir, 'channels', channel.slug);
      await fs.promises.mkdir(channelDir, { recursive: true });
      await fs.promises.writeFile(path.join(channelDir, 'index.html'), buildChannelHtml(ctx, channel));

      for (const post of channel.posts) {
        const postDir = path.join(channelDir, 'posts', post.slug);
        await fs.promises.mkdir(postDir, { recursive: true });
        await fs.promises.writeFile(path.join(postDir, 'index.html'), buildPostHtml(ctx, channel, post));
      }
    }

    const finalDir = this.siteDir(familyId);
    const staleDir = path.join(this.tmpDir, `${familyId}.old.${randomUUID()}`);

    let hadExisting = false;
    try {
      await fs.promises.rename(finalDir, staleDir);
      hadExisting = true;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }

    try {
      await fs.promises.rename(tempDir, finalDir);
    } catch (error) {
      if (hadExisting) {
        await fs.promises.rename(staleDir, finalDir).catch(() => undefined);
      }
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    if (hadExisting) {
      await fs.promises.rm(staleDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async removeSiteDir(familyId: string): Promise<void> {
    await fs.promises.rm(this.siteDir(familyId), { recursive: true, force: true }).catch(() => undefined);
  }
}

export const publicSiteGeneratorService = new PublicSiteGeneratorService();
