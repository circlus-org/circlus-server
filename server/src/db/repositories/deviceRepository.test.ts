const mockPoolQuery = jest.fn();

jest.mock('../index', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) }
}));

import { DeviceRepository } from './deviceRepository';

describe('DeviceRepository physical installation link', () => {
  const repository = new DeviceRepository();

  beforeEach(() => mockPoolQuery.mockReset());

  it('backfills only the matching device in the matching Circle', async () => {
    const encrypted = { v: 1, iv: 'iv', ciphertext: 'ciphertext' };
    const row = { family_id: 'circle-1', device_id: 'device-1' };
    mockPoolQuery.mockResolvedValue({ rows: [row] });

    await expect(repository.updateEncryptedPhysicalDeviceId(
      'circle-1',
      'device-1' as never,
      encrypted
    )).resolves.toBe(row);

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(String(sql)).toContain('WHERE family_id = $1 AND device_id = $2');
    expect(params).toEqual(['circle-1', 'device-1', JSON.stringify(encrypted)]);
  });

  it('applies only a newer device-label update within the same identity and Circle', async () => {
    const row = {
      device_id: 'device-1',
      label: 'Work laptop',
      label_update_id: 'update-2',
      applied: true
    };
    mockPoolQuery.mockResolvedValue({ rows: [row] });

    await expect(repository.updateLabel({
      familyId: 'circle-1',
      identityId: 'identity-1' as never,
      deviceId: 'device-1' as never,
      label: 'Work laptop',
      updateId: 'update-2'
    })).resolves.toEqual(row);

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(String(sql)).toContain('AND identity_id = $2');
    expect(String(sql)).toContain('AND label_update_id < $5');
    expect(params).toEqual(['circle-1', 'identity-1', 'device-1', 'Work laptop', 'update-2']);
  });
});
