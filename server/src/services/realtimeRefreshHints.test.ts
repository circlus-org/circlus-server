jest.mock('../db', () => ({ query: jest.fn(), afterCommit: jest.fn((callback: () => void) => callback()) }));
jest.mock('../ws/wsGateway', () => ({ sendToIdentityWs: jest.fn() }));
jest.mock('../utils/routeLogger', () => ({ routeLogger: { warn: jest.fn() } }));

import { afterCommit, query } from '../db';
import { sendToIdentityWs } from '../ws/wsGateway';
import { notifyDirectGuestPermissionsChanged, notifyPresenceVisibilityChanged } from './realtimeRefreshHints';

const mockedQuery = query as jest.Mock;
const mockedSend = sendToIdentityWs as jest.Mock;

beforeEach(() => {
  mockedQuery.mockReset();
  mockedSend.mockReset();
});

test('presence visibility hint reaches only identities allowed to read that presence', async () => {
  mockedQuery.mockResolvedValue({ rows: [{ identity_id: 'MEMBER' }, { identity_id: 'GUEST' }] });
  notifyPresenceVisibilityChanged('circle-1', 'OWNER' as never);
  await new Promise(resolve => setImmediate(resolve));

  const [sql, params] = mockedQuery.mock.calls[0];
  expect(sql).toContain(`role IN ('owner', 'member')`);
  expect(sql).toContain('direct_guest_registrations');
  expect(params).toEqual(['circle-1', 'OWNER']);
  expect(mockedSend.mock.calls.map(([familyId, identityId]) => [familyId, identityId]))
    .toEqual([['circle-1', 'MEMBER'], ['circle-1', 'GUEST']]);
  expect(mockedSend.mock.calls[0][2]).toMatchObject({
    type: 'presence:visibility-changed',
    data: { identityId: 'OWNER' }
  });
});

test('presence visibility hint failure does not reject the caller', async () => {
  mockedQuery.mockRejectedValue(new Error('db down'));
  notifyPresenceVisibilityChanged('circle-1', 'OWNER' as never);
  await new Promise(resolve => setImmediate(resolve));
  expect(mockedSend).not.toHaveBeenCalled();
});

test('hints wait for the surrounding transaction to commit', () => {
  const pending: Array<() => void> = [];
  (afterCommit as jest.Mock).mockImplementationOnce((callback: () => void) => { pending.push(callback); });
  notifyDirectGuestPermissionsChanged('circle-1', {
    registrationId: 'dgr_1', hostIdentityId: 'HOST' as never, guestIdentityId: 'GUEST' as never
  });
  expect(mockedSend).not.toHaveBeenCalled();
  pending[0]();
  expect(mockedSend).toHaveBeenCalledTimes(2);
});

test('guest permissions hint reaches both peers of the registration in its Circle', () => {
  notifyDirectGuestPermissionsChanged('circle-1', {
    registrationId: 'dgr_1', hostIdentityId: 'HOST' as never, guestIdentityId: 'GUEST' as never
  });
  expect(mockedSend.mock.calls.map(([familyId, identityId]) => [familyId, identityId]))
    .toEqual([['circle-1', 'HOST'], ['circle-1', 'GUEST']]);
  expect(mockedSend.mock.calls[1][2]).toMatchObject({
    type: 'direct-guest:permissions-changed',
    data: { registrationId: 'dgr_1', hostIdentityId: 'HOST', guestIdentityId: 'GUEST' }
  });
});
