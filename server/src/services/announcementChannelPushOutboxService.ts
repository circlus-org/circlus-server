import {
  announcementChannelPushOutboxRepository,
  announcementChannelRepository,
} from '../db/repositories';
import { sendIncomingMessagePush } from '../utils/push';
import { serverLogger } from '../utils/logger';

const SUBSCRIBER_PAGE_SIZE = 100;
const logger = serverLogger.child({ subsystem: 'announcement_channel_push_outbox' });

export async function processAnnouncementChannelPushOutboxOnce(): Promise<boolean> {
  const job = await announcementChannelPushOutboxRepository.claimNext();
  if (!job) return false;

  try {
    const channel = await announcementChannelRepository.findById(job.family_id, job.channel_id);
    if (!channel || channel.status !== 'active') {
      await announcementChannelPushOutboxRepository.complete(job.post_id);
      return true;
    }
    const post = await announcementChannelRepository.findPostById(job.family_id, job.post_id);
    if (!post || post.channel_id !== job.channel_id) {
      await announcementChannelPushOutboxRepository.complete(job.post_id);
      return true;
    }

    let cursor = job.cursor_identity_id;
    while (true) {
      const subscribers = await announcementChannelRepository.listPushSubscribersPage(
        job.family_id,
        job.channel_id,
        job.author_identity_id,
        cursor,
        SUBSCRIBER_PAGE_SIZE
      );
      if (subscribers.length === 0) {
        await announcementChannelPushOutboxRepository.complete(job.post_id);
        return true;
      }

      const deliveries = await Promise.all(subscribers.map((subscriber) =>
        sendIncomingMessagePush(
          job.family_id,
          subscriber.identity_id,
          job.post_id,
          job.author_identity_id,
          channel.title,
          {
            channelId: job.channel_id,
            dialogId: job.channel_id,
            notificationPreview: post.notification_preview_ciphertext?.startsWith('npv2:')
              ? {
                  version: 1,
                  scope: 'channel',
                  chatId: job.channel_id,
                  epoch: Number(post.epoch),
                  ciphertext: post.notification_preview_ciphertext,
                }
              : undefined,
          }
        )
      ));
      if (deliveries.some((delivery) => delivery.totals.failed > 0)) {
        throw new Error('One or more channel push subscriptions failed');
      }

      cursor = subscribers[subscribers.length - 1].identity_id;
      await announcementChannelPushOutboxRepository.checkpoint(job.post_id, cursor);
      if (subscribers.length < SUBSCRIBER_PAGE_SIZE) {
        await announcementChannelPushOutboxRepository.complete(job.post_id);
        return true;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const delaySeconds = Math.min(300, 2 ** Math.min(8, Math.max(1, Number(job.attempts || 1))));
    await announcementChannelPushOutboxRepository.retry(job.post_id, message, delaySeconds);
    logger.error('announcement_channel_push_outbox_job_failed', {
      postId: job.post_id,
      attempts: job.attempts,
      delaySeconds,
      error
    });
    return true;
  }
}

export function startAnnouncementChannelPushOutboxScheduler(): () => Promise<void> {
  let running = false;
  let stopped = false;
  const drain = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (let count = 0; count < 10 && await processAnnouncementChannelPushOutboxOnce(); count += 1) {
        // Bound each turn so other server work gets an opportunity to run.
      }
    } catch (error) {
      logger.error('announcement_channel_push_outbox_scheduler_failed', { error });
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => { void drain(); }, 2_000);
  interval.unref?.();
  void drain();
  return async () => {
    stopped = true;
    clearInterval(interval);
    while (running) await new Promise((resolve) => setTimeout(resolve, 10));
  };
}
