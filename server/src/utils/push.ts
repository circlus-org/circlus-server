import { nanoid } from 'nanoid';
import {
  pushSubscriptionRepository,
  deviceRepository,
  identityRepository,
  mobileNotificationRepository
} from '../db/repositories';
import type { DeviceId, IdentityId, CallSessionId } from '@shared/types';
import { configService } from '../services/configService';
import { encryptPushPayload } from './pushEncryption';
import {
  enrichMobilePayloadForBinding,
  mobileDeliveryClassForPayload,
  opaqueMobileCollapseId,
  ttlSecondsForPayload,
  urgencyForPayload,
  withTimestamps,
  type PushPayload
} from './pushPayload';
import {
  ensureRelayTokenForSubscription,
  getRelayVapidPublicKey,
  sendMobileNotificationViaCentral,
  sendRelayNotification
} from './pushDeliveryTransport';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';
import { getEffectivePushConfiguration } from '../services/managedPushConfigurationService';
import { getRequestLogger } from '../middleware/requestContext';

export type PushDeliveryMode = 'direct' | 'relay';

export type PushSubscriptionDeliveryFailure = {
  pushId: string;
  delivery: PushDeliveryMode;
  statusCode?: number;
  serviceError?: string;
  message: string;
};

export type PushDeviceDeliveryResult = {
  deviceId: DeviceId;
  subscriptionsTotal: number;
  attempted: number;
  sent: number;
  invalidated: number;
  skipped: number;
  failed: number;
  failures: PushSubscriptionDeliveryFailure[];
};

export type PushIdentityDeliveryResult = {
  identityId: IdentityId;
  devicesTotal: number;
  totals: {
    subscriptionsTotal: number;
    attempted: number;
    sent: number;
    invalidated: number;
    skipped: number;
    failed: number;
  };
  deviceResults: PushDeviceDeliveryResult[];
};

export function isRelayDeliveryEnabled(): boolean {
  return getEffectivePushConfiguration().relayDeliveryEnabled;
}

export function getPushServiceUrl(): string | null {
  return getEffectivePushConfiguration().serviceUrl;
}

export function validatePushConfig(): void {
  const config = getEffectivePushConfiguration();
  getRequestLogger({ subsystem: 'push' }).info('push_config_validated', {
    relayDeliveryEnabled: config.relayDeliveryEnabled,
    serviceConfigured: !!config.serviceUrl
  });
}

export async function getPushVapidKey(): Promise<{ publicKey: string } | null> {
  const config = getEffectivePushConfiguration();
  const relayAvailable = config.relayDeliveryEnabled && !!config.serviceUrl;
  if (!relayAvailable) {
    return null;
  }

  const relayKey = await getRelayVapidPublicKey(config.serviceUrl!);
  if (!relayKey) {
    return null;
  }

  return {
    publicKey: relayKey
  };
}

/**
 * Send push notification to device
 */
