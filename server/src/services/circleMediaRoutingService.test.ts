jest.mock('../db/repositories/circleMediaRoutingRepository', () => ({
  circleMediaRoutingRepository: {
    findByFamilyId: jest.fn(),
    upsert: jest.fn(),
  },
}));

jest.mock('./iceServersService', () => ({
  iceServersService: {
    listTurnClusters: jest.fn(),
  },
}));

import { circleMediaRoutingRepository } from '../db/repositories/circleMediaRoutingRepository';
import { iceServersService } from './iceServersService';
import {
  circleMediaRoutingService,
  CircleMediaRoutingValidationError
} from './circleMediaRoutingService';

const catalog = {
  defaultTurnClusterId: 'local',
  turnClusters: [
    {
      id: 'local',
      displayName: 'Local TURN',
      status: 'active' as const,
      ownership: 'local' as const,
      location: 'Tbilisi',
      urls: ['turn:local.example.test:3478'],
      authMode: 'turn-rest-secret' as const,
    },
    {
      id: 'external-eu',
      displayName: 'External EU',
      status: 'active' as const,
      ownership: 'external' as const,
      location: 'Frankfurt',
      urls: ['turn:eu.example.test:3478'],
      authMode: 'turn-rest-secret' as const,
    },
  ],
};

describe('CircleMediaRoutingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (iceServersService.listTurnClusters as jest.Mock).mockResolvedValue(catalog);
  });

  test('uses the server default without creating a row', async () => {
    (circleMediaRoutingRepository.findByFamilyId as jest.Mock).mockResolvedValue(null);

    await expect(circleMediaRoutingService.getRequestedTurnClusterId('family-1'))
      .resolves.toBeUndefined();
    await expect(circleMediaRoutingService.getConfiguration('family-1')).resolves.toEqual({
      strategy: 'server_default',
      turnClusterId: null,
      updatedAt: null,
      defaultTurnClusterId: 'local',
      effectiveTurnClusterId: 'local',
      configuredClusterAvailable: true,
      configuredClusterIssue: null,
      availableTurnClusters: [
        {
          id: 'local',
          displayName: 'Local TURN',
          status: 'active',
          ownership: 'local',
          location: 'Tbilisi',
        },
        {
          id: 'external-eu',
          displayName: 'External EU',
          status: 'active',
          ownership: 'external',
          location: 'Frankfurt',
        },
      ],
    });
  });

  test('returns a fixed cluster id for ICE requests', async () => {
    (circleMediaRoutingRepository.findByFamilyId as jest.Mock).mockResolvedValue({
      family_id: 'family-1',
      strategy: 'fixed',
      turn_cluster_id: 'external-eu',
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    });

    await expect(circleMediaRoutingService.getRequestedTurnClusterId('family-1'))
      .resolves.toBe('external-eu');
  });

  test('reports a fixed cluster that is no longer allowed without falling back', async () => {
    (circleMediaRoutingRepository.findByFamilyId as jest.Mock).mockResolvedValue({
      family_id: 'family-1',
      strategy: 'fixed',
      turn_cluster_id: 'removed-cluster',
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    });

    await expect(circleMediaRoutingService.getConfiguration('family-1')).resolves.toEqual(
      expect.objectContaining({
        strategy: 'fixed',
        turnClusterId: 'removed-cluster',
        effectiveTurnClusterId: null,
        configuredClusterAvailable: false,
        configuredClusterIssue: 'missing_or_not_allowed',
      })
    );
  });

  test('reports a disabled fixed cluster without falling back', async () => {
    (circleMediaRoutingRepository.findByFamilyId as jest.Mock).mockResolvedValue({
      family_id: 'family-1',
      strategy: 'fixed',
      turn_cluster_id: 'disabled',
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    });
    (iceServersService.listTurnClusters as jest.Mock).mockResolvedValue({
      ...catalog,
      turnClusters: [
        ...catalog.turnClusters,
        {
          id: 'disabled',
          displayName: 'Disabled TURN',
          status: 'disabled',
          ownership: 'external',
          urls: ['turn:disabled.example.test:3478'],
          authMode: 'turn-rest-secret',
        },
      ],
    });

    await expect(circleMediaRoutingService.getConfiguration('family-1')).resolves.toEqual(
      expect.objectContaining({
        effectiveTurnClusterId: null,
        configuredClusterAvailable: false,
        configuredClusterIssue: 'inactive',
      })
    );
  });

  test('validates a fixed cluster against the current allowed catalog', async () => {
    await expect(circleMediaRoutingService.updateSettings({
      familyId: 'family-1',
      strategy: 'fixed',
      turnClusterId: 'not-allowed',
    })).rejects.toEqual(expect.objectContaining<Partial<CircleMediaRoutingValidationError>>({
      code: 'TURN_CLUSTER_UNAVAILABLE',
    }));
    expect(circleMediaRoutingRepository.upsert).not.toHaveBeenCalled();
  });

  test('stores server_default with no environment-specific cluster id', async () => {
    (circleMediaRoutingRepository.upsert as jest.Mock).mockResolvedValue({
      family_id: 'family-1',
      strategy: 'server_default',
      turn_cluster_id: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    });

    const result = await circleMediaRoutingService.updateSettings({
      familyId: 'family-1',
      strategy: 'server_default',
      turnClusterId: 'external-eu',
    });

    expect(circleMediaRoutingRepository.upsert).toHaveBeenCalledWith({
      familyId: 'family-1',
      strategy: 'server_default',
      turnClusterId: null,
    });
    expect(result.effectiveTurnClusterId).toBe('local');
  });
});
