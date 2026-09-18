import http, { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { ConfigRepository } from './config';
import { loadEnv } from './env';
import { getIceAuthHeader, verifyIceServiceAuth } from './auth';
import { generateTurnServer } from './turn';
import { logIceAccess } from './logging';
import type { IceServersRequest, IceServersResponse } from './types';
import { selectTurnCluster, TurnClusterSelectionError } from './turnClusterSelection';

loadEnv();

const PORT = Number(process.env.PORT || 3090);
const HOST = process.env.HOST || '127.0.0.1';
const CONFIG_PATH = process.env.ICE_CONFIG_PATH || './config.local.json';
const ICE_ADMIN_TOKEN = (process.env.ICE_ADMIN_TOKEN || '').trim();
const repository = ConfigRepository.load(CONFIG_PATH);

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseRequestBody(body: string): IceServersRequest {
  if (!body.trim()) return {};
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Request body must be a JSON object');
  }
  return parsed as IceServersRequest;
}

function requireAdminAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!ICE_ADMIN_TOKEN) {
    sendJson(res, 404, { status: 'error', error: { message: 'Not found' } });
    return false;
  }
  const auth = String(req.headers['authorization'] || '');
  const expected = Buffer.from(`Bearer ${ICE_ADMIN_TOKEN}`, 'utf8');
  const actual = Buffer.from(auth, 'utf8');
  const authorized = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!authorized) {
    sendJson(res, 401, { status: 'error', error: { message: 'Unauthorized' } });
    return false;
  }
  return true;
}

async function handleAdminAddServer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAdminAuth(req, res)) return;

  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = body.trim() ? JSON.parse(body) : {};
  } catch {
    sendJson(res, 400, { status: 'error', error: { message: 'Invalid JSON' } });
    return;
  }

  const p = parsed as Record<string, unknown>;
  const serverId = String(p.serverId || '').trim();
  const keyId = String(p.keyId || '').trim();
  const s2sSharedSecret = String(p.s2sSharedSecret || '').trim();
  const defaultTurnClusterId = String(p.defaultTurnClusterId || '').trim();
  const allowedTurnClusterIds = p.allowedTurnClusterIds === undefined
    ? [defaultTurnClusterId]
    : Array.isArray(p.allowedTurnClusterIds)
      ? Array.from(new Set(p.allowedTurnClusterIds.map((value) => String(value || '').trim()).filter(Boolean)))
      : [];

  if (!serverId || !keyId || !s2sSharedSecret || !defaultTurnClusterId || allowedTurnClusterIds.length === 0) {
    console.warn('[ICE][admin] rejected add server: missing required fields', { serverId, keyId, defaultTurnClusterId });
    sendJson(res, 400, { status: 'error', error: { message: 'serverId, keyId, s2sSharedSecret, defaultTurnClusterId are required' } });
    return;
  }

  if (Buffer.from(s2sSharedSecret, 'base64').length < 16) {
    console.warn('[ICE][admin] rejected add server: secret too short', { serverId, keyId });
    sendJson(res, 400, { status: 'error', error: { message: 's2sSharedSecret too short (min 16 bytes base64)' } });
    return;
  }

  if (!repository.getTurnCluster(defaultTurnClusterId)) {
    console.warn('[ICE][admin] rejected add server: unknown cluster', { serverId, keyId, defaultTurnClusterId });
    sendJson(res, 400, { status: 'error', error: { message: `Unknown defaultTurnClusterId: ${defaultTurnClusterId}` } });
    return;
  }
  if (!allowedTurnClusterIds.includes(defaultTurnClusterId)) {
    sendJson(res, 400, { status: 'error', error: { message: 'allowedTurnClusterIds must include defaultTurnClusterId' } });
    return;
  }
  const unknownAllowedClusterId = allowedTurnClusterIds.find((clusterId) => !repository.getTurnCluster(clusterId));
  if (unknownAllowedClusterId) {
    sendJson(res, 400, { status: 'error', error: { message: `Unknown allowed TURN cluster: ${unknownAllowedClusterId}` } });
    return;
  }

  repository.addOrUpdateAuthorizedServer({
    serverId,
    keyId,
    s2sSharedSecret,
    defaultTurnClusterId,
    allowedTurnClusterIds,
    status: 'active'
  });
  console.log('[ICE][admin] authorized server upserted', {
    serverId,
    keyId,
    defaultTurnClusterId,
    allowedTurnClusterIds
  });

  sendJson(res, 200, {
    status: 'ok',
    server: { serverId, keyId, status: 'active', defaultTurnClusterId, allowedTurnClusterIds }
  });
}

async function handleAdminListServers(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAdminAuth(_req, res)) return;
  const servers = repository.listAuthorizedServers().map(({
    serverId, keyId, status, defaultTurnClusterId, allowedTurnClusterIds
  }) => ({
    serverId, keyId, status: status ?? 'active', defaultTurnClusterId, allowedTurnClusterIds
  }));
  sendJson(res, 200, { status: 'ok', servers });
}

async function handleTurnClusters(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const authorizedServer = verifyIceServiceAuth({ req, res, body, repository });
  if (!authorizedServer) return;
  sendJson(res, 200, {
    status: 'ok',
    result: {
      defaultTurnClusterId: authorizedServer.defaultTurnClusterId,
      turnClusters: repository.listAllowedTurnClusters(authorizedServer)
    }
  });
}

