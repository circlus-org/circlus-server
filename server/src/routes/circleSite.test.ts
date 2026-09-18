jest.mock('../services/reliableOperation', () => ({ reliableOperation: (handler: unknown) => handler }));
jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireAdmin: jest.fn((_req, _res, next) => next()),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {}),
}));

jest.mock('../db', () => ({
  transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback({ query: jest.fn() })),
}));

jest.mock('../db/repositories', () => ({
  circleSiteSettingsRepository: {
    findByFamilyId: jest.fn(),
    upsert: jest.fn(),
  },
  circleSitePublicationRepository: {
    listAllByFamily: jest.fn(),
    findById: jest.fn(),
    findBySourceChannelPostForUpdate: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    setStatus: jest.fn(),
  },
  circleSitePublicationAssetRepository: {
    replaceForPublication: jest.fn(),
    createReservation: jest.fn(),
    createSiteImageReservation: jest.fn(),
    findById: jest.fn(),
    markReady: jest.fn(),
    publishSiteImage: jest.fn(),
    removeSiteImage: jest.fn(),
  },
  directGuestLinkRepository: {
    findById: jest.fn(),
  },
  announcementChannelRepository: {
    findById: jest.fn(),
    findPostById: jest.fn(),
  },
}));

jest.mock('../services/publicSiteGeneratorService', () => ({
  publicSiteGeneratorService: {
    regenerateSite: jest.fn(),
    generateUniqueSlug: jest.fn(),
  },
}));

jest.mock('../services/configService', () => ({
  configService: {
    getFamilyConfig: jest.fn(),
  },
}));

jest.mock('../services/publicSiteAssetStorageService', () => ({
  publicSiteAssetStorageService: {
    getFreeBytes: jest.fn(),
    buildStorageKey: jest.fn((_familyId: string, assetId: string) => `family_1/${assetId}.bin`),
    writeUploadStream: jest.fn(),
  },
}));

import {
  circleSiteSettingsRepository,
  circleSitePublicationRepository,
  circleSitePublicationAssetRepository,
  directGuestLinkRepository,
  announcementChannelRepository,
} from '../db/repositories';
import { publicSiteGeneratorService } from '../services/publicSiteGeneratorService';
import { configService } from '../services/configService';
import { publicSiteAssetStorageService } from '../services/publicSiteAssetStorageService';

const circleSiteRouter = require('./circleSite').default;

type MockResponse = { status: jest.Mock; json: jest.Mock };

function getPostHandler(path: string) {
  const layer = (circleSiteRouter as any).stack.find((item: any) => item.route?.path === path);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function makeResponse(): MockResponse {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    familyId: 'family_1',
    identity: { identityId: 'owner_identity', role: 'owner' },
    headers: { host: 'family.example.com' },
    params: {},
    signedRequest: { payload: {} },
    ...overrides,
  };
}

