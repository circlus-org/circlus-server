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
});
