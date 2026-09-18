import { requireOwnDeviceEnrollmentMode, requireOwnDeviceManagement } from './ownDeviceAccess';

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('own device access', () => {
  test.each(['owner', 'member', 'guest'])('%s can manage their devices', role => {
    const next = jest.fn();
    requireOwnDeviceManagement({ identity: { role }, device: { accessLevel: 'trusted' } } as any, response() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
  test.each(['owner', 'member', 'guest', undefined])('a temporary device cannot manage devices (%s)', role => {
    const next = jest.fn(); const res = response();
    requireOwnDeviceManagement({ identity: { role }, device: { accessLevel: 'temporary' } } as any, res as any, next);
    expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(403);
  });
  test.each([undefined, 'temporary', 'anything'])('guest cannot approve mode %s', accessMode => {
    const next = jest.fn(); const res = response();
    requireOwnDeviceEnrollmentMode({ identity: { role: 'guest' }, signedRequest: { payload: { accessMode } } } as any, res as any, next);
    expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(403);
  });
  test('guest can approve trusted identity transfer without changing their role', () => {
    const next = jest.fn(); const req = { identity: { role: 'guest' }, signedRequest: { payload: { accessMode: 'full_circle' } } };
    requireOwnDeviceEnrollmentMode(req as any, response() as any, next);
    expect(next).toHaveBeenCalledTimes(1); expect(req.identity.role).toBe('guest');
  });
  test('members retain temporary enrollment', () => {
    const next = jest.fn();
    requireOwnDeviceEnrollmentMode({ identity: { role: 'member' }, signedRequest: { payload: { accessMode: 'temporary' } } } as any, response() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