describe('circleSite routes: domain eligibility guard', () => {
  beforeEach(() => jest.clearAllMocks());

  test('settings/update is blocked on a Circlus-managed subdomain', async () => {
    const res = makeResponse();
    await getPostHandler('/settings/update')(
      makeReq({ headers: { host: 'family.space.circlus.org' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(circleSiteSettingsRepository.upsert).not.toHaveBeenCalled();
    expect(publicSiteGeneratorService.regenerateSite).not.toHaveBeenCalled();
  });

  test('publications/create is blocked on a Circlus-managed subdomain', async () => {
    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({
        headers: { host: 'x.space.circlus.org' },
        signedRequest: { payload: { title: 'Hi', body: 'Hello' } },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(circleSitePublicationRepository.create).not.toHaveBeenCalled();
  });

  test('settings/update proceeds on an eligible custom domain', async () => {
    (circleSiteSettingsRepository.upsert as jest.Mock).mockResolvedValue({
      family_id: 'family_1',
      enabled: true,
      indexing_enabled: false,
      site_title: 'My Circle',
      site_description: null,
      cover_image_url: null,
      theme: 'default',
    });

    const res = makeResponse();
    await getPostHandler('/settings/update')(
      makeReq({ signedRequest: { payload: {
        enabled: true,
        indexingEnabled: false,
        siteTitle: 'My Circle',
        coverImageUrl: 'https://tracker.example/pixel.png',
      } } }),
      res
    );

    expect(circleSiteSettingsRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'family_1', enabled: true, siteTitle: 'My Circle' })
    );
    expect((circleSiteSettingsRepository.upsert as jest.Mock).mock.calls[0][0])
      .not.toHaveProperty('coverImageUrl');
    expect(publicSiteGeneratorService.regenerateSite).toHaveBeenCalledWith('family_1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });
});

describe('circleSite routes: self-hosted site images', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (configService.getFamilyConfig as jest.Mock).mockResolvedValue({
      attachments_enabled: true,
      max_attachment_file_size_bytes: 10_000_000,
      attachment_storage_quota_bytes: 100_000_000,
      used_attachment_storage_bytes: 0,
      reserved_attachment_storage_bytes: 0,
    });
    (publicSiteAssetStorageService.getFreeBytes as jest.Mock).mockResolvedValue(1_000_000_000);
    (circleSitePublicationAssetRepository.createSiteImageReservation as jest.Mock)
      .mockImplementation(async (input: any) => ({ asset_id: input.assetId }));
  });

  test('lets the Circle owner reserve a self-hosted cover image', async () => {
    const res = makeResponse();
    await getPostHandler('/site-images/reservations')(
      makeReq({
        signedRequest: {
          payload: {
            slot: 'cover',
            fileName: 'cover.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
            width: 1200,
            height: 630,
          },
        },
      }),
      res
    );

    expect(circleSitePublicationAssetRepository.createSiteImageReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'family_1',
        uploaderIdentityId: 'owner_identity',
        slot: 'cover',
        channelId: null,
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
      })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  test('does not let a member replace another author channel image', async () => {
    (announcementChannelRepository.findById as jest.Mock).mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'other_identity',
      status: 'active',
    });
    const res = makeResponse();
    await getPostHandler('/site-images/reservations')(
      makeReq({
        identity: { identityId: 'member_identity', role: 'member' },
        signedRequest: {
          payload: {
            slot: 'channel_intro',
            channelId: 'ach_1',
            fileName: 'intro.png',
            mimeType: 'image/png',
            sizeBytes: 1024,
          },
        },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(circleSitePublicationAssetRepository.createSiteImageReservation).not.toHaveBeenCalled();
  });

  test('removes a cover through the managed slot instead of accepting a replacement URL', async () => {
    const res = makeResponse();
    await getPostHandler('/site-images/remove')(
      makeReq({ signedRequest: { payload: { slot: 'cover' } } }),
      res
    );

    expect(circleSitePublicationAssetRepository.removeSiteImage).toHaveBeenCalledWith({
      familyId: 'family_1',
      slot: 'cover',
      channelId: null,
    });
    expect(publicSiteGeneratorService.regenerateSite).toHaveBeenCalledWith('family_1');
  });
});

describe('circleSite routes: publications/create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });
    (circleSitePublicationAssetRepository.replaceForPublication as jest.Mock).mockResolvedValue([]);
    (publicSiteGeneratorService.generateUniqueSlug as jest.Mock).mockResolvedValue('generated-slug');
    (directGuestLinkRepository.findById as jest.Mock).mockResolvedValue({
      link_id: 'link_1',
      status: 'active',
      public_site_visible: true,
      public_site_channel_slug: 'news',
    });
    (announcementChannelRepository.findPostById as jest.Mock).mockResolvedValue({
      post_id: 'acp_1',
      channel_id: 'ach_1',
      author_identity_id: 'owner_identity',
    });
    (announcementChannelRepository.findById as jest.Mock).mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'owner_identity',
      public_site_visible: true,
      public_site_slug: 'news',
      public_site_guest_link_id: 'link_1',
    });
  });

  test('rejects when title or body is missing', async () => {
    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({ signedRequest: { payload: { title: '' } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(circleSitePublicationRepository.create).not.toHaveBeenCalled();
  });

  test('rejects a member trying to publish a post from another author channel', async () => {
    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({
        identity: { identityId: 'member_identity', role: 'member' },
        signedRequest: { payload: { title: 'Hi', body: 'Hello', sourceChannelPostId: 'acp_1' } },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(circleSitePublicationRepository.create).not.toHaveBeenCalled();
  });

  test('rejects re-publishing an already-published channel post', async () => {
    (circleSitePublicationRepository.findBySourceChannelPostForUpdate as jest.Mock).mockResolvedValue({
      publication_id: 'existing',
      status: 'published',
    });

    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({
        signedRequest: { payload: { title: 'Hi', body: 'Hello', sourceLinkId: 'link_1', sourceChannelPostId: 'acp_1' } },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(circleSitePublicationRepository.create).not.toHaveBeenCalled();
  });

  test('re-publishes an unpublished channel post instead of conflicting', async () => {
    const unpublished = {
      publication_id: 'pub_1',
      family_id: 'family_1',
      source_link_id: 'link_1',
      source_channel_post_id: 'acp_1',
      author_identity_id: 'owner_identity',
      slug: 'hi',
      title: 'Old title',
      summary: null,
      body: 'Old body',
      body_format: 'markdown',
      status: 'unpublished',
      published_at: new Date('2026-01-01T00:00:00Z'),
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    };
    (circleSitePublicationRepository.findBySourceChannelPostForUpdate as jest.Mock).mockResolvedValue(unpublished);
    (circleSitePublicationRepository.update as jest.Mock).mockResolvedValue({
      ...unpublished,
      title: 'New title',
      body: 'New body',
    });
    (circleSitePublicationRepository.setStatus as jest.Mock).mockResolvedValue({
      ...unpublished,
      title: 'New title',
      body: 'New body',
      status: 'published',
    });

    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({
        signedRequest: {
          payload: {
            title: 'New title',
            body: 'New body',
            sourceLinkId: 'link_1',
            sourceChannelPostId: 'acp_1',
          }
        },
      }),
      res
    );

    expect(circleSitePublicationRepository.setStatus).toHaveBeenCalledWith(
      'family_1',
      'pub_1',
      'published',
      expect.anything()
    );
    expect(publicSiteGeneratorService.regenerateSite).toHaveBeenCalledWith('family_1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  test('lets a member publish a post from their approved channel and regenerates the site', async () => {
    (announcementChannelRepository.findPostById as jest.Mock).mockResolvedValue({
      post_id: 'acp_1',
      channel_id: 'ach_1',
      author_identity_id: 'member_identity',
    });
    (announcementChannelRepository.findById as jest.Mock).mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'member_identity',
      public_site_visible: true,
      public_site_slug: 'news',
      public_site_guest_link_id: 'link_1',
    });
    (circleSitePublicationRepository.findBySourceChannelPostForUpdate as jest.Mock).mockResolvedValue(null);
    (publicSiteGeneratorService.generateUniqueSlug as jest.Mock).mockResolvedValue('hi');
    (circleSitePublicationRepository.create as jest.Mock).mockResolvedValue({
      publication_id: 'pub_1',
      family_id: 'family_1',
      source_link_id: 'link_1',
      source_channel_post_id: 'acp_1',
      author_identity_id: 'owner_identity',
      slug: 'hi',
      title: 'Hi',
      summary: null,
      body: 'Hello',
      body_format: 'markdown',
      status: 'published',
      published_at: new Date('2026-01-01T00:00:00Z'),
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    });

    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({
        identity: { identityId: 'member_identity', role: 'member' },
        signedRequest: { payload: { title: 'Hi', body: 'Hello', sourceLinkId: 'link_1', sourceChannelPostId: 'acp_1' } },
      }),
      res
    );

    expect(circleSitePublicationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'family_1', title: 'Hi', body: 'Hello', slug: 'hi' }),
      expect.anything()
    );
    expect(publicSiteGeneratorService.regenerateSite).toHaveBeenCalledWith('family_1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  test('publishes only ready assets tied to the source channel post', async () => {
    (circleSitePublicationRepository.findBySourceChannelPostForUpdate as jest.Mock).mockResolvedValue(null);
    (publicSiteGeneratorService.generateUniqueSlug as jest.Mock).mockResolvedValue('photo');
    (circleSitePublicationRepository.create as jest.Mock).mockResolvedValue({
      publication_id: 'pub_1',
      family_id: 'family_1',
      channel_id: 'ach_1',
      source_link_id: 'link_1',
      source_channel_post_id: 'acp_1',
      author_identity_id: 'owner_identity',
      slug: 'photo',
      title: 'Photo',
      summary: null,
      body: 'photo.jpg',
      body_format: 'plain_text',
      status: 'published',
      published_at: new Date('2026-01-01T00:00:00Z'),
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    });
    (circleSitePublicationAssetRepository.replaceForPublication as jest.Mock).mockResolvedValue([
      { asset_id: 'pubasset_1' },
    ]);

    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({
        signedRequest: {
          payload: {
            title: 'Photo',
            body: 'photo.jpg',
            bodyFormat: 'plain_text',
            sourceLinkId: 'link_1',
            sourceChannelPostId: 'acp_1',
            assetIds: ['pubasset_1'],
          },
        },
      }),
      res
    );

    expect(circleSitePublicationAssetRepository.replaceForPublication).toHaveBeenCalledWith(
      {
        familyId: 'family_1',
        publicationId: 'pub_1',
        sourceChannelPostId: 'acp_1',
        uploaderIdentityId: 'owner_identity',
        assetIds: ['pubasset_1'],
      },
      expect.anything()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  test('re-publishing as text replaces the previous public asset set with an empty set', async () => {
    const unpublished = {
      publication_id: 'pub_1',
      family_id: 'family_1',
      source_link_id: 'link_1',
      source_channel_post_id: 'acp_1',
      author_identity_id: 'owner_identity',
      slug: 'hi',
      title: 'Old',
      summary: null,
      body: 'Old',
      body_format: 'plain_text',
      status: 'unpublished',
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };
    (circleSitePublicationRepository.findBySourceChannelPostForUpdate as jest.Mock).mockResolvedValue(unpublished);
    (circleSitePublicationRepository.update as jest.Mock).mockResolvedValue({ ...unpublished, title: 'Text', body: 'Body' });
    (circleSitePublicationRepository.setStatus as jest.Mock).mockResolvedValue({ ...unpublished, status: 'published' });

    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({
        signedRequest: {
          payload: {
            title: 'Text',
            body: 'Body',
            sourceLinkId: 'link_1',
            sourceChannelPostId: 'acp_1',
            assetIds: [],
          },
        },
      }),
      res
    );

    expect(circleSitePublicationAssetRepository.replaceForPublication).toHaveBeenCalledWith(
      expect.objectContaining({ publicationId: 'pub_1', assetIds: [] }),
      expect.anything()
    );
    expect(publicSiteGeneratorService.regenerateSite).toHaveBeenCalledWith('family_1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  test('does not unpublish or regenerate when a requested image is not ready', async () => {
    const unpublished = {
      publication_id: 'pub_1',
      family_id: 'family_1',
      status: 'unpublished',
    };
    (circleSitePublicationRepository.findBySourceChannelPostForUpdate as jest.Mock).mockResolvedValue(unpublished);
    (circleSitePublicationRepository.update as jest.Mock).mockResolvedValue({ ...unpublished, title: 'Photo', body: 'Photo' });
    (circleSitePublicationAssetRepository.replaceForPublication as jest.Mock).mockResolvedValue(null);

    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({
        signedRequest: {
          payload: {
            title: 'Photo',
            body: 'Photo',
            sourceLinkId: 'link_1',
            sourceChannelPostId: 'acp_1',
            assetIds: ['missing'],
          },
        },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(circleSitePublicationRepository.setStatus).not.toHaveBeenCalled();
    expect(publicSiteGeneratorService.regenerateSite).not.toHaveBeenCalled();
  });

  test('rejects a channel whose public guest link does not match the selected link', async () => {
    (announcementChannelRepository.findPostById as jest.Mock).mockResolvedValue({
      post_id: 'acp_1',
      channel_id: 'ach_1',
    });
    (announcementChannelRepository.findById as jest.Mock).mockResolvedValue({
      channel_id: 'ach_1',
      public_site_visible: true,
      public_site_slug: 'news',
      public_site_guest_link_id: 'another_link',
    });

    const res = makeResponse();
    await getPostHandler('/publications/create')(
      makeReq({
        signedRequest: {
          payload: {
            title: 'Hi',
            body: 'Hello',
            sourceLinkId: 'link_1',
            sourceChannelPostId: 'acp_1',
          }
        },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(circleSitePublicationRepository.create).not.toHaveBeenCalled();
  });
});

describe('circleSite routes: public asset reservations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { configService } = require('../services/configService');
    const { publicSiteAssetStorageService } = require('../services/publicSiteAssetStorageService');
    configService.getFamilyConfig.mockResolvedValue({
      attachments_enabled: true,
      max_attachment_file_size_bytes: 10_000,
      attachment_storage_quota_bytes: 100_000,
      used_attachment_storage_bytes: 0,
      reserved_attachment_storage_bytes: 0,
    });
    publicSiteAssetStorageService.getFreeBytes.mockResolvedValue(1_000_000_000);
    (announcementChannelRepository.findPostById as jest.Mock).mockResolvedValue({
      post_id: 'acp_1',
      channel_id: 'ach_1',
      author_identity_id: 'owner_identity',
      deleted_at: null,
    });
    (announcementChannelRepository.findById as jest.Mock).mockResolvedValue({
      channel_id: 'ach_1',
      public_site_visible: true,
    });
    (circleSitePublicationAssetRepository.createReservation as jest.Mock).mockImplementation(
      async (input) => ({ asset_id: input.assetId })
    );
  });

  test('reserves picker-selected files as metadata-free public downloads', async () => {
    const res = makeResponse();
    await getPostHandler('/assets/reservations')(
      makeReq({
        signedRequest: {
          payload: {
            sourceChannelPostId: 'acp_1',
            kind: 'download',
            fileName: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 321,
            width: 640,
            height: 480,
            altText: 'must not be copied',
          },
        },
      }),
      res
    );

    expect(circleSitePublicationAssetRepository.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'download',
        originalFileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 321,
        width: null,
        height: null,
        altText: null,
      })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  test('rejects an invalid upload token before reading the request stream', async () => {
    (circleSitePublicationAssetRepository.findById as jest.Mock).mockResolvedValue({
      asset_id: 'pubasset_1',
      status: 'reserved',
      upload_token_hash: 'invalid-hash',
      reserved_until: new Date(Date.now() + 60_000),
      size_bytes: 321,
      storage_key: 'family_1/pubasset_1.bin',
    });
    const res = makeResponse();

    await getPostHandler('/assets/uploads/:assetId')(
      makeReq({
        params: { assetId: 'pubasset_1' },
        headers: {
          authorization: 'Bearer wrong-token',
          'content-type': 'application/octet-stream',
          'content-length': '321',
        },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(publicSiteAssetStorageService.writeUploadStream).not.toHaveBeenCalled();
  });
});
