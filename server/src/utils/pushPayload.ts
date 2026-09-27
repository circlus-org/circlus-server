import crypto from 'node:crypto';
import type { CallSessionId, DeviceId, DirectFileTransferSessionId, IdentityId } from '@shared/types';
import { issueMobileCallActionToken } from './mobileCallActionToken';
import { normalizePublicServerUrl } from './serverIdentity';

export interface PushPayload {
  type: 'incoming_call' | 'device_revoked' | 'incoming_message' | 'call_status' | 'messages_read' | 'temporary_trusted_access_request' | 'temporary_device_expired' | 'channel_publication_request' | 'direct_file_transfer' | 'direct_file_transfer_status' | 'circle_owner_changed';
  schemaVersion?: number;
  serverOrigin?: string;
  vpsId?: string;
  circleId?: string;
  serverDisplayHint?: string;
  pushId?: string;
  createdAt?: number;
  expiresAt?: number;
  ttlSec?: number;
  collapseKey?: string;
  openUrl?: string;
  declineUrl?: string;
  declineToken?: string;
  displayNameHint?: string;
  senderDisplayHint?: string;
  peerIdentityId?: IdentityId;
  chatId?: string;
  channelId?: string;
  channelTitle?: string;
  callSessionId?: CallSessionId;
  directFileTransferSessionId?: DirectFileTransferSessionId;
  targetDeviceId?: DeviceId;
  directFileTransferStatus?: 'accepted' | 'rejected' | 'cancelled' | 'expired';
  callStatus?: 'missed' | 'answered_elsewhere' | 'ended';
  callEndReason?: 'cancelled' | 'timeout' | 'answered_elsewhere' | 'normal' | 'unknown' | 'signaling_disconnected' | 'superseded_by_redial';
  messageId?: string;
  dialogId?: string;
  targetIdentityId?: IdentityId;
  fromIdentityId?: IdentityId;
  fromIdentityName?: string;
  isTemporaryLinkCall?: boolean;
  callLinkTitle?: string;
  bootstrapToken?: string;
  senderIdentityName?: string;
  notificationPreview?: {
    version: 1;
    scope: 'direct' | 'group' | 'channel';
    chatId: string;
    epoch: number;
    ciphertext: string;
  };
  requestId?: string;
  identityId?: IdentityId;
  temporaryDeviceId?: DeviceId;
  nonce?: string;
  ownershipChangeId?: string;
  circleName?: string;
  ownerChangeMethod?: 'voluntary_transfer';
}

export type PushDeliveryUrgency = 'normal' | 'high';
export type MobileDeliveryClass = 'notification' | 'background' | 'call';

const USER_VISIBLE_MOBILE_PAYLOAD_TYPES = new Set<PushPayload['type']>([
  'incoming_message',
  'temporary_trusted_access_request',
  'channel_publication_request',
  'direct_file_transfer',
  'circle_owner_changed'
]);

export function mobileDeliveryClassForPayload(
  payload: Pick<PushPayload, 'type'>
): MobileDeliveryClass {
  if (payload.type === 'incoming_call') return 'call';
  return USER_VISIBLE_MOBILE_PAYLOAD_TYPES.has(payload.type)
    ? 'notification'
    : 'background';
}

export function opaqueMobileCollapseId(
  payload: Pick<PushPayload, 'collapseKey'>
): string | undefined {
  const value = String(payload.collapseKey || '').trim();
  return value
    ? crypto.createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 43)
    : undefined;
}

export function urgencyForPayload(payload: Pick<PushPayload, 'type'>): PushDeliveryUrgency {
  switch (payload.type) {
    case 'incoming_call':
    case 'call_status':
      return 'high';
    default:
      return 'normal';
  }
}

export function withTimestamps<T extends PushPayload>(payload: T, ttlMs: number): T {
  const now = Date.now();
  const safeTtlMs = Number.isFinite(ttlMs) ? Math.max(0, Math.floor(ttlMs)) : 0;
  const ttlSec = safeTtlMs > 0 ? Math.floor(safeTtlMs / 1000) : undefined;
  return {
    ...payload,
    schemaVersion: payload.schemaVersion || 1,
    createdAt: now,
    expiresAt: safeTtlMs > 0 ? now + safeTtlMs : undefined,
    ttlSec
  };
}

