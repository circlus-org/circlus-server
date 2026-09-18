import { compatiblePushRegistration } from '../services/compatiblePushRegistration';
import { isTrustedClientRequestOrigin } from '../middleware/security';
import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import express from 'express';
import { callSessionRepository, deviceRepository, identityRepository } from '../db/repositories';
import {
  mobileNotificationRepository,
  normalizeNativeMessagePreviewMode
} from '../db/repositories/mobileNotificationRepository';
import {
  verifySignature as verifyDeviceSignature,
  requireActiveIdentity,
  type AuthRequest
} from '../middleware/auth';
import { verifyMobileCallActionToken } from '../utils/mobileCallActionToken';
import { verifyMobileCallBootstrapToken } from '../utils/mobileCallBootstrapToken';
import {
  closeHttpCallRuntimeSession,
  createHttpCallRuntimeSession,
  declineCallViaMobileAction,
  pollHttpCallRuntimeMessages,
  sendHttpCallRuntimeMessage
} from '../ws/wsGateway';
import type { IdentityId, WebSocketMessage } from '@shared/types';
import type { TenancyRequest } from '../middleware/tenancy';
import { configService } from '../services/configService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

const router = express.Router();

async function resolvePublishedIdentityName(familyId: string, identity: any | null): Promise<string | undefined> {
  void familyId;
  void identity;
  return undefined;
}

