jest.mock('../db/repositories', () => ({
  systemEventRepository: {
    getSyncState: jest.fn(),
    fetchEventsForSync: jest.fn(),
    updateSyncState: jest.fn()
  }
}));

jest.mock('../db/repositories/systemEventRepository', () => ({
  MAX_SYSTEM_SYNC_BATCH: 200
}));

import { systemEventRepository } from '../db/repositories';
import { ackSystemEventsForActor, listSystemEventsForActor } from './systemEventsService';
import type { AuthenticatedActor } from './authenticatedActor';

const actor: AuthenticatedActor = {
  familyId: 'family-1',
  identityId: 'alice',
  deviceId: 'device-1'
};

describe('systemEventsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists events for the actor identity and device cursor', async () => {
    (systemEventRepository.getSyncState as jest.Mock).mockResolvedValue({ last_system_sync_at: 10 });
    (systemEventRepository.fetchEventsForSync as jest.Mock).mockResolvedValue([
      { eventId: 'e1', recipientIdentityId: 'alice', circleId: 'server', type: 'call:missed', payload: {}, serverTimestamp: 20 }
    ]);

    const result = await listSystemEventsForActor(actor, {});

    expect(systemEventRepository.fetchEventsForSync).toHaveBeenCalledWith({
      familyId: 'family-1',
      recipientIdentityId: 'alice',
      since: 10,
      limit: 201
    });
    expect(result.syncedThrough).toBe(20);
  });

  it('acks monotonically', async () => {
    (systemEventRepository.getSyncState as jest.Mock).mockResolvedValue({ last_system_sync_at: 50 });

    await ackSystemEventsForActor(actor, { syncedThrough: 40 });

    expect(systemEventRepository.updateSyncState).toHaveBeenCalledWith('family-1', 'device-1', 50);
  });
});
