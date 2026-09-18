import { resolveIdentityAuthorization } from './authorizationResolver';

describe('identity authorization resolver', () => {
  test('keeps guest invitation delegation independent of Circle role', () => {
    const guest = resolveIdentityAuthorization({ status: 'active', role: 'guest', canCreateGuestInvites: true });
    expect(guest.createGuestInvites).toBe(true);
    expect(guest.fullCircleMember).toBe(false);
    expect(guest.createCircleInvites).toBe(false);
  });

  test('does not let a disabled identity retain delegated capabilities', () => {
    const disabled = resolveIdentityAuthorization({ status: 'disabled', role: 'member', canCreateCircleInvites: true, canCreateGuestInvites: true });
    expect(disabled.active).toBe(false);
    expect(disabled.createCircleInvites).toBe(false);
    expect(disabled.createGuestInvites).toBe(false);
  });

  test('grants the owner administrative and invitation capabilities', () => {
    expect(resolveIdentityAuthorization({ status: 'active', role: 'owner' })).toMatchObject({
      manageCircle: true,
      fullCircleMember: true,
      createCircleInvites: true,
      createGuestInvites: true
    });
  });
});
