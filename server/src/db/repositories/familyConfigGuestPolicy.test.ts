jest.mock('../index', () => ({ query: jest.fn(), transaction: jest.fn() }));

import { query } from '../index';
import { familyConfigRepository } from './familyConfigRepository';

describe('familyConfigRepository guest invitation policy', () => {
  test('does not persist the removed global member guest-invitation policy', async () => {
    (query as jest.Mock).mockResolvedValue({ rows: [{}] });
    await familyConfigRepository.create({
      familyId: 'family_1',
      serverName: 'Circle',
      publicBaseUrl: 'https://circle.example'
    });
    const [sql] = (query as jest.Mock).mock.calls[0];
    expect(sql).not.toContain('members_can_create_guest_links');
  });
});
