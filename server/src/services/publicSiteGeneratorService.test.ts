import fs from 'fs';
import path from 'path';
import os from 'os';

jest.mock('../db/repositories', () => ({
  circleSiteSettingsRepository: { findByFamilyId: jest.fn() },
  circleSitePublicationRepository: {
    findBySlug: jest.fn(),
    listPublishedByChannel: jest.fn(),
  },
  circleSitePublicationAssetRepository: { listByPublication: jest.fn() },
  announcementChannelRepository: { listPublicSiteVisible: jest.fn() },
  familyDomainRepository: { findCurrentByFamilyId: jest.fn() },
}));

jest.mock('./configService', () => ({
  configService: { getServerName: jest.fn() },
}));

import {
  circleSiteSettingsRepository,
  circleSitePublicationRepository,
  circleSitePublicationAssetRepository,
  announcementChannelRepository,
  familyDomainRepository,
} from '../db/repositories';
import { configService } from './configService';
import { publicSiteGeneratorService } from './publicSiteGeneratorService';

describe('PublicSiteGeneratorService', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    (circleSitePublicationAssetRepository.listByPublication as jest.Mock).mockResolvedValue([]);
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'circle-site-test-'));
    process.env.PUBLIC_SITE_STORAGE_DIR = tmpRoot;
  });

  afterEach(async () => {
    delete process.env.PUBLIC_SITE_STORAGE_DIR;
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('getResolvedSiteConfig', () => {
    test('falls back to server name then hardcoded default when settings are missing', async () => {
      (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue(null);
      (configService.getServerName as jest.Mock).mockResolvedValue('Smith Family');

      const resolved = await publicSiteGeneratorService.getResolvedSiteConfig('family-1');

      expect(resolved.enabled).toBe(false);
      expect(resolved.indexingEnabled).toBe(false);
      expect(resolved.siteTitle).toBe('Smith Family');
    });

    test('prefers explicit site_title over server name', async () => {
      (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({
        family_id: 'family-1',
        enabled: true,
        indexing_enabled: true,
        site_title: 'Custom Title',
        site_description: null,
        cover_image_url: null,
        theme: 'default',
        created_at: new Date(),
        updated_at: new Date(),
      });
      (configService.getServerName as jest.Mock).mockResolvedValue('Smith Family');

      const resolved = await publicSiteGeneratorService.getResolvedSiteConfig('family-1');
      expect(resolved.siteTitle).toBe('Custom Title');
      expect(resolved.enabled).toBe(true);
    });
  });

  describe('generateUniqueSlug', () => {
    test('returns the base slug when free', async () => {
      (circleSitePublicationRepository.findBySlug as jest.Mock).mockResolvedValue(null);
      const slug = await publicSiteGeneratorService.generateUniqueSlug('family-1', 'Hello World');
      expect(slug).toBe('hello-world');
    });

    test('appends a numeric suffix on collision', async () => {
      (circleSitePublicationRepository.findBySlug as jest.Mock)
        .mockResolvedValueOnce({ publication_id: 'existing-1' }) // hello-world taken
        .mockResolvedValueOnce({ publication_id: 'existing-2' }) // hello-world-2 taken
        .mockResolvedValueOnce(null); // hello-world-3 free

      const slug = await publicSiteGeneratorService.generateUniqueSlug('family-1', 'Hello World');
      expect(slug).toBe('hello-world-3');
    });
  });

  describe('regenerateSite', () => {
    test('removes any existing site directory when the site is disabled', async () => {
      (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({
        enabled: false,
        indexing_enabled: false,
        site_title: null,
        site_description: null,
        cover_image_url: null,
        theme: 'default',
      });
      (configService.getServerName as jest.Mock).mockResolvedValue('Smith Family');

      const familyDir = path.join(tmpRoot, 'family-1');
      await fs.promises.mkdir(familyDir, { recursive: true });
      await fs.promises.writeFile(path.join(familyDir, 'index.html'), 'stale');

      await publicSiteGeneratorService.regenerateSite('family-1');

      await expect(fs.promises.access(familyDir)).rejects.toThrow();
    });

    test('writes site files atomically with no leftover temp directories', async () => {
      (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({
        enabled: true,
        indexing_enabled: true,
        site_title: 'Test Circle',
        site_description: 'A test circle',
        cover_image_url: null,
        theme: 'default',
      });
      (configService.getServerName as jest.Mock).mockResolvedValue('Test Circle');
      (familyDomainRepository.findCurrentByFamilyId as jest.Mock).mockResolvedValue({
        public_base_url: 'https://circle.example.com',
      });
      (announcementChannelRepository.listPublicSiteVisible as jest.Mock).mockResolvedValue([
        {
          channel_id: 'channel-1',
          title: 'Announcements',
          description: null,
          public_site_slug: 'announcements',
          public_site_cta_label: null,
          public_site_intro_title: null,
          public_site_intro_text: null,
          public_site_intro_image_url: null,
          public_site_guest_link_url: null,
        },
      ]);
      (circleSitePublicationRepository.listPublishedByChannel as jest.Mock).mockResolvedValue([
        {
          publication_id: 'pub-1',
          slug: 'hello',
          title: 'Hello',
          summary: 'First post',
          body: 'Hello **world**',
          body_format: 'markdown',
          published_at: new Date('2026-01-01T00:00:00Z'),
          created_at: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      await publicSiteGeneratorService.regenerateSite('family-1');
      expect(circleSitePublicationRepository.listPublishedByChannel).toHaveBeenCalledWith(
        'family-1',
        'channel-1'
      );

      const familyDir = path.join(tmpRoot, 'family-1');
      const indexHtml = await fs.promises.readFile(path.join(familyDir, 'index.html'), 'utf8');
      expect(indexHtml).toContain('Test Circle');

      const postHtml = await fs.promises.readFile(
        path.join(familyDir, 'channels', 'announcements', 'posts', 'hello', 'index.html'),
        'utf8'
      );
      expect(postHtml).toContain('Hello');
      expect(postHtml).toContain('<strong>world</strong>');
      expect(postHtml).toContain('<script src="/publication-time.js" defer></script>');

      const publicationTimeScript = await fs.promises.readFile(
        path.join(familyDir, 'publication-time.js'),
        'utf8'
      );
      expect(publicationTimeScript).toContain('new Intl.DateTimeFormat(undefined');
      expect(publicationTimeScript).not.toContain('timeZoneName');

      const robots = await fs.promises.readFile(path.join(familyDir, 'robots.txt'), 'utf8');
      expect(robots).toContain('Allow: /');

      // No leftover _tmp entries after a successful generation.
      const tmpEntries = await fs.promises.readdir(path.join(tmpRoot, '_tmp')).catch(() => []);
      expect(tmpEntries).toEqual([]);
    });
  });
});
