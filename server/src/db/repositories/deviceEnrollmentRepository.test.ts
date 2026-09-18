const mockPoolQuery = jest.fn();

jest.mock('../index', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) }
}));

import { DeviceEnrollmentRepository } from './deviceEnrollmentRepository';

describe('DeviceEnrollmentRepository lifecycle transitions', () => {
  const repository = new DeviceEnrollmentRepository();

  beforeEach(() => mockPoolQuery.mockReset());

  it('approves only a request that is still awaiting trusted approval', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await repository.markApproved({
      familyId: 'family-1', enrollmentId: 'enrollment-1', approvedByDeviceId: 'device-1',
      temporaryDeviceId: 'device-2', temporaryDevicePublicKeyAlgorithm: 'ed25519',
      temporaryDevicePublicKeyValue: 'public-key', encryptedTemporaryMembership: 'ciphertext',
      cipher: 'sealed-box-v1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      accessMode: 'full_circle', payloadExpiresAt: new Date(Date.now() + 60_000)
    }, { query } as never);

    expect(String(query.mock.calls[0][0])).toContain("state = 'pending_trusted_approval'");
    expect(String(query.mock.calls[0][0])).toContain('payload_expires_at');
    expect(String(query.mock.calls[0][0])).toContain('access_mode');
    expect(String(query.mock.calls[0][0])).toContain('$13::timestamptz');
  });

  it('does not let reject overwrite approved or activated states', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await repository.markRejected('family-1', 'enrollment-1');
    const sql = String(mockPoolQuery.mock.calls[0][0]);
    expect(sql).toContain("state IN ('reserved', 'pending_trusted_read', 'pending_trusted_approval')");
  });

  it('reserves an idempotent QR lifecycle bound to one trusted device', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await repository.reserve({
      familyId: 'family-1',
      enrollmentId: 'enrollment-1',
      expiresAt: new Date(Date.now() + 60_000),
      requestedTrustedDeviceId: 'device-1',
      requestedIdentityId: 'identity-1',
      bootstrapCommitment: 'bootstrap-commitment',
      bootstrapPayload: {
        v: 2,
        server: 'https://circle.example',
        identityPublicKey: 'identity-key',
        enrollmentId: 'enrollment-1',
        sessionPublicKey: 'session-key',
        trustedDeviceId: 'device-1'
      }
    });
    const sql = String(mockPoolQuery.mock.calls[0][0]);
    expect(sql).toContain("'reserved'");
    expect(sql).toContain('ON CONFLICT (enrollment_id) DO UPDATE');
    expect(sql).toContain('bootstrap_commitment');
    expect(sql).toContain('bootstrap_payload');
    expect(sql).toContain('bootstrap_commitment IS NOT DISTINCT FROM EXCLUDED.bootstrap_commitment');
    expect(sql).toContain("device_enrollments.state = 'reserved'");
    expect(mockPoolQuery.mock.calls[0][1][5]).toBe('bootstrap-commitment');
    expect(JSON.parse(mockPoolQuery.mock.calls[0][1][6])).toEqual({
      v: 2,
      server: 'https://circle.example',
      identityPublicKey: 'identity-key',
      enrollmentId: 'enrollment-1',
      sessionPublicKey: 'session-key',
      trustedDeviceId: 'device-1'
    });
  });

  it('accepts a new-device request only into a live reservation', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await repository.attachRequestToReservation({
      familyId: 'family-1',
      enrollmentId: 'enrollment-1',
      requestedTrustedDeviceId: 'device-1',
      newDeviceCiphertext: 'ciphertext',
      newDeviceCipher: 'sealed-box-v1',
      origin: 'https://client.example'
    });
    const sql = String(mockPoolQuery.mock.calls[0][0]);
    expect(sql).toContain("state = 'pending_trusted_read'");
    expect(sql).toContain("state = 'reserved'");
    expect(sql).toContain('enrollment_expires_at');
  });

  it('requires delivery before activation', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await repository.markActivated('family-1', 'enrollment-1');
    const sql = String(mockPoolQuery.mock.calls[0][0]);
    expect(sql).toContain("state = 'consumed'");
  });

  it('activates Profile Key recovery only from a reserved session', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await repository.markRecovered({
      familyId: 'family-1',
      enrollmentId: 'enrollment-1',
      deviceId: 'device-2',
      devicePublicKeyAlgorithm: 'ed25519',
      devicePublicKeyValue: 'public-key'
    });
    const sql = String(mockPoolQuery.mock.calls[0][0]);
    expect(sql).toContain("state = 'activated'");
    expect(sql).toContain("access_mode = 'full_circle'");
    expect(sql).toContain("state = 'reserved'");
  });
});
