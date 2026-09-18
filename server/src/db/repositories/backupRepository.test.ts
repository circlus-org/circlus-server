const mockQuery = jest.fn();

jest.mock('../index', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) }
}));

import { backupRepository } from './backupRepository';

describe('Circle-scoped profile backup repository', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test('updates one row per Circle secret namespace and device slot', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ backup_id: 'backup-1', version: 4, updated_at: new Date('2026-08-23T00:00:00Z') }]
    });

    await backupRepository.upsert({
      familyId: 'family-1',
      uploaderIdentityId: 'identity-new',
      uploaderDeviceId: 'device-new',
      backupSlotId: 'profile-device-slot-1',
      encryptedBackup: { cipher: 'aes-gcm' },
      lookupSecretHash: 'a'.repeat(64)
    });

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (family_id, lookup_secret_hash, backup_slot_id)');
    expect(sql).toContain('last_uploader_identity_id = EXCLUDED.last_uploader_identity_id');
    expect(values).toEqual([
      'family-1',
      'identity-new',
      'device-new',
      'profile-device-slot-1',
      JSON.stringify({ cipher: 'aes-gcm' }),
      'a'.repeat(64)
    ]);
  });

  test('restoration lookup is independent of uploader identity', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await backupRepository.listByLookupSecretHash('family-1', 'b'.repeat(64));

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE family_id = $1 AND lookup_secret_hash = $2');
    expect(sql).not.toContain('identity_id =');
    expect(values).toEqual(['family-1', 'b'.repeat(64)]);
  });
});
