jest.mock('../middleware/auth', () => ({
  verifySignature: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireActiveIdentity: (_req: unknown, _res: unknown, next: () => void) => next(),
  getSignedPayload: (req: { signedRequest?: { payload?: unknown } }) => req.signedRequest?.payload || {},
}));
jest.mock('../services/versionedAccessOperation', () => ({ versionedAccessOperation: (handler: unknown) => handler }));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../db/repositories', () => ({
  announcementChannelRepository: { findById: jest.fn(), findSubscriptionForIdentity: jest.fn() },
  directGuestRegistrationRepository: { findActiveByHost: jest.fn(), updatePermissionsByHost: jest.fn() },
  systemEventRepository: { createEventId: jest.fn(() => 'offer-1'), insertEvent: jest.fn() },
}));
jest.mock('../services/directGuestAccessService', () => ({ mapDirectGuestPermissionsFromDb: jest.fn(() => ({ canMessage: true })) }));
jest.mock('../ws/wsGateway', () => ({ sendToIdentityWs: jest.fn() }));
jest.mock('../utils/routeLogger', () => ({ routeLogger: { error: jest.fn() } }));

import router from './directGuestChatOfferRoutes';
import { query } from '../db';
import { announcementChannelRepository, directGuestRegistrationRepository, systemEventRepository } from '../db/repositories';

function handler(path: string) {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path);
  return layer.route.stack.at(-1).handle as (req: any, res: any) => Promise<void>;
}
function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}
const hostRequest = {
  familyId: 'family-1', params: { registrationId: 'reg-1' },
  device: { identityId: 'host-1' }, identity: { role: 'owner' },
  signedRequest: { payload: { channelId: 'channel-1' } },
};
const registration = { registration_id: 'reg-1', host_identity_id: 'host-1', guest_identity_id: 'guest-1', can_message: false };

beforeEach(() => {
  jest.clearAllMocks();
  (directGuestRegistrationRepository.findActiveByHost as jest.Mock).mockResolvedValue(registration);
  (announcementChannelRepository.findById as jest.Mock).mockResolvedValue({ owner_identity_id: 'host-1', status: 'active' });
  (announcementChannelRepository.findSubscriptionForIdentity as jest.Mock).mockResolvedValue({ status: 'active' });
  (query as jest.Mock).mockImplementation(async (sql: string) => ({ rows: sql.includes('family_config')
    ? [{ circle_id: 'circle-1' }] : [] }));
});

test('a host cannot offer chat without an active subscription', async () => {
  (announcementChannelRepository.findSubscriptionForIdentity as jest.Mock).mockResolvedValue({ status: 'unsubscribed' });
  const res = response();
  await handler('/registrations/:registrationId/chat-offer')(hostRequest, res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(systemEventRepository.insertEvent).not.toHaveBeenCalled();
});

test('an eligible subscriber receives a durable personal chat offer', async () => {
  const res = response();
  await handler('/registrations/:registrationId/chat-offer')(hostRequest, res);
  expect(systemEventRepository.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
    recipientIdentityId: 'guest-1', type: 'invite:direct-chat',
    payload: expect.objectContaining({ registrationId: 'reg-1', channelId: 'channel-1' }),
  }));
  expect(res.json).toHaveBeenCalledWith({ status: 'ok', result: { eventId: 'offer-1' } });
});

test('a different guest cannot accept a subscriber offer', async () => {
  (query as jest.Mock).mockResolvedValue({ rows: [] });
  const res = response();
  await handler('/chat-offers/:eventId/accept')({
    familyId: 'family-1', params: { eventId: 'offer-1' },
    device: { identityId: 'other-guest' }, identity: { role: 'guest' },
  }, res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(directGuestRegistrationRepository.updatePermissionsByHost).not.toHaveBeenCalled();
});

test('an unrelated identity cannot end a guest chat', async () => {
  const res = response();
  await handler('/registrations/:registrationId/chat-end')({
    familyId: 'family-1', params: { registrationId: 'reg-1' },
    device: { identityId: 'stranger' }, identity: { role: 'member' },
    signedRequest: { payload: { hostIdentityId: 'host-1' } },
  }, res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(directGuestRegistrationRepository.updatePermissionsByHost).not.toHaveBeenCalled();
});
