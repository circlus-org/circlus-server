import { signIceConfigServiceRequest } from '../utils/iceConfigServiceS2S';
import { signPushServiceRequest } from '../utils/pushServiceS2S';
import {
  issueMobileCallActionToken,
  verifyMobileCallActionToken
} from '../utils/mobileCallActionToken';
import {
  issueMobileCallBootstrapToken,
  verifyMobileCallBootstrapToken
} from '../utils/mobileCallBootstrapToken';

describe('typed integration runtime config consumers', () => {
  const originalEnv = { ...process.env };
  const sharedSecret = Buffer.alloc(32, 9).toString('base64');

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      VPS_ID: 'server-1',
      ICE_CONFIG_SERVICE_URL: 'https://ice.example.test',
      ICE_CONFIG_SHARED_SECRET: sharedSecret,
      PUSH_SERVICE_URL: 'https://push.example.test',
      PUSH_SERVICE_CLIENT_ID: 'server-1',
      PUSH_SERVICE_SHARED_SECRET: sharedSecret,
      MOBILE_CALL_ACTION_SECRET: 'm'.repeat(32)
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('signs ICE and push-service requests from validated config', () => {
    const iceHeaders = signIceConfigServiceRequest({
      method: 'POST',
      path: '/v1/ice-servers',
      body: '{}'
    });
    expect(iceHeaders).toMatchObject({
      'X-Ice-Server-Id': 'server-1',
      'X-Ice-Key-Id': 'k1'
    });
    expect(iceHeaders['X-Ice-Signature']).toBeTruthy();

    const pushHeaders = signPushServiceRequest({
      method: 'POST',
      path: '/api/push/relay/send',
      body: '{}'
    });
    expect(pushHeaders).toMatchObject({
      'X-Push-Client-Id': 'server-1',
      'X-Push-Key-Id': 'k1'
    });
    expect(pushHeaders['X-Push-Signature']).toBeTruthy();
  });

  it('round-trips mobile action and bootstrap tokens', () => {
    const exp = Date.now() + 60_000;
    const actionPayload = {
      familyId: 'family-1',
      callSessionId: 'call-1',
      targetIdentityId: 'identity-1',
      action: 'decline' as const,
      exp
    };
    expect(verifyMobileCallActionToken(issueMobileCallActionToken(actionPayload)))
      .toEqual(actionPayload);

    const bootstrapPayload = {
      familyId: 'family-1',
      callSessionId: 'call-1',
      targetIdentityId: 'identity-1',
      exp
    };
    expect(verifyMobileCallBootstrapToken(issueMobileCallBootstrapToken(bootstrapPayload)))
      .toEqual(bootstrapPayload);
  });

  it('keeps mobile integration optional until a token is requested', () => {
    delete process.env.MOBILE_CALL_ACTION_SECRET;
    expect(() => issueMobileCallBootstrapToken({
      familyId: 'family-1',
      callSessionId: 'call-1',
      targetIdentityId: 'identity-1',
      exp: Date.now() + 60_000
    })).toThrow('MOBILE_CALL_ACTION_SECRET must be configured');
  });
});
