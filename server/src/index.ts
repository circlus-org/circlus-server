import accessVersionsRoutes from './routes/accessVersions';
import './env';
import { runtimeConfig } from './config/runtimeConfig';

import express from 'express';
import { createServer, type IncomingMessage } from 'http';
import { WsResourceGuard, type ConnectionLease } from './ws/wsResourceGuard';
import { wsClientAddress } from './ws/wsClientAddress';
import type { Socket } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import cors from 'cors';
import { createCorsOptions, isTrustedClientRequestOrigin, securityHeaders } from './middleware/security';
import authRoutes from './routes/auth';
import vaultRoutes from './routes/vault';
import configRoutes from './routes/config';
import pushRoutes from './routes/push';
import adminRoutes from './routes/admin';
import invitesRoutes from './routes/invites';
import devicesRoutes from './routes/devices';
import statusRoutes from './routes/status';
import identitiesRoutes from './routes/identities';
import circleMembershipRoutes from './routes/circleMembership';
import callLinksRoutes from './routes/callLinks';
import callAdmissionRoutes from './routes/callAdmission';
import callsRoutes from './routes/calls';
import mobileRoutes from './routes/mobile';
import groupChatsRoutes from './routes/groupChats';
import messagesRoutes from './routes/messages';
import systemEventsRoutes from './routes/systemEvents';
import directGuestLinksRoutes from './routes/directGuestLinks';
import directGuestLinkPublicRoutes from './routes/directGuestLinkPublic';
import serverAdminRoutes from './routes/serverAdmin';
import hostProvisioningRoutes from './routes/hostProvisioning';
import tenantOwnerClaimsRoutes from './routes/tenantOwnerClaims';
import deviceEnrollmentsRoutes from './routes/deviceEnrollments';
import temporaryAccessRoutes from './routes/temporaryAccess';
import backupRoutes from './routes/backup';
import messageArchiveRoutes from './routes/messageArchive';
import attachmentsRoutes from './routes/attachments';
import linkPreviewRoutes from './routes/linkPreview';
import linksRoutes from './routes/links';
import serverRoutes from './routes/server';
import inspectorRoutes from './routes/inspector';
import inspectorBootstrapRoutes from './routes/inspectorBootstrap';
import circleSiteRoutes from './routes/circleSite';
import announcementChannelsRoutes from './routes/announcementChannels';
import publicSiteRoutes from './routes/publicSite';
import circleMigrationRoutes from './routes/circleMigration';
import serverAdminMigrationSlotsRoutes from './routes/serverAdminMigrationSlots';
import circleMigrationAdminRoutes from './routes/circleMigrationAdmin';
import { initializeDatabase, closeDatabase, acquireServerProcessLock, getPool } from './db';
import { handleMessage, handleClose, setSocketFamilyContext, stopCallRingingTimers, isSocketInRealtimeSession } from './ws/callHandler';
import { startCallHistoryHeartbeatCleanupScheduler, startCleanupScheduler, startExpiredInviteCleanupScheduler, type StopScheduler } from './utils/cleanup';
import { tenancyMiddleware, getRequestHost, getRequestedCircleId, resolveCircleContextFromHost } from './middleware/tenancy';
import { createRateLimiter, ipKey } from './middleware/rateLimit';
import { validatePushConfig } from './utils/push';
import { circleMigrationFreezeMiddleware, getCircleFreezeState } from './middleware/circleMigrationFreeze';
import { startAnnouncementChannelPushOutboxScheduler } from './services/announcementChannelPushOutboxService';
import { startTrustedDeviceRekeyScheduler } from './services/trustedDeviceRekeyService';
import {
  circleMigrationBridgeContextMiddleware,
  circleMigrationBridgeMiddleware
} from './middleware/circleMigrationBridge';
import { createActivityTracker } from './utils/activityTracker';
import { createRuntimeHealth } from './utils/runtimeHealth';
import { requestContextMiddleware, getRequestLogger } from './middleware/requestContext';
import { requestBodyErrorHandler } from './middleware/requestBodyError';
import { serverLogger } from './utils/logger';

const logger = serverLogger.child({ component: 'server' });
const app = express();
const stopSchedulers: StopScheduler[] = [];
const httpActivity = createActivityTracker();
const wsActivity = createActivityTracker();
const openSockets = new Set<Socket>();
const runtimeHealth = createRuntimeHealth(async () => {
  await getPool().query('SELECT 1');
});
let shutdownPromise: Promise<void> | null = null;

