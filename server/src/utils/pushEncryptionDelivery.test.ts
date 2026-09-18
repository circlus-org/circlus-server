import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

describe('encrypted push delivery invariant', () => {
  const originalEnv = { ...process.env };
  const fetchMock = jest.fn<(url: string, init: { body: string }) => Promise<any>>();
  const encryptedEnvelope = {
    type: 'encrypted',
    v: 1,
    epk: 'epk',
    salt: 'salt',
    iv: 'iv',
    tag: 'tag',
    ct: 'ciphertext'
  };
  const encryptPushPayloadMock = jest.fn<(key: string, payload: any) => typeof encryptedEnvelope>(() => encryptedEnvelope);

  const repositories = {
    pushSubscriptionRepository: {
      findActiveByDeviceId: jest.fn<() => Promise<any[]>>(),
      updateSubscription: jest.fn<() => Promise<any>>(),
      updateStatus: jest.fn<() => Promise<any>>()
    },
    mobileNotificationRepository: {
      getActiveBindingByWebDeviceId: jest.fn<() => Promise<any>>(),
      unbindToWebPush: jest.fn<(familyId: string, webDeviceId: string) => Promise<any>>()
    },
    deviceRepository: {
      findActiveByIdentityId: jest.fn<() => Promise<any[]>>()
    },
    identityRepository: {
      findByIdentityId: jest.fn<() => Promise<any>>()
    }
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    repositories.pushSubscriptionRepository.findActiveByDeviceId.mockReset().mockResolvedValue([]);
    repositories.pushSubscriptionRepository.updateSubscription.mockReset();
    repositories.pushSubscriptionRepository.updateStatus.mockReset();
    repositories.mobileNotificationRepository.getActiveBindingByWebDeviceId.mockReset().mockResolvedValue(null);
    repositories.mobileNotificationRepository.unbindToWebPush.mockReset();
    repositories.deviceRepository.findActiveByIdentityId.mockReset().mockResolvedValue([]);
    repositories.identityRepository.findByIdentityId.mockReset().mockResolvedValue({ status: 'active' });
    encryptPushPayloadMock.mockReturnValue(encryptedEnvelope);
    process.env = {
      ...originalEnv,
      ENABLE_RELAY_DELIVERY: 'true',
      PUSH_SERVICE_URL: 'https://push.example.test',
      VPS_ID: 'vps-test',
      PUSH_SERVICE_CLIENT_ID: 'test-server',
      PUSH_SERVICE_SHARED_SECRET: Buffer.alloc(32, 4).toString('base64')
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}'
    });
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    delete (global as any).fetch;
  });

  async function importPushModule() {
    jest.doMock('../db/repositories', () => repositories);
    jest.doMock('./pushServiceS2S', () => ({
      signPushServiceRequest: () => ({})
    }));
    jest.doMock('./mobileCallActionToken', () => ({
      issueMobileCallActionToken: () => 'token'
    }));
    jest.doMock('./serverIdentity', () => ({
      normalizePublicServerUrl: (value: string) => value,
      resolveServerIdForClients: () => 'server',
      resolveServerOriginForClients: () => 'https://family.example.test'
    }));
    jest.doMock('../services/configService', () => ({
      configService: {
        requireFamilyConfig: jest.fn()
      }
    }));
    jest.doMock('./pushEncryption', () => ({
      encryptPushPayload: encryptPushPayloadMock
    }));

    return import('./push');
  }

  test('defensively skips corrupt web relay subscriptions without an encryption key', async () => {
    repositories.mobileNotificationRepository.getActiveBindingByWebDeviceId.mockResolvedValue(null);
    repositories.pushSubscriptionRepository.findActiveByDeviceId.mockResolvedValue([
      {
        push_id: 'push_1',
        endpoint: 'https://browser-push.example.test/endpoint',
        keys_p256dh: 'p256dh',
        keys_auth: 'auth',
        relay_token: 'relay-token',
        delivery_method: 'relay',
        push_encryption_public_key: null
      }
    ]);

    const { sendPushToDevice } = await importPushModule();

    const result = await sendPushToDevice(
      'family_1',
      'device_1' as any,
      { type: 'incoming_message', messageId: 'msg_1' },
      'identity_1' as any,
      'https://family.example.test',
      'https://family.example.test',
      'server_1',
      'Family Server'
    );

    expect(result).toMatchObject({
      attempted: 1,
      sent: 0,
      skipped: 1,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not deliver push notifications to a suspended identity', async () => {
    repositories.identityRepository.findByIdentityId.mockResolvedValueOnce({ status: 'disabled' });
    const { sendPushToIdentity } = await importPushModule();

    const result = await sendPushToIdentity(
      'family_1',
      'identity_1' as any,
      { type: 'incoming_message', messageId: 'msg_1' }
    );

    expect(result).toEqual({
      identityId: 'identity_1',
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
    });
    expect(repositories.deviceRepository.findActiveByIdentityId).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sends only an encrypted envelope for web relay subscriptions with an encryption key', async () => {
    repositories.mobileNotificationRepository.getActiveBindingByWebDeviceId.mockResolvedValue(null);
    repositories.pushSubscriptionRepository.findActiveByDeviceId.mockResolvedValue([
      {
        push_id: 'push_1',
        endpoint: 'https://browser-push.example.test/endpoint',
        keys_p256dh: 'p256dh',
        keys_auth: 'auth',
        relay_token: 'relay-token',
        delivery_method: 'relay',
        push_encryption_public_key: 'spki-public-key'
      }
    ]);

    const { sendPushToDevice } = await importPushModule();

    const result = await sendPushToDevice(
      'family_1',
      'device_1' as any,
      { type: 'incoming_message', messageId: 'msg_1', fromIdentityName: 'Alice' },
      'identity_1' as any,
      'https://family.example.test',
      'https://family.example.test',
      'server_1',
      'Family Server'
    );

    expect(result).toMatchObject({
      attempted: 1,
      sent: 1,
      skipped: 0,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({
      token: 'relay-token',
      payload: encryptedEnvelope,
      urgency: 'normal',
      ttlSec: 24 * 60 * 60
    });
    expect(JSON.stringify(body)).not.toContain('Alice');
    expect(JSON.stringify(body)).not.toContain('msg_1');
  });

  test('marks incoming calls as high urgency while keeping the relay payload encrypted', async () => {
    repositories.mobileNotificationRepository.getActiveBindingByWebDeviceId.mockResolvedValue(null);
    repositories.pushSubscriptionRepository.findActiveByDeviceId.mockResolvedValue([
      {
        push_id: 'push_1',
        endpoint: 'https://browser-push.example.test/endpoint',
        keys_p256dh: 'p256dh',
        keys_auth: 'auth',
        relay_token: 'relay-token',
        delivery_method: 'relay',
        push_encryption_public_key: 'spki-public-key'
      }
    ]);

    const { sendPushToDevice } = await importPushModule();
    const result = await sendPushToDevice(
      'family_1',
      'device_1' as any,
      { type: 'incoming_call', callSessionId: 'call_1', fromIdentityName: 'Alice' },
      'identity_1' as any,
      'https://family.example.test',
      'https://family.example.test',
      'server_1',
      'Family Server'
    );

    expect(result).toMatchObject({ attempted: 1, sent: 1, skipped: 0, failed: 0 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({
      token: 'relay-token',
      payload: encryptedEnvelope,
      urgency: 'high',
      ttlSec: 90
    });
    expect(JSON.stringify(body)).not.toContain('Alice');
    expect(JSON.stringify(body)).not.toContain('call_1');
  });

  test('falls back to web relay subscriptions when a mobile binding has no active delivery token', async () => {
    repositories.mobileNotificationRepository.getActiveBindingByWebDeviceId.mockResolvedValue({
      route: 'mobile_push',
      mobile_endpoint_id: 'mobile_endpoint_1',
      mobile_endpoint_ref: null,
      web_device_id: 'device_1',
      bound_web_origin: 'https://client.example.test',
      delivery_token: null,
      delivery_token_expires_at: null
    });
    repositories.pushSubscriptionRepository.findActiveByDeviceId.mockResolvedValue([
      {
        push_id: 'push_1',
        endpoint: 'https://browser-push.example.test/endpoint',
        keys_p256dh: 'p256dh',
        keys_auth: 'auth',
        relay_token: 'relay-token',
        delivery_method: 'relay',
        push_encryption_public_key: 'spki-public-key'
      }
    ]);

    const { sendPushToDevice } = await importPushModule();

    const result = await sendPushToDevice(
      'family_1',
      'device_1' as any,
      { type: 'incoming_message', messageId: 'msg_1', fromIdentityName: 'Alice' },
      'identity_1' as any,
      'https://family.example.test',
      'https://family.example.test',
      'server_1',
      'Family Server'
    );

    expect(repositories.mobileNotificationRepository.unbindToWebPush).toHaveBeenCalledWith('family_1', 'device_1');
    expect(result).toMatchObject({
      attempted: 1,
      sent: 1,
      skipped: 1,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('falls back to web relay subscriptions when a mobile binding has no encryption key', async () => {
    repositories.mobileNotificationRepository.getActiveBindingByWebDeviceId.mockResolvedValue({
      route: 'mobile_push',
      mobile_endpoint_id: 'mobile_endpoint_1',
      mobile_endpoint_ref: null,
      web_device_id: 'device_1',
      bound_web_origin: 'https://client.example.test',
      delivery_token: 'delivery-token',
      delivery_token_expires_at: new Date(Date.now() + 60_000),
      push_encryption_public_key: null
    });
    repositories.pushSubscriptionRepository.findActiveByDeviceId.mockResolvedValue([
      {
        push_id: 'push_1',
        endpoint: 'https://browser-push.example.test/endpoint',
        keys_p256dh: 'p256dh',
        keys_auth: 'auth',
        relay_token: 'relay-token',
        delivery_method: 'relay',
        push_encryption_public_key: 'spki-public-key'
      }
    ]);

    const { sendPushToDevice } = await importPushModule();

    const result = await sendPushToDevice(
      'family_1',
      'device_1' as any,
      { type: 'incoming_message', messageId: 'msg_1' },
      'identity_1' as any,
      'https://family.example.test',
      'https://family.example.test',
      'server_1',
      'Family Server'
    );

    expect(repositories.mobileNotificationRepository.unbindToWebPush).toHaveBeenCalledWith('family_1', 'device_1');
    expect(result).toMatchObject({
      attempted: 2,
      sent: 1,
      skipped: 1,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('sends mobile push using the encryption key stored on the binding', async () => {
    repositories.mobileNotificationRepository.getActiveBindingByWebDeviceId.mockResolvedValue({
      route: 'mobile_push',
      mobile_endpoint_id: null,
      mobile_endpoint_ref: 'mobile_endpoint_1',
      web_device_id: 'device_1',
      bound_web_origin: 'https://client.example.test',
      delivery_token: 'delivery-token',
      delivery_token_expires_at: new Date(Date.now() + 60_000),
      push_encryption_public_key: 'binding-spki-public-key'
    });

    const { sendPushToDevice } = await importPushModule();

    const result = await sendPushToDevice(
      'family_1',
      'device_1' as any,
      { type: 'incoming_message', messageId: 'msg_1', fromIdentityName: 'Alice' },
      'identity_1' as any,
      'https://family.example.test',
      'https://family.example.test',
      'server_1',
      'Family Server'
    );

    expect(encryptPushPayloadMock).toHaveBeenCalledWith(
      'binding-spki-public-key',
      expect.objectContaining({ messageId: 'msg_1' })
    );
    expect(result).toMatchObject({
      attempted: 1,
      sent: 1,
      skipped: 0,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('sends only an encrypted envelope for mobile bindings with an encryption key', async () => {
    repositories.mobileNotificationRepository.getActiveBindingByWebDeviceId.mockResolvedValue({
      route: 'mobile_push',
      mobile_endpoint_id: 'mobile_endpoint_1',
      mobile_endpoint_ref: null,
      web_device_id: 'device_1',
      bound_web_origin: 'https://client.example.test',
      delivery_token: 'delivery-token',
      delivery_token_expires_at: new Date(Date.now() + 60_000),
      push_encryption_public_key: 'spki-public-key'
    });

    const { sendPushToDevice } = await importPushModule();

    const result = await sendPushToDevice(
      'family_1',
      'device_1' as any,
      { type: 'incoming_message', messageId: 'msg_1', fromIdentityName: 'Alice' },
      'identity_1' as any,
      'https://family.example.test',
      'https://family.example.test',
      'server_1',
      'Family Server'
    );

    expect(result).toMatchObject({
      attempted: 1,
      sent: 1,
      skipped: 0,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({
      contractVersion: 2,
      payload: encryptedEnvelope,
      deliveryClass: 'notification',
      collapseId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      urgency: 'normal',
      ttlSec: 24 * 60 * 60
    });
    expect(body.provider).toBeUndefined();
    expect(body.providerToken).toBeUndefined();
    expect(body.channel).toBeUndefined();
    expect(body.environment).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Alice');
    expect(JSON.stringify(body)).not.toContain('msg_1');
  });

  test('preserves the safe central error reason for mobile delivery diagnostics', async () => {
    repositories.mobileNotificationRepository.getActiveBindingByWebDeviceId.mockResolvedValue({
      route: 'mobile_push',
      mobile_endpoint_id: 'mobile_endpoint_1',
      mobile_endpoint_ref: null,
      web_device_id: 'device_1',
      bound_web_origin: 'https://client.example.test',
      delivery_token: 'delivery-token',
      delivery_token_expires_at: new Date(Date.now() + 60_000),
      push_encryption_public_key: 'spki-public-key'
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        success: false,
        error: 'Token revoked or unknown',
        internalDetail: 'must-not-be-copied-to-family-server-logs'
      })
    });

    const { sendPushToDevice } = await importPushModule();
    const result = await sendPushToDevice(
      'family_1',
      'device_1' as any,
      { type: 'incoming_message', messageId: 'msg_1' },
      'identity_1' as any,
      'https://family.example.test',
      'https://family.example.test',
      'server_1',
      'Family Server'
    );

    expect(result).toMatchObject({
      attempted: 1,
      sent: 0,
      failed: 1,
      failures: [{
        statusCode: 401,
        serviceError: 'Token revoked or unknown',
        message: 'Mobile central push failed with status 401'
      }]
    });
    expect(JSON.stringify(result)).not.toContain('must-not-be-copied');
  });
});