export async function sendPushToDevice(
  familyId: string,
  deviceId: DeviceId,
  payload: PushPayload,
  targetIdentityId: IdentityId,
  familyPublicBaseUrl: string,
  resolvedServerOrigin: string,
  resolvedCircleId: string,
  resolvedServerDisplayHint: string
): Promise<PushDeviceDeliveryResult> {
  const pushConfig = getEffectivePushConfiguration();
  const summary: PushDeviceDeliveryResult = {
    deviceId,
    subscriptionsTotal: 0,
    attempted: 0,
    sent: 0,
    invalidated: 0,
    skipped: 0,
    failed: 0,
    failures: []
  };

  try {
    const urgency = urgencyForPayload(payload);
    const ttlSec = ttlSecondsForPayload(payload);
    const activeBinding = await mobileNotificationRepository.getActiveBindingByWebDeviceId(familyId, deviceId);
    if (activeBinding && activeBinding.route === 'mobile_push') {
      const bindingToken = (activeBinding.delivery_token || '').trim();
      const bindingTokenExpiresAt = activeBinding.delivery_token_expires_at?.getTime() || null;
      const bindingTokenStillValid = !bindingTokenExpiresAt || bindingTokenExpiresAt > Date.now();
      const deliveryToken = bindingToken && bindingTokenStillValid ? bindingToken : null;

      if (!deliveryToken) {
        await mobileNotificationRepository.unbindToWebPush(familyId, deviceId);
        summary.skipped += 1;
        getRequestLogger({ subsystem: 'push' }).warn('push_mobile_binding_deactivated', {
          familyId,
          deviceId,
          reason: 'missing_active_delivery_token'
        });
      } else {
        summary.subscriptionsTotal = 1;
        summary.attempted = 1;
        try {
          const mobilePayload = enrichMobilePayloadForBinding(payload, activeBinding, {
            familyId,
            targetIdentityId,
            publicBaseUrl: familyPublicBaseUrl,
            serverOrigin: resolvedServerOrigin,
            vpsId: getServerIdentityRuntimeConfig().vpsId,
            circleId: resolvedCircleId,
            serverDisplayHint: resolvedServerDisplayHint
          });

          const mobileEndpointId = activeBinding.mobile_endpoint_ref || activeBinding.mobile_endpoint_id;
          if (!mobileEndpointId) {
            await mobileNotificationRepository.unbindToWebPush(familyId, deviceId);
            summary.skipped += 1;
            getRequestLogger({ subsystem: 'push' }).warn('push_mobile_binding_deactivated', {
              familyId,
              deviceId,
              reason: 'missing_endpoint_id'
            });
          } else {
            const bindingPushEncryptionKey = (activeBinding.push_encryption_public_key || '').trim();
            if (!bindingPushEncryptionKey) {
              await mobileNotificationRepository.unbindToWebPush(familyId, deviceId);
              summary.skipped += 1;
              getRequestLogger({ subsystem: 'push' }).warn('push_mobile_binding_deactivated', {
                familyId,
                deviceId,
                reason: 'missing_encryption_key'
              });
            } else {
              const outboundPayload = encryptPushPayload(bindingPushEncryptionKey, mobilePayload);
              const pushServiceUrl = pushConfig.serviceUrl;
              if (!pushServiceUrl) {
                throw new Error('PUSH_SERVICE_URL is not configured');
              }

              await sendMobileNotificationViaCentral({
                pushServiceUrl,
                deliveryToken,
                payload: outboundPayload as any,
                deliveryClass: mobileDeliveryClassForPayload(mobilePayload),
                collapseId: opaqueMobileCollapseId(mobilePayload),
                urgency,
                ttlSec
              });
              summary.sent = 1;
            }
          }
        } catch (error: any) {
          summary.failed = 1;
          summary.failures.push({
            pushId: `mobile:${activeBinding.mobile_endpoint_ref || activeBinding.mobile_endpoint_id || activeBinding.web_device_id}`,
            delivery: 'direct',
            statusCode: Number.isFinite(error?.statusCode) ? Number(error.statusCode) : undefined,
            serviceError: typeof error?.serviceError === 'string' ? error.serviceError : undefined,
            message: String(error?.message || 'Mobile push send error')
          });
        }
        if (summary.sent > 0 || summary.failed > 0) {
          return summary;
        }
      }
    }

    // Find active push subscriptions for this device
    const subscriptions = await pushSubscriptionRepository.findActiveByDeviceId(familyId, deviceId);
    summary.subscriptionsTotal = subscriptions.length;

    if (subscriptions.length === 0) {
      getRequestLogger({ subsystem: 'push' }).debug('push_device_has_no_subscriptions', {
        familyId,
        deviceId
      });
      return summary;
    }

    for (const sub of subscriptions) {
      const payloadWithPushId: PushPayload = { ...payload, pushId: sub.push_id };
      const deliveryMethod = (sub.delivery_method as PushDeliveryMode | undefined) || 'direct';
      summary.attempted += 1;

      try {
        if (!pushConfig.relayDeliveryEnabled) {
          getRequestLogger({ subsystem: 'push' }).debug('push_relay_delivery_skipped', {
            familyId,
            deviceId,
            pushId: sub.push_id,
            reason: 'relay_disabled'
          });
          summary.skipped += 1;
          continue;
        }

        if (!pushConfig.serviceUrl) {
          getRequestLogger({ subsystem: 'push' }).error('push_relay_delivery_skipped', {
            familyId,
            deviceId,
            pushId: sub.push_id,
            reason: 'service_not_configured'
          });
          summary.skipped += 1;
          continue;
        }

        const subscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        };

        let relayToken = sub.relay_token
          ? sub.relay_token
          : await ensureRelayTokenForSubscription({
              pushServiceUrl: pushConfig.serviceUrl,
              familyId,
              pushId: sub.push_id,
              pushEncryptionPublicKey: sub.push_encryption_public_key,
              subscription
            });

        if (!sub.push_encryption_public_key) {
          // Never fall back to plaintext: notification central must only receive encrypted envelopes.
          summary.skipped += 1;
          getRequestLogger({ subsystem: 'push' }).warn('push_relay_delivery_skipped', {
            familyId,
            deviceId,
            pushId: sub.push_id,
            reason: 'missing_encryption_key'
          });
          continue;
        }
        const encryptedRelayPayload = encryptPushPayload(sub.push_encryption_public_key, payloadWithPushId);

        try {
          await sendRelayNotification({
            pushServiceUrl: pushConfig.serviceUrl,
            token: relayToken,
            payload: encryptedRelayPayload as any,
            urgency,
            ttlSec
          });
        } catch (error: any) {
          if (error?.statusCode !== 401) {
            throw error;
          }
          relayToken = await ensureRelayTokenForSubscription({
              pushServiceUrl: pushConfig.serviceUrl,
              familyId,
              pushId: sub.push_id,
              pushEncryptionPublicKey: sub.push_encryption_public_key,
              subscription
            });
          await sendRelayNotification({
            pushServiceUrl: pushConfig.serviceUrl,
            token: relayToken,
            payload: encryptedRelayPayload as any,
            urgency,
            ttlSec
          });
        }
        summary.sent += 1;
        getRequestLogger({ subsystem: 'push' }).debug('push_relay_delivery_sent', {
          familyId,
          deviceId,
          pushId: sub.push_id
        });
      } catch (error: any) {
        if (error?.statusCode === 410 || error?.statusCode === 404) {
          await pushSubscriptionRepository.updateStatus(familyId, sub.push_id, 'invalid');
          summary.invalidated += 1;
          getRequestLogger({ subsystem: 'push' }).info('push_subscription_invalidated', {
            familyId,
            deviceId,
            pushId: sub.push_id,
            statusCode: error.statusCode
          });
          continue;
        }
        summary.failed += 1;
        const statusCode = Number.isFinite(error?.statusCode) ? Number(error.statusCode) : undefined;
        const serviceError = typeof error?.serviceError === 'string' ? error.serviceError : undefined;
        const message = String(error?.message || 'Relay push send error');
        getRequestLogger({ subsystem: 'push' }).warn('push_relay_delivery_failed', {
          familyId,
          deviceId,
          pushId: sub.push_id,
          statusCode,
          serviceError,
          message
        });
        summary.failures.push({
          pushId: sub.push_id,
          delivery: deliveryMethod === 'relay' ? 'relay' : 'direct',
          statusCode,
          serviceError,
          message
        });
      }
    }

    getRequestLogger({ subsystem: 'push' }).info('push_device_delivery_completed', {
      familyId,
      deviceId,
      subscriptionsTotal: summary.subscriptionsTotal,
      attempted: summary.attempted,
      sent: summary.sent,
      invalidated: summary.invalidated,
      skipped: summary.skipped,
      failed: summary.failed
    });
    return summary;
  } catch (error) {
    getRequestLogger({ subsystem: 'push' }).error('push_device_delivery_failed', {
      familyId,
      deviceId,
      error
    });
    throw error;
  }
}

