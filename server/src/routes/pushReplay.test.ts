jest.mock('../services/durableNonce', () => { const used = new Set<string>(); return { claimDurableNonce: jest.fn(async (signer: string, nonce: string) => {const key = signer+':'+nonce;if (used.has(key)) return false;used.add(key);return true;}) }; });
jest.mock('../services/reliableOperation', () => ({ reliableOperation: (handler: unknown) => handler }));
jest.mock('../db/repositories', () => ({
  deviceRepository: { findByDeviceId: jest.fn() },
  temporaryDeviceRepository: { findByDeviceId: jest.fn() },
  pushSubscriptionRepository: { findByDeviceAndEndpoint: jest.fn(), updateStatus: jest.fn() }
}));
jest.mock('../utils/crypto', () => ({ verifySignedRequest: jest.fn(() => true) }));
jest.mock('../utils/push', () => ({
  getPushVapidKey: jest.fn(), isRelayDeliveryEnabled: jest.fn(), getPushServiceUrl: jest.fn()
}));

import router from './push';
import { deviceRepository, pushSubscriptionRepository } from '../db/repositories';
import { verifySignedRequest } from '../utils/crypto';

const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/unsubscribe').route.stack.at(-1).handle;

async function unsubscribe(body: Record<string, unknown>) {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const req = { familyId: 'family-1', body, route: {path:'/unsubscribe'} };
  const auth = (router as any).stack.find((layer: any) => layer.route?.path === '/unsubscribe').route.stack.at(-2).handle;
  let allowed=false;
  await auth(req,response,()=>{allowed=true;});
  if (allowed) await handler(req, response);
  return response;
}

function request(nonce: string, overrides: Record<string, unknown> = {}) {
  return { type: 'push:unsubscribe', signerId: 'device-1', signature: 'signed', timestamp: Date.now(), nonce,
    payload: { endpoint: 'https://push.example/subscription' }, ...overrides };
}

describe('push mutation replay protection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (verifySignedRequest as jest.Mock).mockReturnValue(true);
    (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue({
      device_id: 'device-1', status: 'active', public_key_algorithm: 'ed25519', public_key_value: 'key'
    });
    (pushSubscriptionRepository.findByDeviceAndEndpoint as jest.Mock).mockResolvedValue({ push_id: 'push-1' });
    (pushSubscriptionRepository.updateStatus as jest.Mock).mockResolvedValue(undefined);
  });

  test('rejects stale and wrong-operation requests before accessing the signer', async () => {
    const stale = await unsubscribe(request('push-stale', { timestamp: 1 }));
    const wrongType = await unsubscribe(request('push-wrong-type', { type: 'devices:list' }));
    expect(stale.status).toHaveBeenCalledWith(401);
    expect(wrongType.status).toHaveBeenCalledWith(400);
    expect(deviceRepository.findByDeviceId).not.toHaveBeenCalled();
  });

  test('rejects concurrent and later copies of the same signed unsubscribe', async () => {
    const body = request('push-concurrent-regression');
    const responses = await Promise.all([unsubscribe(body), unsubscribe(body)]);
    expect(pushSubscriptionRepository.updateStatus).toHaveBeenCalledTimes(1);
    expect(responses.filter((res) => res.status.mock.calls.some(([code]) => code === 401))).toHaveLength(1);
    expect((await unsubscribe(body)).status).toHaveBeenCalledWith(401);
    expect(pushSubscriptionRepository.updateStatus).toHaveBeenCalledTimes(1);
  });

  test('a bad signature cannot consume the nonce of a valid request', async () => {
    const body = request('push-invalid-signature');
    (verifySignedRequest as jest.Mock).mockReturnValueOnce(false);
    expect((await unsubscribe(body)).status).toHaveBeenCalledWith(401);
    expect((await unsubscribe(body)).json).toHaveBeenCalledWith({ success: true });
  });
});