validatePushConfig();

// If behind a reverse proxy (nginx/caddy/traefik), enable TRUST_PROXY so req.ip
// is derived from X-Forwarded-For.
//
// SECURITY NOTE:
// - Prefer trusting only the *direct* proxy hop (e.g. 1), not "true" (all),
//   and have Nginx overwrite X-Forwarded-For to $remote_addr to prevent spoofing.
if (runtimeConfig.trustProxy !== false) {
  app.set('trust proxy', runtimeConfig.trustProxy);
}
const server = createServer(app);
server.on('connection', (socket) => {
  openSockets.add(socket);
  socket.once('close', () => openSockets.delete(socket));
});
const wsAdmissions = new WeakMap<IncomingMessage, { lease: ConnectionLease; familyId?: string; circleId?: string }>();
const wsResources = new WsResourceGuard(
  runtimeConfig.webSocket.limits,
  processWsMessage,
  error => logger.error('ws_message_handler_uncaught_error', { error }),
  reason => logger.warn('ws_resource_limit', { reason, ...wsResources.snapshot() }),
  handleClose,
  isSocketInRealtimeSession
);
const wss = new WebSocketServer({
  server,
  path: runtimeConfig.webSocket.path,
  maxPayload: runtimeConfig.webSocket.maxPayloadBytes,
  verifyClient(info, done) {
    const lease = wsResources.reserve(wsClientAddress(app, info.req), info.req.socket);
    if (!lease) { done(false, 503, 'WebSocket connection limit'); return; }
    const admission: { lease: ConnectionLease; familyId?: string; circleId?: string } = { lease };
    wsAdmissions.set(info.req, admission);
    void (async () => {
      const origin = String(info.origin || '').trim() || null;
      const host = getRequestHost(info.req as any);
      if (!host) {
        return { allowed: false as const, reason: 'missing_host', host: null, familyId: null, origin };
      }

      const circleContext = await resolveCircleContextFromHost(host, getRequestedCircleId(info.req));
      if (!circleContext) {
        return { allowed: false as const, reason: 'circle_not_found', host, familyId: null, origin };
      }
      const { familyId, circleId } = circleContext;
      if (await getCircleFreezeState(familyId)) {
        return { allowed: false as const, reason: 'circle_frozen', host, familyId, origin };
      }

      const allowed = await isTrustedClientRequestOrigin(info.origin, familyId);
      return allowed
        ? { allowed: true as const, host, familyId, circleId, origin }
        : { allowed: false as const, reason: 'untrusted_origin', host, familyId, origin };
    })().then((result) => {
      if (!result.allowed || !lease.active || info.req.socket.destroyed) {
        lease.release();
        logger.warn('ws_connection_rejected', {
          reason: result.allowed ? 'handshake_expired' : result.reason,
          host: result.host,
          familyId: result.familyId,
          origin: result.origin
        });
        done(false, 403, 'Forbidden');
        return;
      }
      admission.familyId = result.familyId;
      admission.circleId = result.circleId;
      done(true);
    }).catch((error) => {
      lease.release();
      logger.warn('ws_origin_validation_failed', { error });
      done(false, 403, 'Forbidden');
    });
  }
});

// Basic middleware
app.use(requestContextMiddleware);
app.use(securityHeaders);
app.use((_req, res, next) => {
  const finish = httpActivity.begin();
  res.once('finish', finish);
  res.once('close', finish);
  next();
});
app.use((req, _res, next) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  const contentType = String(req.headers['content-type'] || '');
  if (
    Number.isFinite(contentLength) &&
    contentLength >= runtimeConfig.largeJsonRequestLogThresholdBytes &&
    contentType.toLowerCase().includes('application/json')
  ) {
    getRequestLogger({ subsystem: 'http' }).warn('http_large_json_request', {
      contentLength,
      contentType
    });
  }
  next();
});

// Process liveness deliberately does not depend on PostgreSQL. Readiness does.
app.get('/live', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    ts: Date.now()
  });
});

const readinessHandler: express.RequestHandler = async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const result = await runtimeHealth.readiness();
  res.status(result.ready ? 200 : 503).json({
    status: result.ready ? 'ok' : 'unavailable',
    ...(result.reason ? { reason: result.reason } : {}),
    ts: Date.now()
  });
};
app.get('/ready', readinessHandler);
// Backwards-compatible alias. Deployment health checks should prefer /ready.
app.get('/health', readinessHandler);