/**
 * Send push notification to all devices of an identity
 */
export async function sendPushToIdentity(
  familyId: string,
  identityId: IdentityId,
  payload: PushPayload,
  options?: {
    excludeDeviceIds?: DeviceId[];
  }
): Promise<PushIdentityDeliveryResult> {
  try {
    const identity = await identityRepository.findByIdentityId(familyId, identityId);
    if (identity?.status !== 'active') {
      getRequestLogger({ subsystem: 'push' }).info('push_identity_delivery_skipped', {
        familyId,
        identityId,
        reason: identity ? 'identity_suspended' : 'identity_not_found'
      });
      return {
        identityId,
        devicesTotal: 0,
        totals: {
          subscriptionsTotal: 0,
          attempted: 0,
          sent: 0,
          invalidated: 0,
          skipped: 0,
          failed: 0
        },
        deviceResults: []
      };
    }
    const familyConfig = await configService.requireFamilyConfig(familyId);
    const resolvedCircleId = familyConfig.circle_id;
    const resolvedServerOrigin = familyConfig.public_base_url;
    const resolvedServerDisplayHint = (familyConfig.server_name || '').trim()
      || (() => {
        try {
          return new URL(resolvedServerOrigin).host || resolvedServerOrigin;
        } catch {
          return resolvedServerOrigin;
        }
      })();
    const payloadWithResolvedServerId: PushPayload = {
      ...payload,
      targetIdentityId: payload.targetIdentityId || identityId,
      serverOrigin: payload.serverOrigin || resolvedServerOrigin,
      vpsId: payload.vpsId || getServerIdentityRuntimeConfig().vpsId,
      circleId: payload.circleId || resolvedCircleId,
      serverDisplayHint: payload.serverDisplayHint || resolvedServerDisplayHint
    };

    // Find all active devices for this identity
    const excluded = new Set((options?.excludeDeviceIds || []).map((deviceId) => String(deviceId).trim()).filter(Boolean));
    const allDevices = await deviceRepository.findActiveByIdentityId(familyId, identityId);
    const devices = allDevices.filter((device) => !excluded.has(String(device.device_id).trim()));

    getRequestLogger({ subsystem: 'push' }).debug('push_identity_delivery_started', {
      familyId,
      identityId,
      selectedDevices: devices.length,
      totalDevices: allDevices.length,
      payloadType: payloadWithResolvedServerId.type
    });

    // Send push to all devices
    const settled = await Promise.allSettled(
      devices.map(device => sendPushToDevice(
        familyId,
        device.device_id,
        payloadWithResolvedServerId,
        identityId,
        familyConfig.public_base_url,
        resolvedServerOrigin,
        resolvedCircleId,
        resolvedServerDisplayHint
      ))
    );

    const deviceResults: PushDeviceDeliveryResult[] = [];
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        deviceResults.push(item.value);
      } else {
        getRequestLogger({ subsystem: 'push' }).error('push_identity_device_delivery_failed', {
          familyId,
          identityId,
          error: item.reason
        });
      }
    }

    const totals = deviceResults.reduce(
      (acc, current) => {
        acc.subscriptionsTotal += current.subscriptionsTotal;
        acc.attempted += current.attempted;
        acc.sent += current.sent;
        acc.invalidated += current.invalidated;
        acc.skipped += current.skipped;
        acc.failed += current.failed;
        return acc;
      },
      { subscriptionsTotal: 0, attempted: 0, sent: 0, invalidated: 0, skipped: 0, failed: 0 }
    );

    const summary: PushIdentityDeliveryResult = {
      identityId,
      devicesTotal: devices.length,
      totals,
      deviceResults
    };

    getRequestLogger({ subsystem: 'push' }).info('push_identity_delivery_completed', {
      familyId,
      identityId,
      devicesTotal: summary.devicesTotal,
      subscriptionsTotal: totals.subscriptionsTotal,
      attempted: totals.attempted,
      sent: totals.sent,
      invalidated: totals.invalidated,
      skipped: totals.skipped,
      failed: totals.failed
    });
    const failures = deviceResults.flatMap((result) => result.failures);
    if (failures.length > 0) {
      getRequestLogger({ subsystem: 'push' }).warn('push_identity_delivery_partial_failure', {
        identityId,
        familyId,
        failureCount: failures.length,
        failures: failures.slice(0, 10)
      });
    }

    return summary;
  } catch (error) {
    getRequestLogger({ subsystem: 'push' }).error('push_identity_delivery_failed', {
      familyId,
      identityId,
      error
    });
    throw error;
  }
}

