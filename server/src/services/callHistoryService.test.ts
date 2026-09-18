jest.mock('../db/repositories', () => ({
  callHistoryRepository: {
    markMissedSeen: jest.fn(),
    getSyncState: jest.fn(),
    fetchHistoryForSync: jest.fn(),
    updateSyncState: jest.fn()
  }
}));

jest.mock('../db', () => ({
  query: jest.fn()
}));

jest.mock('./configService', () => ({
  configService: {
    getNoNamesOnServer: jest.fn()
  }
}));

import { callHistoryRepository } from '../db/repositories';
import { query } from '../db';
import { configService } from './configService';
import { ackCallHistorySyncForActor, listCallHistoryForActor, markMissedCallsSeenForActor } from './callHistoryService';
import type { AuthenticatedActor } from './authenticatedActor';

const actor: AuthenticatedActor = {
  familyId: 'family-1',
  identityId: 'alice',
  deviceId: 'device-1'
};

describe('callHistoryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks missed calls seen only for the actor identity', async () => {
    await markMissedCallsSeenForActor(actor, {
      callSessionIds: ['call-1', ''],
      peerIdentityId: 'bob',
      seenAt: 123
    });

    expect(callHistoryRepository.markMissedSeen).toHaveBeenCalledWith({
      familyId: 'family-1',
      identityId: 'alice',
      seenAt: 123,
      callSessionIds: ['call-1'],
      peerIdentityId: 'bob'
    });
  });

  it('returns the call peer key even when the peer is not published in the circle directory', async () => {
    (callHistoryRepository.getSyncState as jest.Mock).mockResolvedValue({
      last_call_history_sync_at: 0
    });
    (callHistoryRepository.fetchHistoryForSync as jest.Mock).mockResolvedValue([{
      callSessionId: 'call-1',
      localIdentityId: 'alice',
      remoteIdentityId: 'hidden-bob',
      direction: 'incoming',
      status: 'answered',
      timestamp: 200,
      createdAt: 100,
      lastUpdatedAt: 200
    }]);
    (configService.getNoNamesOnServer as jest.Mock).mockResolvedValue(true);
    (query as jest.Mock).mockResolvedValue({
      rows: [{
        identity_id: 'hidden-bob',
        public_key_algorithm: 'ed25519',
        public_key_value: 'hidden-bob-key'
      }]
    });

    const result = await listCallHistoryForActor(actor, {});

    expect(result.events[0]).toMatchObject({
      remoteIdentityId: 'hidden-bob',
      remotePublicKey: {
        algorithm: 'ed25519',
        value: 'hidden-bob-key'
      }
    });
    expect(result.events[0]).not.toHaveProperty('remoteIdentityName');
    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining('publish_identity = true'),
      ['family-1', ['hidden-bob']]
    );
  });

  it('acks call history sync without moving the cursor backwards', async () => {
    (callHistoryRepository.getSyncState as jest.Mock).mockResolvedValue({
      last_call_history_sync_at: 500
    });

    await ackCallHistorySyncForActor(actor, { syncedThrough: 300 });

    expect(callHistoryRepository.updateSyncState).toHaveBeenCalledWith('family-1', 'device-1', 500);
  });

  it('accepts zero syncedThrough for an empty initial sync', async () => {
    (callHistoryRepository.getSyncState as jest.Mock).mockResolvedValue({
      last_call_history_sync_at: 0
    });

    await ackCallHistorySyncForActor(actor, { syncedThrough: 0 });

    expect(callHistoryRepository.updateSyncState).toHaveBeenCalledWith('family-1', 'device-1', 0);
  });
});