// Host-level provisioning endpoints must run before tenancyMiddleware because
// the first circle is created before the host has a family_domains mapping.
app.use('/api/host-provisioning', cors(createCorsOptions()), express.json(), hostProvisioningRoutes);
// S2S Circle migration endpoints use the destination service endpoint before a
// tenant/domain mapping exists. The router has dedicated IP rate limits and
// migration-session authentication.
app.use('/api/migration', express.json({ limit: '256kb' }), circleMigrationRoutes);
// Completed migrations are resolved before tenancy because the old domain is
// deliberately no longer an active family_domains mapping.
app.use(
  circleMigrationBridgeContextMiddleware,
  cors(createCorsOptions()),
  circleMigrationBridgeMiddleware
);

// Cheap IP limit before tenant lookups and body parsing. Provisioning and
// migration endpoints above retain their dedicated limiters.
const globalApiLimiter = createRateLimiter({
  name: 'api:global',
  windowMs: runtimeConfig.http.globalRateLimit.windowMs,
  max: runtimeConfig.http.globalRateLimit.max,
  keyFn: ipKey
});
app.use('/api', globalApiLimiter);

// An Inspector request starts with only a VPS origin. The owner chooses the
// Circle on the phone; all approved reads remain tenant-scoped below.
app.use('/api/inspector', express.json({ limit: runtimeConfig.http.jsonBodyLimits.default }), inspectorBootstrapRoutes);

// Tenancy middleware - MUST be before all tenant-scoped API routes.
// Resolves family_id for each request from active family domain mappings.
app.use(tenancyMiddleware);
app.use(cors(createCorsOptions()));

const defaultJsonParser = express.json({ limit: runtimeConfig.http.jsonBodyLimits.default });
const avatarJsonParser = express.json({ limit: '512kb' });
const messageArchiveJsonParser = express.json({
  limit: runtimeConfig.http.jsonBodyLimits.messageArchive
});
const vaultJsonLimit = runtimeConfig.http.jsonBodyLimits.vault;
const vaultJsonParser = express.json({ limit: vaultJsonLimit });
logger.info('http_vault_json_limit_configured', { limit: vaultJsonLimit });
app.use((req, res, next) => {
  const path = req.path || req.url || '';
  if (path.startsWith('/api/identities/avatar')) return avatarJsonParser(req, res, next);
  if (path.startsWith('/api/message-archive')) return messageArchiveJsonParser(req, res, next);
  // Vault can carry legacy photo-gallery thumbnails saved before they were shrunk.
  if (path.startsWith('/api/vault')) return vaultJsonParser(req, res, next);
  return defaultJsonParser(req, res, next);
});
app.use(requestBodyErrorHandler);

app.use('/api', circleMigrationFreezeMiddleware);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/config', configRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/admin/migration', circleMigrationAdminRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/invites', invitesRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/identities', identitiesRoutes);
app.use('/api/circle-membership', circleMembershipRoutes);
app.use('/api/call-links', callLinksRoutes);
app.use('/api/access-state', accessVersionsRoutes);
app.use('/api/call-admission', callAdmissionRoutes);
app.use('/api/calls', callsRoutes);
app.use('/api/mobile', mobileRoutes);
app.use('/api/group-chats', groupChatsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/system-events', systemEventsRoutes);
app.use('/api/direct-guest-links', directGuestLinksRoutes);
app.use('/api/direct-guest-links', directGuestLinkPublicRoutes);
app.use('/api/announcement-channels', announcementChannelsRoutes);
app.use('/api/server-admin/migration-slots', serverAdminMigrationSlotsRoutes);
app.use('/api/server-admin', serverAdminRoutes);
app.use('/api/tenant-owner', tenantOwnerClaimsRoutes);
app.use('/api/device-enrollments', deviceEnrollmentsRoutes);
app.use('/api/temporary-access', temporaryAccessRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/message-archive', messageArchiveRoutes);
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/link-preview', linkPreviewRoutes);
app.use('/api/links', linksRoutes);
app.use('/api/server', serverRoutes);
app.use('/api/inspector', inspectorRoutes);
app.use('/api/circle-site', circleSiteRoutes);

// Public Circle Site static serving, at the Circle domain root. Must be mounted
// after every /api/* route so API paths keep priority; runs downstream of the
// globally-mounted tenancyMiddleware above, so req.familyId is already resolved.
app.use(publicSiteRoutes);

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const admission = wsAdmissions.get(req);
  wsAdmissions.delete(req);
  if (!admission?.familyId || !wsResources.attach(ws, admission.lease)) {
    admission?.lease.release();
    ws.terminate();
    return;
  }
  setSocketFamilyContext(ws, admission.familyId, admission.circleId);
  logger.info('ws_connection_established', { familyId: admission.familyId });

  // Heartbeat
  (ws as any).isAlive = true;
  ws.on('pong', () => {
    (ws as any).isAlive = true;
  });

  ws.on('message', data => wsResources.enqueue(ws, data));

  ws.on('error', (err) => {
    logger.error('ws_transport_error', { error: err });
  });

  ws.on('close', (code, reason) => {
    handleClose(ws);
    const reasonText = reason ? reason.toString() : '';
    logger.info('ws_connection_closed', { code, hasReason: reasonText.length > 0 });
  });
});

