jest.mock('../db/repositories', () => ({
  familyConfigRepository: { findByFamilyId: jest.fn() },
  identityRepository: { findByIdentityId: jest.fn() },
  inviteRepository: {
    incrementUsedCount: jest.fn(),
    updateStatus: jest.fn(),
    findByToken: jest.fn(),
  },
}));

import { familyConfigRepository, identityRepository } from '../db/repositories';
import { isInviteCreatorActive, isInviteValid } from './inviteService';
import type { FindByTokenResult } from '../db/repositories/inviteRepository.queries';

function invite(overrides: Partial<FindByTokenResult> = {}): FindByTokenResult {
  return {
    invite_id: 'invite_bootstrap',
    token: 'join_secret',
    family_id: 'family_new',
    created_by: 'admin_from_management_circle',
    created_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
    max_uses: 1,
    used_count: 0,
    status: 'active',
    ...overrides,
  };
}

describe('invite creator validation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('accepts invites owned by provisioning itself', async () => {
    await expect(isInviteCreatorActive(invite({ created_by: 'system' }))).resolves.toBe(true);
    expect(identityRepository.findByIdentityId).not.toHaveBeenCalled();
  });

  test('accepts an invite whose creator identity is still active', async () => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ status: 'active' });

    await expect(isInviteCreatorActive(invite())).resolves.toBe(true);
  });

  test('rejects an invite whose creator is gone, with no Circle-state exception', async () => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue(null);

    await expect(isInviteCreatorActive(invite())).resolves.toBe(false);
    expect(familyConfigRepository.findByFamilyId).not.toHaveBeenCalled();
  });

  test('rejects an invite whose creator is suspended', async () => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ status: 'suspended' });

    await expect(isInviteCreatorActive(invite())).resolves.toBe(false);
  });
});

describe('invite expiry boundary', () => {
  afterEach(() => jest.useRealTimers());

  test.each([-1, 0, 1])('accepts only instants strictly before expiry (offset %i ms)', (offset) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-06T15:00:00Z'));
    const record = invite({ expires_at: new Date(Date.now() + offset) });
    expect(isInviteValid(record)).toBe(offset > 0);
  });
});
