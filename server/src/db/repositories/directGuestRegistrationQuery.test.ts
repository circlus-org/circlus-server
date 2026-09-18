import { createDirectGuestRegistration } from './directGuestRegistrationRepository.queries';

test('binds the identity registration and permission parameters after removing the initial-device column', async () => {
  const client = { query: jest.fn(async () => ({ rows: [{ registration_id: 'registration' }] })) };
  const input = {
    registrationId: 'registration', familyId: 'family', linkId: 'link', hostIdentityId: 'host', guestIdentityId: 'guest',
    canMessage: true, canCall: false, canDirectFileTransfer: false, canServerAttachments: false,
    hostCanMessageGuest: true, guestCanMessageHost: true, hostCanCallGuest: true, guestCanCallHost: false,
    hostCanDirectFileTransferGuest: true, guestCanDirectFileTransferHost: false,
    hostCanServerAttachmentsGuest: true, guestCanServerAttachmentsHost: false,
  };
  const rows = await createDirectGuestRegistration.run(input, client as any);
  expect(rows[0].registration_id).toBe('registration');
  const [sql, values] = (client.query as jest.Mock).mock.calls[0];
  expect(sql).not.toContain('guest_device_id');
  expect(sql).not.toMatch(/:[a-zA-Z]/);
  expect(values).toEqual(Object.values(input));
  expect(sql).toContain('$17');
});