export async function sendCircleOwnerChangedPush(
  familyId: string,
  targetIdentityId: IdentityId,
  params: {
    ownershipChangeId: string;
    circleName: string;
    method: 'voluntary_transfer';
  }
): Promise<PushIdentityDeliveryResult> {
  const payload: PushPayload = withTimestamps({
    type: 'circle_owner_changed',
    ownershipChangeId: params.ownershipChangeId,
    circleName: params.circleName,
    ownerChangeMethod: params.method,
    collapseKey: `circle-owner:${params.ownershipChangeId}`
  }, ttlSecondsForPayload({ type: 'circle_owner_changed' }) * 1000);
  return sendPushToIdentity(familyId, targetIdentityId, payload);
}

/**
 * Send incoming call notification
 */
export async function sendIncomingCallPush(
  familyId: string,
  targetIdentityId: IdentityId,
  callSessionId: CallSessionId,
  fromIdentityId?: IdentityId,
  fromIdentityName?: string,
  bootstrapFields?: {
    bootstrapToken?: string;
    isTemporaryLinkCall?: boolean;
    callLinkTitle?: string;
  }
): Promise<PushIdentityDeliveryResult> {
  const payload: PushPayload = withTimestamps(
    {
    type: 'incoming_call',
    schemaVersion: bootstrapFields ? 2 : 1,
    callSessionId,
    fromIdentityId,
    fromIdentityName,
    isTemporaryLinkCall: bootstrapFields?.isTemporaryLinkCall,
    callLinkTitle: bootstrapFields?.callLinkTitle,
    bootstrapToken: bootstrapFields?.bootstrapToken,
    nonce: nanoid(12)
    },
    ttlSecondsForPayload({ type: 'incoming_call' }) * 1000
  );

  getRequestLogger({ subsystem: 'push' }).info('push_incoming_call_started', {
    familyId,
    targetIdentityId,
    callSessionId
  });

  return sendPushToIdentity(familyId, targetIdentityId, payload);
}

