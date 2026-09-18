jest.mock('../db/repositories', () => ({
  familyConfigRepository: { findByFamilyId: jest.fn() }
}));

import { familyConfigRepository } from '../db/repositories';
import { ConfigService } from './configService';

describe('ConfigService guest policy boundaries', () => {
  test('does not project a global guest-invitation permission', async () => {
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue(null);
    const resolved = await new ConfigService().getResolvedFamilyConfig('family_1');
    expect(resolved).not.toHaveProperty('membersCanCreateGuestLinks');
  });
});
