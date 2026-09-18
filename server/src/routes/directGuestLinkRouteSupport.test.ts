import {
  requireGuestLinkCreationAccess,
  requireGuestLinkManagementAccess
} from './directGuestLinkRouteSupport';

function makeResponse() {
  const response = {
    status: jest.fn(),
    json: jest.fn()
  };
  response.status.mockReturnValue(response);
  return response;
}

describe('direct guest link Circle policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('keeps existing link management available to a member when invitations are disabled', async () => {
    const response = makeResponse();

    await expect(requireGuestLinkManagementAccess({
      familyId: 'family_1',
      identity: { role: 'member' }
    } as any, response as any)).resolves.toBe(true);

    expect(response.status).not.toHaveBeenCalled();
  });

  test('denies new member guest links unless the owner explicitly enables them', async () => {
    const response = makeResponse();

    await expect(requireGuestLinkCreationAccess({
      familyId: 'family_1',
      identity: { role: 'member' }
    } as any, response as any)).resolves.toBe(false);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'FORBIDDEN' })
    }));
  });

  test('allows new member guest links after the owner grants the identity permission', async () => {
    const response = makeResponse();

    await expect(requireGuestLinkCreationAccess({
      familyId: 'family_1',
      identity: { role: 'member', canCreateGuestInvites: true }
    } as any, response as any)).resolves.toBe(true);

    expect(response.status).not.toHaveBeenCalled();
  });

  test('allows a guest with explicit delegation to create guest links', async () => {
    const response = makeResponse();

    await expect(requireGuestLinkCreationAccess({
      familyId: 'family_1',
      identity: { role: 'guest', canCreateGuestInvites: true }
    } as any, response as any)).resolves.toBe(true);
  });

  test('always allows the Circle owner to invite guests', async () => {
    const response = makeResponse();

    await expect(requireGuestLinkCreationAccess({
      familyId: 'family_1',
      identity: { role: 'owner' }
    } as any, response as any)).resolves.toBe(true);

  });
});
