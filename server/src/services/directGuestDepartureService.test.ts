jest.mock('../db', () => ({
  pool: { query: jest.fn() },
  transaction: jest.fn(async (callback: any) => callback({})),
  inTransactionContext: jest.fn(async (_client: any, callback: any) => callback()),
}));
jest.mock('../db/repositories', () => ({
  identityRepository: { findByIdentityId: jest.fn() },
  systemEventRepository: { createEventId: jest.fn(() => 'event'), insertEvent: jest.fn() },
}));
jest.mock('./configService', () => ({ configService: { getFamilyConfig: jest.fn(async () => ({ public_base_url: 'https://circle.test' })) } }));
import nacl from 'tweetnacl';
import { createSignatureMessage } from '../../../shared/signatureMessage';
import { pool, inTransactionContext } from '../db';
import { identityRepository, systemEventRepository } from '../db/repositories';
import { commitDirectGuestDeparture } from './directGuestDepartureService';
import type { DirectGuestDeparture } from '../../../shared/directGuestDeparture';

const pair = nacl.sign.keyPair();
const row = { registration_id: 'registration', family_id: 'family', host_identity_id: 'host', guest_identity_id: 'guest', link_id: 'link', status: 'active' };
function proof(): DirectGuestDeparture {
  const unsigned = { type: 'direct-guest:departure', signerId: 'guest', timestamp: Date.now(), nonce: 'nonce', payload: {
    version: 1 as const, purpose: 'circlus-direct-guest-departure-v1' as const,
    circleOrigin: 'https://circle.test', registrationId: 'registration', linkId: 'link', hostIdentityId: 'host', guestIdentityId: 'guest',
  } };
  return { ...unsigned, signature: Buffer.from(nacl.sign.detached(Buffer.from(createSignatureMessage(unsigned)), pair.secretKey)).toString('base64') };
}
beforeEach(() => {
  jest.clearAllMocks();
  (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [row] }).mockResolvedValue({ rows: [{ ...row, status: 'deleted_by_guest' }] });
  (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ public_key_algorithm: 'ed25519', public_key_value: Buffer.from(pair.publicKey).toString('base64') });
  (systemEventRepository.insertEvent as jest.Mock).mockResolvedValue(undefined);
});

test('stores the proof and durable events for the host and guest devices in the same transaction', async () => {
  const departure = proof();
  const result = await commitDirectGuestDeparture({ familyId: 'family', guestIdentityId: 'guest', departure });
  expect(inTransactionContext).toHaveBeenCalledTimes(1);
  expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining('FOR UPDATE'), ['family', 'guest']);
  expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining('departure_proof = $3::jsonb'), ['family', 'registration', JSON.stringify(departure)]);
  expect(systemEventRepository.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ recipientIdentityId: 'host', type: 'direct-guest:departed', payload: expect.objectContaining({ departure }) }));
  expect(systemEventRepository.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ recipientIdentityId: 'guest', payload: expect.objectContaining({ departure }) }));
  expect(systemEventRepository.insertEvent).toHaveBeenCalledTimes(2);
  expect(result.guestEvent?.recipientIdentityId).toBe('guest');
  expect(result.registration.status).toBe('deleted_by_guest');
});

test.each(['registrationId', 'linkId', 'hostIdentityId', 'guestIdentityId', 'circleOrigin'])('rejects substituted %s without changing access', async (field) => {
  const departure = proof();
  (departure.payload as any)[field] = 'other';
  await expect(commitDirectGuestDeparture({ familyId: 'family', guestIdentityId: 'guest', departure })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  expect(pool.query).toHaveBeenCalledTimes(1);
  expect(systemEventRepository.insertEvent).not.toHaveBeenCalled();
});

test('requires a guest identity proof, not just an authenticated device request', async () => {
  await expect(commitDirectGuestDeparture({ familyId: 'family', guestIdentityId: 'guest' })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test('rejects a forged signature even with a matching payload', async () => {
  const departure = proof();
  departure.signature = Buffer.from(nacl.sign.detached(Buffer.from('wrong message'), pair.secretKey)).toString('base64');
  await expect(commitDirectGuestDeparture({ familyId: 'family', guestIdentityId: 'guest', departure })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test('retries do not overwrite the original proof or send duplicate notifications', async () => {
  (pool.query as jest.Mock).mockReset().mockResolvedValue({ rows: [{ ...row, status: 'deleted_by_guest', departure_proof: proof() }] });
  const result = await commitDirectGuestDeparture({ familyId: 'family', guestIdentityId: 'guest', departure: proof() });
  expect(result.event).toBeNull();
  expect(result.guestEvent).toBeNull();
  expect(pool.query).toHaveBeenCalledTimes(1);
  expect(systemEventRepository.insertEvent).not.toHaveBeenCalled();
});

test('notification persistence failure rejects the enclosing transaction', async () => {
  (systemEventRepository.insertEvent as jest.Mock).mockRejectedValue(new Error('storage unavailable'));
  await expect(commitDirectGuestDeparture({ familyId: 'family', guestIdentityId: 'guest', departure: proof() })).rejects.toThrow('storage unavailable');
});