function safeSend(ws: WebSocket, payload: unknown) {
  try {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  } catch (error) {
    // Best-effort: socket might be closing/closed.
    logger.warn('ws_message_send_failed', { error });
  }
}

async function processWsMessage(ws: WebSocket, data: WebSocket.RawData): Promise<void> {
  const finish = wsActivity.begin();
  try {
    const text = Array.isArray(data) ? Buffer.concat(data).toString()
      : data instanceof ArrayBuffer ? Buffer.from(data).toString() : data.toString();
    const message = JSON.parse(text);
    wsResources.noteMessage(ws, message);
    await handleMessage(ws, message);
  } catch (error) {
    logger.error('ws_message_parse_or_process_failed', { error });
    safeSend(ws, { type: 'error', data: { code: 'INVALID_MESSAGE', message: 'Failed to parse message' }, timestamp: Date.now() });
  } finally {
    finish();
  }
}

// WebSocket heartbeat
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if ((ws as any).isAlive === false) {
      return ws.terminate();
    }

    (ws as any).isAlive = false;
    ws.ping();
  });
}, runtimeConfig.webSocket.heartbeatIntervalMs);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Database connection and server startup
async function startServer() {
  try {
    // Connect to PostgreSQL
    initializeDatabase(runtimeConfig.databaseUrl);
    await acquireServerProcessLock();
    logger.info('database_connected');

    // Start cleanup scheduler (auto-delete completed calls)
    stopSchedulers.push(
      startCleanupScheduler(),
      startCallHistoryHeartbeatCleanupScheduler(),
      startExpiredInviteCleanupScheduler(),
      startAnnouncementChannelPushOutboxScheduler(),
      startTrustedDeviceRekeyScheduler()
    );

    // Start server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(runtimeConfig.port, () => {
        server.off('error', onError);
        resolve();
      });
    });
    runtimeHealth.markReady();
    logger.info('server_started', {
      port: runtimeConfig.port,
      webSocketPath: runtimeConfig.webSocket.path,
      vpsId: runtimeConfig.vpsId
    });

  } catch (error) {
    logger.error('server_start_failed', { error });
    await closeDatabase();
    process.exit(1);
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const timeoutMs = runtimeConfig.shutdownGracePeriodMs;
    logger.info('server_shutdown_started', { signal, timeoutMs });
    runtimeHealth.markNotReady();
    stopCallRingingTimers();
    clearInterval(heartbeatInterval);

    const httpClosed = new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
    for (const client of wss.clients) client.close(1001, 'Server shutting down');
    const wsClosed = new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    const workDrained = Promise.all([
      httpClosed,
      wsClosed,
      Promise.all(stopSchedulers.map((stop) => stop())).then(() => undefined),
      httpActivity.waitForIdle(timeoutMs).then(() => undefined),
      wsActivity.waitForIdle(timeoutMs).then(() => undefined)
    ]);
    let timeout: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      workDrained.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      })
    ]);
    if (timeout) clearTimeout(timeout);
    if (!completed) {
      logger.warn('server_shutdown_timed_out', {
        activeHttpRequests: httpActivity.activeCount(),
        activeWebSocketMessages: wsActivity.activeCount()
      });
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections?.();
      for (const socket of openSockets) socket.destroy();
    }
    await closeDatabase();
    logger.info('server_shutdown_completed');
  })();
  return shutdownPromise;
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error('server_shutdown_failed', { signal, error });
        process.exit(1);
      });
  });
}

// Start server
startServer();
