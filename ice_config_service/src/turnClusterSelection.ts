import type { ConfigRepository } from './config';
import type { AuthorizedServerConfig, TurnClusterConfig } from './types';

export class TurnClusterSelectionError extends Error {
  constructor(
    public readonly statusCode: 400 | 403 | 503,
    public readonly code: 'unknown_cluster' | 'cluster_not_allowed' | 'cluster_inactive',
    message: string
  ) {
    super(message);
  }
}

export function selectTurnCluster(params: {
  repository: ConfigRepository;
  server: AuthorizedServerConfig;
  requestedTurnClusterId?: string;
}): { cluster: TurnClusterConfig; selectionSource: 'default' | 'requested' } {
  const requestedTurnClusterId = String(params.requestedTurnClusterId || '').trim();
  const selectionSource = requestedTurnClusterId ? 'requested' : 'default';
  const clusterId = requestedTurnClusterId || params.server.defaultTurnClusterId;
  const cluster = params.repository.getTurnCluster(clusterId);

  if (!cluster) {
    throw new TurnClusterSelectionError(400, 'unknown_cluster', 'Requested TURN cluster does not exist');
  }
  if (!params.server.allowedTurnClusterIds.includes(clusterId)) {
    throw new TurnClusterSelectionError(403, 'cluster_not_allowed', 'Requested TURN cluster is not allowed');
  }
  if (cluster.status === 'disabled') {
    throw new TurnClusterSelectionError(503, 'cluster_inactive', 'Assigned TURN cluster is not active');
  }
  return { cluster, selectionSource };
}