export async function sendCallStatusPush(
  familyId: string,
  targetIdentityId: IdentityId,
  params: {
    callSessionId: CallSessionId;
    callStatus: 'missed' | 'answered_elsewhere' | 'ended';
    callEndReason?: 'cancelled' | 'timeout' | 'answered_elsewhere' | 'normal' | 'unknown';
    fromIdentityId?: IdentityId;
    fromIdentityName?: string;
    isTemporaryLinkCall?: boolean;
    callLinkTitle?: string;
    excludeDeviceIds?: DeviceId[];
  }
): Promise<PushIdentityDeliveryResult> {
  const payload: PushPayload = withTimestamps(
    {
    type: 'call_status',
    callSessionId: params.callSessionId,
    callStatus: params.callStatus,
    callEndReason: params.callEndReason || 'unknown',
    fromIdentityId: params.fromIdentityId,
    fromIdentityName: params.fromIdentityName,
    isTemporaryLinkCall: params.isTemporaryLinkCall,
    callLinkTitle: params.callLinkTitle,
    nonce: nanoid(12)
    },
    ttlSecondsForPayload({ type: 'call_status' }) * 1000
  );

  getRequestLogger({ subsystem: 'push' }).info('push_call_status_started', {
    familyId,
    targetIdentityId,
    callSessionId: params.callSessionId,
    callStatus: params.callStatus,
    callEndReason: payload.callEndReason
  });

  return sendPushToIdentity(familyId, targetIdentityId, payload, {
    excludeDeviceIds: params.excludeDeviceIds
  });
}

export async function sendIncomingMessagePush(
  familyId: string,
  targetIdentityId: IdentityId,
  serverMessageId: string,
  senderIdentityId?: IdentityId,
  senderIdentityName?: string,
  params?: {
    peerIdentityId?: IdentityId;
    chatId?: string;
    channelId?: string;
    dialogId?: string;
    notificationPreview?: PushPayload['notificationPreview'];
  }
): Promise<PushIdentityDeliveryResult> {
  const dialogId = params?.dialogId ?? params?.chatId ?? params?.peerIdentityId;
  const payload: PushPayload = withTimestamps(
    {
    type: 'incoming_message',
    messageId: serverMessageId,
    dialogId,
    fromIdentityId: senderIdentityId,
    fromIdentityName: senderIdentityName,
    senderIdentityName,
    peerIdentityId: params?.peerIdentityId,
    chatId: params?.chatId,
    channelId: params?.channelId,
    notificationPreview: params?.notificationPreview,
    nonce: nanoid(12)
    },
    ttlSecondsForPayload({ type: 'incoming_message' }) * 1000
  );

  return sendPushToIdentity(familyId, targetIdentityId, payload);
}

