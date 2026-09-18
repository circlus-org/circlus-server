import {
  circleMediaRoutingRepository,
  type CircleMediaRoutingStrategy,
  type DBCircleMediaRoutingSettings
} from '../db/repositories/circleMediaRoutingRepository';
import { iceServersService, type PublicTurnCluster } from './iceServersService';

export interface CircleMediaRoutingSettings {
  strategy: CircleMediaRoutingStrategy;
  turnClusterId: string | null;
  updatedAt: string | null;
}

export interface CircleMediaRoutingConfiguration extends CircleMediaRoutingSettings {
  defaultTurnClusterId: string;
  effectiveTurnClusterId: string | null;
  configuredClusterAvailable: boolean;
  configuredClusterIssue: 'missing_or_not_allowed' | 'inactive' | null;
  availableTurnClusters: Array<Pick<
    PublicTurnCluster,
    'id' | 'displayName' | 'status' | 'ownership' | 'location'
  >>;
}

function resolveConfiguredCluster(
  settings: CircleMediaRoutingSettings,
  catalog: Awaited<ReturnType<typeof iceServersService.listTurnClusters>>
): {
  effectiveTurnClusterId: string | null;
  configuredClusterAvailable: boolean;
  configuredClusterIssue: 'missing_or_not_allowed' | 'inactive' | null;
} {
  if (settings.strategy === 'server_default' || !settings.turnClusterId) {
    const defaultCluster = catalog.turnClusters.find(
      (cluster) => cluster.id === catalog.defaultTurnClusterId
    );
    return {
      effectiveTurnClusterId: defaultCluster?.status === 'active'
        ? catalog.defaultTurnClusterId
        : null,
      configuredClusterAvailable: defaultCluster?.status === 'active',
      configuredClusterIssue: defaultCluster?.status === 'disabled'
        ? 'inactive'
        : defaultCluster
          ? null
          : 'missing_or_not_allowed'
    };
  }

  const configuredCluster = catalog.turnClusters.find(
    (cluster) => cluster.id === settings.turnClusterId
  );
  if (!configuredCluster) {
    return {
      effectiveTurnClusterId: null,
      configuredClusterAvailable: false,
      configuredClusterIssue: 'missing_or_not_allowed'
    };
  }
  if (configuredCluster.status !== 'active') {
    return {
      effectiveTurnClusterId: null,
      configuredClusterAvailable: false,
      configuredClusterIssue: 'inactive'
    };
  }
  return {
    effectiveTurnClusterId: configuredCluster.id,
    configuredClusterAvailable: true,
    configuredClusterIssue: null
  };
}

export class CircleMediaRoutingValidationError extends Error {
  constructor(
    readonly code: 'INVALID_STRATEGY' | 'TURN_CLUSTER_REQUIRED' | 'TURN_CLUSTER_UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'CircleMediaRoutingValidationError';
  }
}

function mapSettings(row: DBCircleMediaRoutingSettings | null): CircleMediaRoutingSettings {
  if (!row) {
    return { strategy: 'server_default', turnClusterId: null, updatedAt: null };
  }
  return {
    strategy: row.strategy,
    turnClusterId: row.turn_cluster_id,
    updatedAt: row.updated_at.toISOString()
  };
}

export class CircleMediaRoutingService {
  async getSettings(familyId: string): Promise<CircleMediaRoutingSettings> {
    return mapSettings(await circleMediaRoutingRepository.findByFamilyId(familyId));
  }

  async getRequestedTurnClusterId(familyId: string): Promise<string | undefined> {
    const settings = await this.getSettings(familyId);
    return settings.strategy === 'fixed' && settings.turnClusterId
      ? settings.turnClusterId
      : undefined;
  }

  async getConfiguration(familyId: string): Promise<CircleMediaRoutingConfiguration> {
    const [settings, catalog] = await Promise.all([
      this.getSettings(familyId),
      iceServersService.listTurnClusters()
    ]);
    const resolution = resolveConfiguredCluster(settings, catalog);
    return {
      ...settings,
      defaultTurnClusterId: catalog.defaultTurnClusterId,
      ...resolution,
      availableTurnClusters: catalog.turnClusters.map((cluster) => ({
        id: cluster.id,
        displayName: cluster.displayName,
        status: cluster.status,
        ownership: cluster.ownership,
        ...(cluster.location ? { location: cluster.location } : {})
      }))
    };
  }

  async updateSettings(input: {
    familyId: string;
    strategy: unknown;
    turnClusterId?: unknown;
  }): Promise<CircleMediaRoutingConfiguration> {
    if (input.strategy !== 'server_default' && input.strategy !== 'fixed') {
      throw new CircleMediaRoutingValidationError('INVALID_STRATEGY', 'Unsupported media routing strategy');
    }

    const catalog = await iceServersService.listTurnClusters();
    let turnClusterId: string | null = null;
    if (input.strategy === 'fixed') {
      turnClusterId = typeof input.turnClusterId === 'string' ? input.turnClusterId.trim() : '';
      if (!turnClusterId) {
        throw new CircleMediaRoutingValidationError('TURN_CLUSTER_REQUIRED', 'A TURN cluster is required');
      }
      const selected = catalog.turnClusters.find((cluster) => cluster.id === turnClusterId);
      if (!selected || selected.status !== 'active') {
        throw new CircleMediaRoutingValidationError(
          'TURN_CLUSTER_UNAVAILABLE',
          'The selected TURN cluster is unavailable for this server'
        );
      }
    }

    const stored = mapSettings(await circleMediaRoutingRepository.upsert({
      familyId: input.familyId,
      strategy: input.strategy,
      turnClusterId
    }));
    const resolution = resolveConfiguredCluster(stored, catalog);
    return {
      ...stored,
      defaultTurnClusterId: catalog.defaultTurnClusterId,
      ...resolution,
      availableTurnClusters: catalog.turnClusters.map((cluster) => ({
        id: cluster.id,
        displayName: cluster.displayName,
        status: cluster.status,
        ownership: cluster.ownership,
        ...(cluster.location ? { location: cluster.location } : {})
      }))
    };
  }
}

export const circleMediaRoutingService = new CircleMediaRoutingService();
