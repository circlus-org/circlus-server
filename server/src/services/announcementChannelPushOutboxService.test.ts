jest.mock('../db/repositories', () => ({
  announcementChannelPushOutboxRepository: {
    claimNext: jest.fn(),
    checkpoint: jest.fn(),
    complete: jest.fn(),
    retry: jest.fn(),
  },
  announcementChannelRepository: {
    findById: jest.fn(),
    findPostById: jest.fn(),
    listPushSubscribersPage: jest.fn(),
  },
}));

jest.mock('../utils/push', () => ({
  sendIncomingMessagePush: jest.fn(),
}));

import { processAnnouncementChannelPushOutboxOnce } from './announcementChannelPushOutboxService';

const repositories = require('../db/repositories');
const push = require('../utils/push');

const job = {
  post_id: 'acp_1',
  family_id: 'family_1',
  channel_id: 'ach_1',
  author_identity_id: 'owner_1',
  cursor_identity_id: null,
  attempts: 1,
};

describe('announcement channel push outbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completes a subscriber page and advances its durable cursor', async () => {
    repositories.announcementChannelPushOutboxRepository.claimNext.mockResolvedValue(job);
    repositories.announcementChannelRepository.findById.mockResolvedValue({ status: 'active', title: 'Updates' });
    repositories.announcementChannelRepository.findPostById.mockResolvedValue({
      channel_id: 'ach_1',
      epoch: 2,
      notification_preview_ciphertext: 'npv2:preview',
    });
    repositories.announcementChannelRepository.listPushSubscribersPage.mockResolvedValue([
      { identity_id: 'subscriber_1' },
      { identity_id: 'subscriber_2' },
    ]);
    push.sendIncomingMessagePush.mockResolvedValue({ totals: { failed: 0 } });

    await expect(processAnnouncementChannelPushOutboxOnce()).resolves.toBe(true);

    expect(push.sendIncomingMessagePush).toHaveBeenCalledTimes(2);
    expect(push.sendIncomingMessagePush).toHaveBeenCalledWith(
      'family_1',
      'subscriber_1',
      'acp_1',
      'owner_1',
      'Updates',
      expect.objectContaining({
        channelId: 'ach_1',
        dialogId: 'ach_1',
        notificationPreview: {
          version: 1,
          scope: 'channel',
          chatId: 'ach_1',
          epoch: 2,
          ciphertext: 'npv2:preview',
        },
      })
    );
    expect(repositories.announcementChannelPushOutboxRepository.checkpoint)
      .toHaveBeenCalledWith('acp_1', 'subscriber_2');
    expect(repositories.announcementChannelPushOutboxRepository.complete).toHaveBeenCalledWith('acp_1');
  });

  it('retries a failed page without moving its cursor', async () => {
    repositories.announcementChannelPushOutboxRepository.claimNext.mockResolvedValue(job);
    repositories.announcementChannelRepository.findById.mockResolvedValue({ status: 'active', title: 'Updates' });
    repositories.announcementChannelRepository.findPostById.mockResolvedValue({
      channel_id: 'ach_1',
      epoch: 2,
      notification_preview_ciphertext: 'npv2:preview',
    });
    repositories.announcementChannelRepository.listPushSubscribersPage.mockResolvedValue([{ identity_id: 'subscriber_1' }]);
    push.sendIncomingMessagePush.mockRejectedValue(new Error('relay unavailable'));

    await expect(processAnnouncementChannelPushOutboxOnce()).resolves.toBe(true);

    expect(repositories.announcementChannelPushOutboxRepository.checkpoint).not.toHaveBeenCalled();
    expect(repositories.announcementChannelPushOutboxRepository.retry)
      .toHaveBeenCalledWith('acp_1', 'relay unavailable', 2);
  });
});