export async function sendMessagesReadPush(
  familyId: string,
  targetIdentityId: IdentityId,
  params: {
    dialogId: string;
    peerIdentityId?: IdentityId;
    chatId?: string;
  }
): Promise<PushIdentityDeliveryResult> {
  const payload: PushPayload = withTimestamps(
    {
    type: 'messages_read',
    dialogId: params.dialogId,
    peerIdentityId: params.peerIdentityId,
    chatId: params.chatId,
    nonce: nanoid(12)
    },
    ttlSecondsForPayload({ type: 'messages_read' }) * 1000
  );

  getRequestLogger({ subsystem: 'push' }).debug('push_messages_read_started', {
    familyId,
    targetIdentityId,
    dialogId: params.dialogId
  });

  return sendPushToIdentity(familyId, targetIdentityId, payload);
}

export async function sendTemporaryTrustedAccessRequestPush(
  familyId: string,
  targetIdentityId: IdentityId,
  params: {
    requestId: string;
    identityId: IdentityId;
    temporaryDeviceId: DeviceId;
  }
): Promise<PushIdentityDeliveryResult> {
  const payload: PushPayload = withTimestamps(
    {
      type: 'temporary_trusted_access_request',
      requestId: params.requestId,
      identityId: params.identityId,
      temporaryDeviceId: params.temporaryDeviceId,
      nonce: nanoid(12)
    },
    ttlSecondsForPayload({ type: 'temporary_trusted_access_request' }) * 1000
  );

  getRequestLogger({ subsystem: 'push' }).info('push_temporary_access_request_started', {
    familyId,
    targetIdentityId,
    accessRequestId: params.requestId
  });

  return sendPushToIdentity(familyId, targetIdentityId, payload);
}

export async function sendChannelPublicationRequestPush(
  familyId: string,
  targetIdentityId: IdentityId,
  params: {
    channelId: string;
    channelTitle: string;
    requestingIdentityId: IdentityId;
    requestingIdentityName?: string;
  }
): Promise<PushIdentityDeliveryResult> {
  const payload: PushPayload = withTimestamps(
    {
      type: 'channel_publication_request',
      channelId: params.channelId,
      channelTitle: params.channelTitle,
      identityId: targetIdentityId,
      fromIdentityId: params.requestingIdentityId,
      fromIdentityName: params.requestingIdentityName,
      collapseKey: `channel-publication:${params.channelId}`,
      nonce: nanoid(12)
    },
    ttlSecondsForPayload({ type: 'channel_publication_request' }) * 1000
  );

  return sendPushToIdentity(familyId, targetIdentityId, payload);
}

export async function sendTemporaryDeviceExpiredPush(
  familyId: string,
  identityId: IdentityId,
  temporaryDeviceId: DeviceId
): Promise<PushDeviceDeliveryResult> {
  const familyConfig = await configService.requireFamilyConfig(familyId);
  const resolvedCircleId = familyConfig.circle_id;
  const resolvedServerOrigin = familyConfig.public_base_url;
  const resolvedServerDisplayHint = (familyConfig.server_name || '').trim()
    || (() => {
      try {
        return new URL(resolvedServerOrigin).host || resolvedServerOrigin;
      } catch {
        return resolvedServerOrigin;
      }
    })();
  const payload = withTimestamps(
    {
      type: 'temporary_device_expired',
      identityId,
      temporaryDeviceId,
      nonce: nanoid(12)
    },
    ttlSecondsForPayload({ type: 'temporary_device_expired' }) * 1000
  );
  return sendPushToDevice(
    familyId,
    temporaryDeviceId,
    payload,
    identityId,
    familyConfig.public_base_url,
    resolvedServerOrigin,
    resolvedCircleId,
    resolvedServerDisplayHint
  );
}
