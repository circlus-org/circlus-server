const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));
jest.mock('../db/repositories', () => ({
  announcementChannelRepository: {
    attachLink: jest.fn(),
    create: jest.fn(),
    updatePublicSite: jest.fn(),
    findByLink: jest.fn(),
    clearPublicGuestLink: jest.fn()
  },
  directGuestLinkRepository: {
    create: jest.fn(),
    revoke: jest.fn()
  },
  directGuestRegistrationRepository: { revokeAllByLink: jest.fn() }
}));
jest.mock('./publicSiteGeneratorService', () => ({
  publicSiteGeneratorService: { regenerateSite: jest.fn() }
}));

import {
  announcementChannelRepository,
  directGuestLinkRepository,
  directGuestRegistrationRepository
} from '../db/repositories';
import { publicSiteGeneratorService } from './publicSiteGeneratorService';
import {
  createDirectGuestLink,
  DirectGuestLinkMutationError,
  revokeDirectGuestLink
} from './directGuestLinkMutationService';

const link = {
  linkId: 'link-1',
  familyId: 'family-1',
  hostIdentityId: 'host-1',
  createdByIdentityId: 'host-1',
  secretHash: 'secret-hash',
  canMessage: true,
  canCall: true,
  canDirectFileTransfer: false,
  canServerAttachments: false,
  hostCanMessageGuest: true,
  guestCanMessageHost: true,
  hostCanCallGuest: true,
  guestCanCallHost: true,
  hostCanDirectFileTransferGuest: true,
  guestCanDirectFileTransferHost: false,
  hostCanServerAttachmentsGuest: true,
  guestCanServerAttachmentsHost: false,
  autoSubscribeToChannel: true,
  publicSiteVisible: false
};

const created = {
  link_id: 'link-1',
  presentation_title: 'Updates',
  public_site_visible: false
};

describe('direct guest link mutation service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (directGuestLinkRepository.create as jest.Mock).mockResolvedValue(created);
    (announcementChannelRepository.attachLink as jest.Mock).mockResolvedValue({
      channel_id: 'channel-1',
      public_site_visible: false
    });
    (announcementChannelRepository.create as jest.Mock).mockResolvedValue({ channel_id: 'channel-1' });
    (directGuestLinkRepository.revoke as jest.Mock).mockResolvedValue({
      link_id: 'link-1',
      status: 'revoked',
      public_site_visible: false,
      revoked_at: new Date('2026-01-01T00:00:00.000Z')
    });
  });

  test('creates the link and attaches the selected channel in one transaction', async () => {
    const result = await createDirectGuestLink({
      link,
      requestedChannelId: 'channel-1'
    });

    expect(directGuestLinkRepository.create).toHaveBeenCalledWith(link, transactionClient);
    expect(announcementChannelRepository.attachLink).toHaveBeenCalledWith({
      familyId: 'family-1',
      channelId: 'channel-1',
      linkId: 'link-1',
      ownerIdentityId: 'host-1'
    }, transactionClient);
    expect(result.announcementChannel?.channel_id).toBe('channel-1');
    expect(publicSiteGeneratorService.regenerateSite).not.toHaveBeenCalled();
  });

  test('fails the workflow if the selected channel cannot be attached', async () => {
    (announcementChannelRepository.attachLink as jest.Mock).mockResolvedValue(null);

    await expect(createDirectGuestLink({
      link,
      requestedChannelId: 'channel-1'
    })).rejects.toMatchObject<Partial<DirectGuestLinkMutationError>>({
      status: 400,
      code: 'INVALID_REQUEST'
    });
    expect(publicSiteGeneratorService.regenerateSite).not.toHaveBeenCalled();
  });

  test('does not create an implicit channel for a guest link', async () => {
    await expect(createDirectGuestLink({
      link,
      requestedChannelId: null
    })).rejects.toMatchObject<Partial<DirectGuestLinkMutationError>>({
      status: 400,
      code: 'INVALID_REQUEST'
    });
    expect(directGuestLinkRepository.create).not.toHaveBeenCalled();
    expect(announcementChannelRepository.create).not.toHaveBeenCalled();
  });

  test('rejects a public link without explicit channel subscription', async () => {
    const publicLink = {
      ...link,
      autoSubscribeToChannel: false,
      publicSiteVisible: true,
      publicSiteChannelSlug: 'updates'
    };

    await expect(createDirectGuestLink({
      link: publicLink,
      requestedChannelId: null
    })).rejects.toMatchObject<Partial<DirectGuestLinkMutationError>>({
      status: 400,
      code: 'INVALID_REQUEST'
    });
    expect(directGuestLinkRepository.create).not.toHaveBeenCalled();
    expect(announcementChannelRepository.updatePublicSite).not.toHaveBeenCalled();
    expect(publicSiteGeneratorService.regenerateSite).not.toHaveBeenCalled();
  });

  test('revokes the link and channel reference without revoking existing guest access', async () => {
    (announcementChannelRepository.findByLink as jest.Mock).mockResolvedValue({
      channel_id: 'channel-1',
      public_site_visible: true
    });

    const result = await revokeDirectGuestLink({
      familyId: 'family-1',
      linkId: 'link-1',
      hostIdentityId: 'host-1'
    });

    expect(directGuestLinkRepository.revoke).toHaveBeenCalledWith(
      'family-1', 'link-1', 'host-1', transactionClient
    );
    expect(directGuestRegistrationRepository.revokeAllByLink).not.toHaveBeenCalled();
    expect(announcementChannelRepository.clearPublicGuestLink)
      .toHaveBeenCalledWith('family-1', 'link-1', transactionClient);
    expect(publicSiteGeneratorService.regenerateSite).toHaveBeenCalledWith('family-1');
    expect(result.revoked.status).toBe('revoked');
  });

  test('does not mutate related state when the link is not active', async () => {
    (directGuestLinkRepository.revoke as jest.Mock).mockResolvedValue(null);

    await expect(revokeDirectGuestLink({
      familyId: 'family-1',
      linkId: 'missing',
      hostIdentityId: 'host-1'
    })).rejects.toMatchObject<Partial<DirectGuestLinkMutationError>>({
      status: 404,
      code: 'NOT_FOUND'
    });
    expect(directGuestRegistrationRepository.revokeAllByLink).not.toHaveBeenCalled();
    expect(announcementChannelRepository.clearPublicGuestLink).not.toHaveBeenCalled();
    expect(publicSiteGeneratorService.regenerateSite).not.toHaveBeenCalled();
  });
});
