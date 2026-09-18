export interface IceServiceConfig {
  schemaVersion: number;
  defaultTtlSeconds?: number;
  stunUrls?: string[];
  turnClusters: TurnClusterConfig[];
  authorizedServers: AuthorizedServerConfig[];
}

export type TurnClusterAuthConfig =
  | {
      mode: 'turn-rest-secret';
      secret: string;
      ttlSeconds?: number;
    }
  | {
      mode: 'static-credentials';
      username: string;
      credential: string;
    };

export interface TurnClusterConfig {
  id: string;
  displayName: string;
  status?: 'active' | 'disabled';
  ownership: 'local' | 'external';
  location?: string;
  urls: string[];
  auth: TurnClusterAuthConfig;
}

export interface AuthorizedServerConfig {
  serverId: string;
  keyId: string;
  status?: 'active' | 'disabled';
  s2sSharedSecret: string;
  defaultTurnClusterId: string;
  allowedTurnClusterIds: string[];
}

export interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
  expiresAt?: string;
}

export interface IceServersRequest {
  vpsId?: string;
  familyId?: string;
  purpose?: 'bootstrap' | 'call' | 'file-transfer' | string;
  circleSubjectId?: string;
  mediaSessionId?: string;
  requestedTurnClusterId?: string;
}

export interface IceServersResponse {
  iceServers: IceServerEntry[];
  ttlSeconds?: number;
  expiresAt?: string;
  assignment: {
    turnClusterId: string;
    mode: 'fixed';
    selectionSource: 'default' | 'requested';
    circleSubjectId: string;
    mediaSessionId?: string;
  };
}

export interface PublicTurnClusterConfig {
  id: string;
  displayName: string;
  status: 'active' | 'disabled';
  ownership: 'local' | 'external';
  location?: string;
  urls: string[];
  authMode: TurnClusterAuthConfig['mode'];
}