async function handleIceServers(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const body = await readBody(req);
  const authorizedServer = verifyIceServiceAuth({ req, res, body, repository });
  if (!authorizedServer) {
    logIceAccess({
      event: 'ice_servers',
      status: 'error',
      httpStatus: res.statusCode || 401,
      serverId: getIceAuthHeader(req, 'serverId') || undefined,
      keyId: getIceAuthHeader(req, 'keyId') || undefined,
      error: 'auth_failed',
      durationMs: Date.now() - startedAt
    });
    return;
  }

  const payload = parseRequestBody(body);
  const familyId = String(payload.familyId || '').trim();
  if (!familyId) {
    sendJson(res, 400, { status: 'error', error: { message: 'familyId is required' } });
    logIceAccess({
      event: 'ice_servers',
      status: 'error',
      httpStatus: 400,
      serverId: authorizedServer.serverId,
      keyId: authorizedServer.keyId,
      vpsId: payload.vpsId || null,
      familyId: null,
      error: 'missing_family_id',
      durationMs: Date.now() - startedAt
    });
    return;
  }

  const purpose = String(payload.purpose || 'bootstrap').trim();
  const circleSubjectId = String(payload.circleSubjectId || '').trim();
  const mediaSessionId = String(payload.mediaSessionId || '').trim();
  if (!/^cs1_[A-Za-z0-9_-]{22}$/.test(circleSubjectId)) {
    sendJson(res, 400, { status: 'error', error: { message: 'A valid circleSubjectId is required' } });
    logIceAccess({
      event: 'ice_servers',
      status: 'error',
      httpStatus: 400,
      serverId: authorizedServer.serverId,
      keyId: authorizedServer.keyId,
      vpsId: payload.vpsId || null,
      familyId,
      purpose,
      error: 'invalid_circle_subject_id',
      durationMs: Date.now() - startedAt
    });
    return;
  }
  if (purpose === 'call' && !/^ms1_[A-Za-z0-9_-]{22}$/.test(mediaSessionId)) {
    sendJson(res, 400, { status: 'error', error: { message: 'A valid mediaSessionId is required for calls' } });
    logIceAccess({
      event: 'ice_servers',
      status: 'error',
      httpStatus: 400,
      serverId: authorizedServer.serverId,
      keyId: authorizedServer.keyId,
      vpsId: payload.vpsId || null,
      familyId,
      circleSubjectId,
      purpose,
      error: 'invalid_media_session_id',
      durationMs: Date.now() - startedAt
    });
    return;
  }

  let selected: ReturnType<typeof selectTurnCluster>;
  try {
    selected = selectTurnCluster({
      repository,
      server: authorizedServer,
      requestedTurnClusterId: payload.requestedTurnClusterId
    });
  } catch (error) {
    if (!(error instanceof TurnClusterSelectionError)) throw error;
    sendJson(res, error.statusCode, { status: 'error', error: { message: error.message } });
    logIceAccess({
      event: 'ice_servers',
      status: 'error',
      httpStatus: error.statusCode,
      serverId: authorizedServer.serverId,
      keyId: authorizedServer.keyId,
      vpsId: payload.vpsId || null,
      familyId,
      turnClusterId: String(payload.requestedTurnClusterId || authorizedServer.defaultTurnClusterId),
      error: error.code,
      durationMs: Date.now() - startedAt
    });
    return;
  }
  const { cluster, selectionSource } = selected;

  const ttlSeconds = repository.getCredentialTtlSeconds(cluster);
  const turnServer = generateTurnServer({
    cluster,
    server: authorizedServer,
    vpsId: payload.vpsId,
    circleSubjectId,
    mediaSessionId: mediaSessionId || undefined,
    ttlSeconds
  });

  const response: IceServersResponse = {
    iceServers: [
      ...repository.getStunUrls().map((urls) => ({ urls })),
      turnServer
    ],
    ...(ttlSeconds ? { ttlSeconds } : {}),
    ...(turnServer.expiresAt ? { expiresAt: turnServer.expiresAt } : {}),
    assignment: {
      turnClusterId: cluster.id,
      mode: 'fixed',
      selectionSource,
      circleSubjectId,
      ...(mediaSessionId ? { mediaSessionId } : {})
    }
  };

  sendJson(res, 200, { status: 'ok', result: response });
  logIceAccess({
    event: 'ice_servers',
    status: 'ok',
    httpStatus: 200,
    serverId: authorizedServer.serverId,
    keyId: authorizedServer.keyId,
    vpsId: payload.vpsId || null,
    familyId,
    circleSubjectId,
    mediaSessionId: mediaSessionId || null,
    purpose,
    turnClusterId: cluster.id,
    iceServerCount: response.iceServers.length,
    durationMs: Date.now() - startedAt
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  void (async () => {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok', ts: Date.now() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/ice-servers') {
      await handleIceServers(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/turn-clusters') {
      await handleTurnClusters(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/admin/servers') {
      await handleAdminAddServer(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/servers') {
      await handleAdminListServers(req, res);
      return;
    }

    sendJson(res, 404, { status: 'error', error: { message: 'Not found' } });
  })().catch((error) => {
    console.error('ICE config service error:', error);
    if (!res.headersSent) {
      sendJson(res, 500, { status: 'error', error: { message: 'Internal error' } });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ICE config service listening on http://${HOST}:${PORT}`);
});