function normalizeOrigin(value: string | null | undefined): string | null {
  const s = (value || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

router.post('/devices/bindings/unbind', verifyDeviceSignature, reliableOperation(async (req: AuthRequest, res) => {
  if (req.signedRequest?.type !== 'mobile:device:delivery-token:unregister') {
    return res.status(400).json({ success: false, error: 'Unexpected signed request type' });
  }
  const familyId = req.familyId;
  if (!familyId || !req.device?.deviceId) {
    return res.status(500).json({ success: false, error: 'Family context is missing' });
  }

  await mobileNotificationRepository.unbindToWebPush(familyId, req.device.deviceId);
  return res.json({
    success: true,
    webDeviceId: req.device.deviceId,
    route: 'web_push'
  });
}, req => 'mobile:'+req.device.deviceId));

router.get('/devices/bindings/status', async (req, res) => {
  const { familyId } = req as TenancyRequest;
  if (!familyId) {
    return res.status(500).json({ success: false, error: 'Family context is missing' });
  }

  const webDeviceId = String(req.query.webDeviceId || '');
  if (!webDeviceId) {
    return res.status(400).json({ success: false, error: 'Missing webDeviceId' });
  }

  const binding = await mobileNotificationRepository.getActiveBindingByWebDeviceId(familyId, webDeviceId);
  if (!binding) {
    return res.json({ success: true, route: 'web_push', bound: false });
  }

  return res.json({
    success: true,
    bound: true,
    route: binding.route,
    webDeviceId: binding.web_device_id,
    mobileEndpointId: binding.mobile_endpoint_ref || binding.mobile_endpoint_id,
    boundWebOrigin: binding.bound_web_origin,
    boundAt: binding.bound_at
  });
});

router.post('/devices/delivery-tokens/register', verifyDeviceSignature, requireActiveIdentity, compatiblePushRegistration(async (req: AuthRequest<{
  mobileEndpointId?: string;
  deliveryToken?: string;
  deliveryTokenExpiresAt?: string;
  webOrigin?: string;
  pushEncryptionPublicKey: string;
  nativeMessagePreviewMode?: string;
}>, res) => {
  const startedAt = Date.now();
  const familyId = req.familyId;
  if (!familyId) {
    routeLogger.warn('[FamilyServer][mobile:delivery-token:register] missing family context');
    return res.status(500).json({ success: false, error: 'Family context is missing' });
  }

  const payload = (req.signedRequest?.payload || {}) as {
    mobileEndpointId?: string;
    deliveryToken?: string;
    deliveryTokenExpiresAt?: string;
    webOrigin?: string;
    pushEncryptionPublicKey?: string;
    nativeMessagePreviewMode?: string;
  };
  const mobileEndpointId = String(payload.mobileEndpointId || '').trim();
  const deliveryToken = String(payload.deliveryToken || '').trim();
  const deliveryTokenExpiresAtRaw = String(payload.deliveryTokenExpiresAt || '').trim();
  const pushEncryptionPublicKey = String(payload.pushEncryptionPublicKey || '').trim();
  const nativeMessagePreviewMode = normalizeNativeMessagePreviewMode(payload.nativeMessagePreviewMode);
  const deliveryTokenExpiresAt = deliveryTokenExpiresAtRaw
    ? new Date(deliveryTokenExpiresAtRaw)
    : null;
  const boundWebOrigin = normalizeOrigin(payload.webOrigin) || null;
  const webDeviceId = String(req.device?.deviceId || '').trim();

  routeLogger.info('[FamilyServer][mobile:delivery-token:register] request', {
    familyId,
    webDeviceId,
    mobileEndpointId,
    hasDeliveryCredential: !!deliveryToken,
  });

  if (!mobileEndpointId || !deliveryToken) {
    routeLogger.warn('[FamilyServer][mobile:delivery-token:register] rejected missing params', {
      familyId,
      webDeviceId,
      mobileEndpointId,
      hasDeliveryCredential: !!deliveryToken,
    });
    return res.status(400).json({ success: false, error: 'Missing mobileEndpointId or deliveryToken' });
  }
  if (!pushEncryptionPublicKey) {
    return res.status(400).json({ success: false, error: 'pushEncryptionPublicKey is required' });
  }
  if (deliveryTokenExpiresAtRaw && Number.isNaN(deliveryTokenExpiresAt?.getTime())) {
    routeLogger.warn('[FamilyServer][mobile:delivery-token:register] rejected invalid expiry', {
      familyId,
      webDeviceId,
      mobileEndpointId,
      hasExpiry: Boolean(deliveryTokenExpiresAtRaw),
    });
    return res.status(400).json({ success: false, error: 'Invalid deliveryTokenExpiresAt' });
  }

  await mobileNotificationRepository.upsertDirectMobileRoute({
    familyId,
    webDeviceId,
    mobileEndpointId,
    boundWebOrigin,
    deliveryToken,
    deliveryTokenExpiresAt,
    pushEncryptionPublicKey,
    nativeMessagePreviewMode
  });

  routeLogger.info('[FamilyServer][mobile:delivery-token:register] success', {
    familyId,
    webDeviceId,
    mobileEndpointId,
    durationMs: Date.now() - startedAt,
  });

  return res.json({ success: true });
}, req => 'mobile:'+req.device.deviceId));

router.post('/calls/bootstrap', async (req, res) => {
  const { familyId } = req as TenancyRequest;
  if (!familyId) {
    return res.status(500).json({ success: false, error: 'Family context is missing' });
  }

  const callSessionId = String(req.body?.callSessionId || '').trim();
  const bootstrapToken = String(req.body?.bootstrapToken || '').trim();
  const requestedDeviceId = String(req.body?.deviceId || '').trim();
  if (!callSessionId || !bootstrapToken) {
    return res.status(400).json({ success: false, error: 'Missing callSessionId or bootstrapToken' });
  }

  const token = verifyMobileCallBootstrapToken(bootstrapToken);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Invalid or expired bootstrapToken' });
  }
  if (token.familyId !== familyId || token.callSessionId !== callSessionId) {
    return res.status(403).json({ success: false, error: 'Bootstrap token mismatch' });
  }

  const callSession = await callSessionRepository.findByCallSessionId(familyId, callSessionId);
  if (!callSession) {
    return res.status(404).json({ success: false, error: 'Call session not found' });
  }
  if (callSession.state !== 'new' && callSession.state !== 'ringing') {
    return res.status(409).json({ success: false, error: 'Call is no longer in ringing state' });
  }
  if (!callSession.participants.includes(token.targetIdentityId)) {
    return res.status(403).json({ success: false, error: 'Identity is not a participant in this call' });
  }

  const localIdentity = await identityRepository.findByIdentityId(
    familyId,
    token.targetIdentityId as IdentityId
  );
  if (!localIdentity || localIdentity.status !== 'active') {
    return res.status(403).json({ success: false, error: 'Bootstrap identity is not active' });
  }

  // Determine caller identity (the other participant)
  const remoteIdentityId = callSession.participants.find((p: string) => p !== token.targetIdentityId) ?? '';
  if (!requestedDeviceId) {
    return res.status(400).json({ success: false, error: 'Missing deviceId' });
  }
  const device = await deviceRepository.findByDeviceId(familyId, requestedDeviceId as any);
  if (!device || device.identity_id !== token.targetIdentityId || device.status !== 'active') {
    return res.status(403).json({ success: false, error: 'Bootstrap device is not active for this identity' });
  }
  const runtimeDeviceId = device.device_id;

  const familyConfig = await configService.getFamilyConfig(familyId);
  const signalingUrl = (() => {
    try {
      const base = String(familyConfig?.public_base_url || '').trim() || `${req.protocol}://${req.get('host') || ''}`;
      const url = new URL(base);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/ws';
      url.search = '';
      url.searchParams.set('circleId', familyConfig!.circle_id);
      url.searchParams.set('vpsId', getServerIdentityRuntimeConfig().vpsId);
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  })();

  // Include the stored SDP offer so the native client can answer without waiting for a WS call:incoming.
  // Strip internal metadata fields (e.g. __externalCaller) before sending to the client.
  let offer: Record<string, unknown> | null = null;
  let remoteIdentityPublicKey: { algorithm: string; value: string } | undefined;
  let remoteIdentityName: string | undefined;
  if (callSession.sdp_offer) {
    try {
      const raw = JSON.parse(callSession.sdp_offer) as Record<string, unknown>;
      const externalMeta = (raw as any).__externalCaller as
        | {
            publicKey?: { algorithm: 'ed25519' | 'x25519'; value: string };
            displayName?: string | null;
          }
        | undefined;
      delete raw.__externalCaller;
      offer = raw;
      const remoteIdentity = await identityRepository.findByIdentityId(familyId, remoteIdentityId as any);
      remoteIdentityPublicKey = remoteIdentity
        ? {
            algorithm: remoteIdentity.public_key_algorithm,
            value: remoteIdentity.public_key_value
          }
        : externalMeta?.publicKey;
      remoteIdentityName = remoteIdentity
        ? await resolvePublishedIdentityName(familyId, remoteIdentity)
        : (externalMeta?.displayName || undefined);
    } catch {
      // best-effort — client falls back to WS call:incoming if offer is absent
    }
  }

  return res.json({
    success: true,
    callSessionId,
    localIdentityId: token.targetIdentityId,
    deviceId: runtimeDeviceId,
    circleId: familyConfig!.circle_id,
    vpsId: getServerIdentityRuntimeConfig().vpsId,
    signalingUrl,
    remoteIdentityId,
    ...(remoteIdentityName ? { remoteIdentityName } : {}),
    ...(remoteIdentityPublicKey ? { remoteIdentityPublicKey } : {}),
    ...(offer ? { offer } : {})
  });
});

router.post('/calls/status', async (req, res) => {
  const { familyId } = req as TenancyRequest;
  if (!familyId) {
    return res.status(500).json({ success: false, error: 'Family context is missing' });
  }

  const callSessionId = String(req.body?.callSessionId || '').trim();
  const bootstrapToken = String(req.body?.bootstrapToken || '').trim();
  if (!callSessionId || !bootstrapToken) {
    return res.status(400).json({ success: false, error: 'Missing callSessionId or bootstrapToken' });
  }

  const token = verifyMobileCallBootstrapToken(bootstrapToken);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Invalid or expired bootstrapToken' });
  }
  if (token.familyId !== familyId || token.callSessionId !== callSessionId) {
    return res.status(403).json({ success: false, error: 'Bootstrap token mismatch' });
  }

  const callSession = await callSessionRepository.findByCallSessionId(familyId, callSessionId);
  if (!callSession) {
    return res.status(404).json({
      success: true,
      callSessionId,
      state: 'missing',
      ringing: false
    });
  }
  if (!callSession.participants.includes(token.targetIdentityId)) {
    return res.status(403).json({ success: false, error: 'Identity is not a participant in this call' });
  }

  return res.json({
    success: true,
    callSessionId,
    state: callSession.state,
    ringing: callSession.state === 'new' || callSession.state === 'ringing'
  });
});

router.post('/calls/signaling/register', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { familyId, circleId } = req as TenancyRequest;
  if (!familyId || !circleId) {
    return res.status(500).json({ success: false, error: 'Circle context is missing' });
  }

  const signedRequest = req.body?.signedRequest;
  if (!signedRequest && !req.body?.registration) {
    return res.status(400).json({ success: false, error: 'Missing signedRequest or registration' });
  }

  if (!await isTrustedClientRequestOrigin(req.get('origin'), familyId)) return res.status(403).json({ success: false, error: 'Untrusted origin' });
  const result = await createHttpCallRuntimeSession({ familyId, circleId, signedRequest, registration: req.body?.registration, address: req.ip || req.socket.remoteAddress || 'unknown', protocol: req.body?.protocol, origin: req.get('origin') });
  if (!result.ok) {
    return res.status(result.status).json({ success: false, error: result.error, messages: result.messages || [] });
  }

  return res.json({
    success: true,
    sessionId: result.sessionId,
    messages: result.messages
  });
});

