import {
  buildWebOpenUrl,
  enrichMobilePayloadForBinding,
  mobileDeliveryClassForPayload,
  opaqueMobileCollapseId,
  ttlSecondsForPayload
} from './pushPayload';
import { buildMobileCentralDeliveryBody } from './pushDeliveryTransport';

describe('provider-neutral mobile delivery metadata', () => {
  test('routes only an incoming call through the call delivery class', () => {
    expect(mobileDeliveryClassForPayload({ type: 'incoming_call' })).toBe('call');
    expect(mobileDeliveryClassForPayload({ type: 'call_status' })).toBe('background');
    expect(mobileDeliveryClassForPayload({ type: 'incoming_message' })).toBe('notification');
    expect(mobileDeliveryClassForPayload({ type: 'direct_file_transfer' })).toBe('notification');
    expect(mobileDeliveryClassForPayload({ type: 'messages_read' })).toBe('background');
  });

  test('does not expose the original collapse key to Notification Central', () => {
    const collapseId = opaqueMobileCollapseId({ collapseKey: 'call:private-session-id' });
    expect(collapseId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(collapseId).not.toContain('private-session-id');
    expect(opaqueMobileCollapseId({})).toBeUndefined();
  });

  test('serializes the versioned contract without provider-specific fields', () => {
    const body = JSON.parse(buildMobileCentralDeliveryBody({
      payload: { type: 'incoming_message' },
      deliveryClass: 'notification',
      collapseId: 'opaque-id',
      urgency: 'normal',
      ttlSec: 300
    }));
    expect(body).toEqual({
      contractVersion: 2,
      payload: { type: 'incoming_message' },
      deliveryClass: 'notification',
      collapseId: 'opaque-id',
      urgency: 'normal',
      ttlSec: 300
    });
    expect(body.provider).toBeUndefined();
    expect(body.providerToken).toBeUndefined();
    expect(body.channel).toBeUndefined();
    expect(body.environment).toBeUndefined();
  });
});

describe('channel publication push navigation', () => {
  test('opens the owner Circle directly on the Channels section', () => {
    const url = buildWebOpenUrl({
      webOrigin: 'https://app.circlus.example/',
      serverOrigin: 'https://circle.example',
      target: 'channel_publication_request',
      targetIdentityId: 'owner 1',
      channelId: 'channel/1',
    });

    expect(url).toBe(
      'https://app.circlus.example/servers/owner%201/channels?publicationRequestChannelId=channel%2F1&serverOrigin=https%3A%2F%2Fcircle.example'
    );
  });

  test('enriches the mobile payload with a stable collapsed notification and deep link', () => {
    const payload = enrichMobilePayloadForBinding(
      {
        type: 'channel_publication_request',
        channelId: 'channel-1',
        channelTitle: 'Family news',
      },
      { bound_web_origin: 'https://app.circlus.example', native_message_preview_mode: 'off' },
      {
        familyId: 'family-1',
        targetIdentityId: 'owner-1',
        publicBaseUrl: 'https://circle.example',
        serverOrigin: 'https://circle.example',
        circleId: 'circle-1',
        serverDisplayHint: 'Family',
      }
    );

    expect(payload.targetIdentityId).toBe('owner-1');
    expect(payload.collapseKey).toBe('channel-publication:channel-1');
    expect(payload.openUrl).toContain('/servers/owner-1/channels');
    expect(payload.openUrl).toContain('publicationRequestChannelId=channel-1');
    expect(ttlSecondsForPayload(payload)).toBe(60 * 60);
  });
});

describe('incoming channel message push navigation', () => {
  test('opens the channel without targeting an individual post', () => {
    const payload = enrichMobilePayloadForBinding(
      {
        type: 'incoming_message',
        dialogId: 'channel-1',
        channelId: 'channel-1',
        messageId: 'post-9',
      },
      { bound_web_origin: 'https://app.circlus.example', native_message_preview_mode: 'off' },
      {
        familyId: 'family-1',
        targetIdentityId: 'subscriber-1',
        publicBaseUrl: 'https://circle.example',
        serverOrigin: 'https://circle.example',
        circleId: 'circle-1',
        serverDisplayHint: 'Family',
      }
    );

    const openUrl = new URL(payload.openUrl!);
    expect(openUrl.pathname).toBe('/messages');
    expect(openUrl.searchParams.get('channelId')).toBe('channel-1');
    expect(openUrl.searchParams.has('messageId')).toBe(false);
  });
});

describe('native message preview modes', () => {
  const incomingMessage = {
    type: 'incoming_message' as const,
    dialogId: 'chat-1',
    messageId: 'message-1',
    notificationPreview: {
      version: 1 as const,
      scope: 'direct' as const,
      chatId: 'chat-1',
      epoch: 2,
      ciphertext: 'npv2:ciphertext'
    }
  };
  const params = {
    familyId: 'family-1',
    targetIdentityId: 'receiver-1',
    publicBaseUrl: 'https://circle.example',
    serverOrigin: 'https://circle.example',
    circleId: 'circle-1',
    serverDisplayHint: 'Family'
  };

  test.each(['always', 'after_unlock'] as const)(
    '%s includes the encrypted preview',
    (nativeMessagePreviewMode) => {
      const payload = enrichMobilePayloadForBinding(
        incomingMessage,
        {
          bound_web_origin: 'https://app.circlus.example',
          native_message_preview_mode: nativeMessagePreviewMode
        },
        params
      );

      expect(payload.notificationPreview).toEqual(incomingMessage.notificationPreview);
    }
  );

  test('off omits the encrypted preview', () => {
    const payload = enrichMobilePayloadForBinding(
      incomingMessage,
      {
        bound_web_origin: 'https://app.circlus.example',
        native_message_preview_mode: 'off'
      },
      params
    );

    expect(payload.notificationPreview).toBeUndefined();
  });

  test('a missing legacy mode defaults to omitting the encrypted preview', () => {
    const payload = enrichMobilePayloadForBinding(
      incomingMessage,
      { bound_web_origin: 'https://app.circlus.example' },
      params
    );

    expect(payload.notificationPreview).toBeUndefined();
  });
});

describe('direct file transfer push navigation', () => {
  test('addresses the exact local identity and short-lived transfer session', () => {
    const payload = enrichMobilePayloadForBinding(
      {
        type: 'direct_file_transfer',
        directFileTransferSessionId: 'dft-1',
        fromIdentityName: 'Alice'
      },
      { bound_web_origin: 'https://app.circlus.example', native_message_preview_mode: 'off' },
      {
        familyId: 'family-1',
        targetIdentityId: 'receiver-1',
        publicBaseUrl: 'https://circle.example',
        serverOrigin: 'https://circle.example',
        circleId: 'circle-1',
        serverDisplayHint: 'Family'
      }
    );

    const openUrl = new URL(payload.openUrl!);
    expect(openUrl.pathname).toBe('/messages');
    expect(openUrl.searchParams.get('directFileTransfer')).toBe('dft-1');
    expect(openUrl.searchParams.get('targetIdentityId')).toBe('receiver-1');
    expect(payload.collapseKey).toBe('direct-file:dft-1');
    expect(ttlSecondsForPayload(payload)).toBe(10 * 60);
  });

  test('uses the same collapse key for terminal status so stale notifications are replaced', () => {
    const payload = enrichMobilePayloadForBinding(
      {
        type: 'direct_file_transfer_status',
        directFileTransferSessionId: 'dft-1',
        directFileTransferStatus: 'accepted'
      },
      { bound_web_origin: 'https://app.circlus.example', native_message_preview_mode: 'off' },
      {
        familyId: 'family-1',
        targetIdentityId: 'receiver-1',
        publicBaseUrl: 'https://circle.example',
        serverOrigin: 'https://circle.example',
        circleId: 'circle-1',
        serverDisplayHint: 'Family'
      }
    );

    expect(payload.collapseKey).toBe('direct-file:dft-1');
    expect(payload.openUrl).toBeUndefined();
    expect(ttlSecondsForPayload(payload)).toBe(5 * 60);
  });
});
