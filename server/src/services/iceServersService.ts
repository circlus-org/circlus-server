import type { GetIceServersResponse } from '../../../shared/types';
import { signIceConfigServiceRequest } from '../utils/iceConfigServiceS2S';
import { getIntegrationRuntimeConfig } from '../config/serverRuntimeConfig';
import { deriveIceSubjectIds } from '../utils/mediaSessionIdentity';

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
  expiresAt?: string;
}

interface IceConfigServiceResponse {
  status: 'ok' | 'error';
  result?: {
    iceServers: GetIceServersResponse['iceServers'];
    ttlSeconds?: number;
    expiresAt?: string;
    assignment?: {
      turnClusterId: string;
      mode: string;
      selectionSource?: 'default' | 'requested';
      circleSubjectId?: string;
      mediaSessionId?: string;
    };
  };
  error?: {
    message?: string;
  };
}

export interface PublicTurnCluster {
  id: string;
  displayName: string;
  status: 'active' | 'disabled';
  ownership: 'local' | 'external';
  location?: string;
  urls: string[];
  authMode: 'turn-rest-secret' | 'static-credentials';
}

interface TurnClusterCatalogResponse {
  status: 'ok' | 'error';
  result?: {
    defaultTurnClusterId: string;
    turnClusters: PublicTurnCluster[];
  };
  error?: {
    message?: string;
  };
}

function requireIceConfigServiceUrl(): string {
  const serviceUrl = getIntegrationRuntimeConfig().ice.serviceUrl;
  if (!serviceUrl) throw new Error('ICE_CONFIG_SERVICE_URL is required');
  return serviceUrl;
}

async function fetchIceConfigurationFromService(opts: {
  familyId: string;
  purpose: 'bootstrap' | 'call' | 'file-transfer';
  callSessionId?: string;
  requestedTurnClusterId?: string;
}): Promise<NonNullable<IceConfigServiceResponse['result']>> {
  const config = getIntegrationRuntimeConfig().ice;
  const baseUrl = requireIceConfigServiceUrl();
  const path = '/v1/ice-servers';
  const subjects = deriveIceSubjectIds({
    familyId: opts.familyId,
    purpose: opts.purpose,
    callSessionId: opts.callSessionId
  });
  const body = JSON.stringify({
    vpsId: config.vpsId || null,
    familyId: opts.familyId,
    purpose: opts.purpose,
    ...(opts.requestedTurnClusterId ? { requestedTurnClusterId: opts.requestedTurnClusterId } : {}),
    ...subjects
  });

  const timeoutMs = config.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signIceConfigServiceRequest({ method: 'POST', path, body })
      },
      body,
      signal: controller.signal
    });

    const payload = await response.json().catch(() => null) as IceConfigServiceResponse | null;
    if (!response.ok || payload?.status !== 'ok' || !payload.result?.iceServers) {
      const message = payload?.error?.message || `ICE config service returned HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTurnClusterCatalogFromService(): Promise<NonNullable<TurnClusterCatalogResponse['result']>> {
  const config = getIntegrationRuntimeConfig().ice;
  const baseUrl = requireIceConfigServiceUrl();
  const path = '/v1/turn-clusters';
  const body = '{}';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signIceConfigServiceRequest({ method: 'POST', path, body })
      },
      body,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null) as TurnClusterCatalogResponse | null;
    if (
      !response.ok
      || payload?.status !== 'ok'
      || !payload.result?.defaultTurnClusterId
      || !Array.isArray(payload.result.turnClusters)
    ) {
      const message = payload?.error?.message || `ICE config service returned HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

export const iceServersService = {
  listTurnClusters: fetchTurnClusterCatalogFromService,

  getIceServers: async (opts: {
    familyId: string;
    requestedTurnClusterId?: string;
  }): Promise<GetIceServersResponse['iceServers']> => {
    const result = await fetchIceConfigurationFromService({
      familyId: opts.familyId,
      purpose: 'bootstrap',
      requestedTurnClusterId: opts.requestedTurnClusterId
    });
    return result.iceServers;
  },

  getTurnServerConfig: async (opts: {
    familyId: string;
    callSessionId: string;
    requestedTurnClusterId?: string;
  }): Promise<(IceServerConfig & { mediaSessionId: string; turnClusterId: string }) | null> => {
    const result = await fetchIceConfigurationFromService({
      familyId: opts.familyId,
      purpose: 'call',
      callSessionId: opts.callSessionId,
      requestedTurnClusterId: opts.requestedTurnClusterId
    });
    const turnServer = result.iceServers.find((entry): entry is IceServerConfig => {
      const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
      return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
    });
    const mediaSessionId = result.assignment?.mediaSessionId;
    const turnClusterId = result.assignment?.turnClusterId;
    if (!turnServer || !mediaSessionId || !turnClusterId) return null;
    return { ...turnServer, mediaSessionId, turnClusterId };
  }
};
