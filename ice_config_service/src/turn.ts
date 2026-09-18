import crypto from 'crypto';
import type { AuthorizedServerConfig, IceServerEntry, TurnClusterConfig } from './types';

function normalizeUsernameSegment(value: string | undefined, fallback: string): string {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized || fallback;
}

export function generateTurnServer(params: {
  cluster: TurnClusterConfig;
  server: AuthorizedServerConfig;
  vpsId: string | undefined;
  circleSubjectId: string;
  mediaSessionId?: string;
  ttlSeconds?: number;
}): IceServerEntry {
  if (params.cluster.auth.mode === 'static-credentials') {
    return {
      urls: params.cluster.urls,
      username: params.cluster.auth.username,
      credential: params.cluster.auth.credential
    };
  }

  if (!params.ttlSeconds) {
    throw new Error('ttlSeconds is required for TURN REST credentials');
  }
  const expiryUnixSeconds = Math.floor(Date.now() / 1000) + params.ttlSeconds;
  const username = [
    String(expiryUnixSeconds),
    'v1',
    normalizeUsernameSegment(params.server.serverId, 'unknown-server'),
    normalizeUsernameSegment(params.vpsId, 'unknown-vps'),
    normalizeUsernameSegment(params.circleSubjectId, 'unknown-circle'),
    normalizeUsernameSegment(params.mediaSessionId, 'unscoped'),
    normalizeUsernameSegment(params.cluster.id, 'unknown-cluster'),
    normalizeUsernameSegment(params.server.keyId, 'unknown-key')
  ].join(':');

  const credential = crypto
    .createHmac('sha1', params.cluster.auth.secret)
    .update(username)
    .digest('base64');

  return {
    urls: params.cluster.urls,
    username,
    credential,
    expiresAt: new Date(expiryUnixSeconds * 1000).toISOString()
  };
}