export function buildWebOpenUrl(params: {
  webOrigin?: string | null;
  serverOrigin?: string;
  circleId?: string;
  target?: 'call' | 'messages' | 'channel_publication_request' | 'direct_file_transfer';
  targetIdentityId?: string;
  peerIdentityId?: string;
  chatId?: string;
  channelId?: string;
  callSessionId?: string;
  directFileTransferSessionId?: string;
  callAction?: 'answer' | 'reject';
}): string | undefined {
  const origin = String(params.webOrigin || '').trim();
  if (!origin) return undefined;

  try {
    const url = new URL(origin);
    if (params.target === 'messages') {
      url.pathname = '/messages';
    } else if (params.target === 'direct_file_transfer') {
      url.pathname = '/messages';
    } else if (params.target === 'channel_publication_request' && params.targetIdentityId) {
      url.pathname = `/servers/${encodeURIComponent(params.targetIdentityId)}/channels`;
      if (params.channelId) url.searchParams.set('publicationRequestChannelId', params.channelId);
    }
    if (params.serverOrigin) url.searchParams.set('serverOrigin', params.serverOrigin);
    if (params.circleId) url.searchParams.set('circleId', params.circleId);
    if (params.peerIdentityId) url.searchParams.set('peerId', params.peerIdentityId);
    if (params.chatId) url.searchParams.set('chatId', params.chatId);
    if (params.channelId && params.target !== 'channel_publication_request') {
      url.searchParams.set('channelId', params.channelId);
    }
    if (params.callSessionId) url.searchParams.set('call', params.callSessionId);
    if (params.directFileTransferSessionId) {
      url.searchParams.set('directFileTransfer', params.directFileTransferSessionId);
      if (params.targetIdentityId) url.searchParams.set('targetIdentityId', params.targetIdentityId);
    }
    if (params.callAction) url.searchParams.set('callAction', params.callAction);
    return url.toString();
  } catch {
    return undefined;
  }
}