router.post('/calls/signaling/send', async (req, res) => {
  const sessionId = String(req.get('authorization')?.replace(/^Bearer /, '') || req.body?.sessionId || '').trim();
  const message = req.body?.message as WebSocketMessage | undefined;
  if (!sessionId || !message || typeof message.type !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing sessionId or message' });
  }

  const result = await sendHttpCallRuntimeMessage({ sessionId, message, familyId: (req as TenancyRequest).familyId, origin: req.get('origin'), sequence: req.body?.sequence });
  if (!result.ok) {
    return res.status(result.status).json({ success: false, error: result.error });
  }

  return res.json({ success: true, messages: result.messages });
});

router.all('/calls/signaling/poll', async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.sendStatus(405);
  res.set('Cache-Control', 'no-store');
  const sessionId = String(req.get('authorization')?.replace(/^Bearer /, '') || req.query.sessionId || '').trim();
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Missing sessionId' });
  }

  const timeoutMs = Number.parseInt(String(req.query.timeoutMs || '10000'), 10);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  const result = await pollHttpCallRuntimeMessages({
    sessionId, familyId: (req as TenancyRequest).familyId, origin: req.get('origin'), ack: req.body?.ack,
    signal: controller.signal,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined
  }).finally(() => res.off('close', cancel));
  if (res.destroyed) return;
  if (!result.ok) {
    return res.status(result.status).json({ success: false, error: result.error });
  }

  return res.json({ success: true, messages: result.messages, events: result.events });
});