export function enrichMobilePayloadForBinding(
  payload: PushPayload,
  binding: { bound_web_origin: string | null; native_message_preview_mode?: 'off' | 'after_unlock' | 'always' | null },
  params: {
    familyId: string;
    targetIdentityId?: string;
    publicBaseUrl: string;
    serverOrigin: string;
    vpsId: string;
    circleId: string;
    serverDisplayHint: string;
  }
): PushPayload {
  const serverOrigin = String(params.serverOrigin || payload.serverOrigin || '').trim() || undefined;
  const circleId = String(params.circleId || payload.circleId || '').trim() || undefined;
  const serverDisplayHint = String(params.serverDisplayHint || payload.serverDisplayHint || '').trim() || undefined;
  const targetIdentityId = String(params.targetIdentityId || '').trim() as IdentityId || undefined;
  const payloadForRecipient: PushPayload = {
    ...payload,
    vpsId: params.vpsId,
    circleId,
    serverOrigin,
    targetIdentityId
  };

  switch (payload.type) {
    case 'incoming_call': {
      const familyApiBaseUrl = normalizePublicServerUrl(params.publicBaseUrl) || undefined;
      const declineUrl = familyApiBaseUrl ? `${familyApiBaseUrl}/api/mobile/calls/decline` : undefined;
      const declineToken = params.targetIdentityId && payload.callSessionId
        ? issueMobileCallActionToken({
            familyId: params.familyId,
            callSessionId: payload.callSessionId,
            targetIdentityId: params.targetIdentityId,
            action: 'decline',
            exp: Date.now() + 3 * 60 * 1000
          })
        : undefined;

      return {
        ...payloadForRecipient,
        collapseKey: payload.collapseKey || (payload.callSessionId ? `call:${payload.callSessionId}` : undefined),
        displayNameHint: payload.displayNameHint || payload.fromIdentityName,
        declineUrl: payload.declineUrl || declineUrl,
        declineToken: payload.declineToken || declineToken,
        openUrl: payload.openUrl || buildWebOpenUrl({
          webOrigin: binding.bound_web_origin,
          serverOrigin,
          circleId,
          callSessionId: payload.callSessionId
        })
      };
    }
    case 'call_status':
      return {
        ...payloadForRecipient,
        collapseKey: payload.collapseKey || (payload.callSessionId ? `call:${payload.callSessionId}` : undefined),
        openUrl: payload.openUrl || buildWebOpenUrl({
          webOrigin: binding.bound_web_origin,
          serverOrigin,
          circleId,
          callSessionId: payload.callSessionId
        })
      };
    case 'incoming_message':
      return {
        ...payloadForRecipient,
        collapseKey: payload.collapseKey || `msg:${payload.dialogId ?? payload.chatId ?? payload.peerIdentityId ?? payload.messageId}`,
        senderDisplayHint: payload.senderDisplayHint || payload.fromIdentityName,
        serverDisplayHint,
        notificationPreview: binding.native_message_preview_mode === 'always' ||
          binding.native_message_preview_mode === 'after_unlock'
          ? payload.notificationPreview
          : undefined,
        openUrl: payload.openUrl || buildWebOpenUrl({
          webOrigin: binding.bound_web_origin,
          serverOrigin,
          circleId,
          target: 'messages',
          peerIdentityId: payload.peerIdentityId,
          chatId: payload.chatId,
          channelId: payload.channelId
        })
      };
    case 'messages_read':
      return {
        ...payloadForRecipient,
        collapseKey: payload.collapseKey || `read:${payload.dialogId ?? payload.chatId ?? payload.peerIdentityId}`
      };
    case 'channel_publication_request':
      return {
        ...payloadForRecipient,
        collapseKey: payload.collapseKey || `channel-publication:${payload.channelId}`,
        openUrl: payload.openUrl || buildWebOpenUrl({
          webOrigin: binding.bound_web_origin,
          serverOrigin,
          circleId,
          target: 'channel_publication_request',
          targetIdentityId,
          channelId: payload.channelId
        })
      };
    case 'direct_file_transfer':
      return {
        ...payloadForRecipient,
        collapseKey: payload.collapseKey || `direct-file:${payload.directFileTransferSessionId || ''}`,
        senderDisplayHint: payload.senderDisplayHint || payload.fromIdentityName,
        serverDisplayHint,
        openUrl: payload.openUrl || buildWebOpenUrl({
          webOrigin: binding.bound_web_origin,
          serverOrigin,
          circleId,
          target: 'direct_file_transfer',
          targetIdentityId,
          directFileTransferSessionId: payload.directFileTransferSessionId
        })
      };
    case 'direct_file_transfer_status':
      return {
        ...payloadForRecipient,
        collapseKey: payload.collapseKey || `direct-file:${payload.directFileTransferSessionId || ''}`
      };
    default:
      return {
        ...payloadForRecipient,
        openUrl: payload.openUrl || buildWebOpenUrl({
          webOrigin: binding.bound_web_origin,
          serverOrigin,
          circleId
        })
      };
  }
}

export function ttlSecondsForPayload(payload: Pick<PushPayload, 'type'>): number {
  switch (payload.type) {
    case 'incoming_call':
      return 90;
    case 'call_status':
      return 5 * 60;
    case 'device_revoked':
      return 60 * 60;
    case 'incoming_message':
      return 24 * 60 * 60;
    case 'direct_file_transfer':
      return 10 * 60;
    case 'direct_file_transfer_status':
      return 5 * 60;
    case 'circle_owner_changed':
      return 7 * 24 * 60 * 60;
    case 'messages_read':
      return 5 * 60;
    case 'temporary_trusted_access_request':
    case 'channel_publication_request':
    case 'temporary_device_expired':
      return 60 * 60;
    default:
      return 5 * 60;
  }
}