router.post('/calls/signaling/close', async (req, res) => {
  const sessionId = String(req.get('authorization')?.replace(/^Bearer /, '') || req.body?.sessionId || '').trim();
  if (sessionId) {
    closeHttpCallRuntimeSession(sessionId, (req as TenancyRequest).familyId, req.get('origin'));
  }
  return res.json({ success: true });
});

router.post('/calls/decline', async (req, res) => {
  const { familyId } = req as TenancyRequest;
  if (!familyId) {
    return res.status(500).json({ success: false, error: 'Family context is missing' });
  }

  const callSessionId = String(req.body?.callSessionId || '').trim();
  const declineToken = String(req.body?.declineToken || '').trim();
  routeLogger.info('[FamilyServer][mobile:call:decline] request', {
    familyId,
    callSessionId,
    hasDeclineToken: Boolean(declineToken),
  });
  if (!callSessionId || !declineToken) {
    routeLogger.warn('[FamilyServer][mobile:call:decline] rejected missing params', {
      familyId,
      callSessionId,
      hasDeclineToken: Boolean(declineToken),
    });
    return res.status(400).json({ success: false, error: 'Missing callSessionId or declineToken' });
  }

  const token = verifyMobileCallActionToken(declineToken);
  if (!token || token.action !== 'decline') {
    routeLogger.warn('[FamilyServer][mobile:call:decline] rejected invalid token', {
      familyId,
      callSessionId,
    });
    return res.status(401).json({ success: false, error: 'Invalid decline token' });
  }
  if (token.familyId !== familyId || token.callSessionId !== callSessionId) {
    routeLogger.warn('[FamilyServer][mobile:call:decline] rejected token mismatch', {
      familyId,
      callSessionId,
      credentialFamilyMatches: token.familyId === familyId,
      credentialCallSessionMatches: token.callSessionId === callSessionId,
    });
    return res.status(403).json({ success: false, error: 'Decline token mismatch' });
  }

  const result = await declineCallViaMobileAction({
    familyId,
    callSessionId: token.callSessionId as any,
    targetIdentityId: token.targetIdentityId as any
  });

  if (result.status === 'forbidden') {
    routeLogger.warn('[FamilyServer][mobile:call:decline] forbidden', {
      familyId,
      callSessionId,
      targetIdentityId: token.targetIdentityId,
    });
    return res.status(403).json({ success: false, error: 'Target identity is not a participant in this call' });
  }

  routeLogger.info('[FamilyServer][mobile:call:decline] success', {
    familyId,
    callSessionId,
    targetIdentityId: token.targetIdentityId,
    status: result.status,
  });
  return res.json({ success: true, status: result.status });
});

export default router;
