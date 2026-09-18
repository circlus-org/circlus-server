import { messageReactionsHandler } from './messageReactions';
import { query as replayQuery } from '../db';
import { MessageRevisionConflict } from '../services/messageRevision';
import { routeLogger } from '../utils/routeLogger';
import { Router, type NextFunction, type Response } from 'express';
import { verifySignature, requireActiveIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import type {
  ApiResponse,
  DeviceRegistrationAttestation,
  DirectEpochTransitionClaim,
  DirectEpochTransitionPayload,
  DirectMessageAuthorClaim,
  DirectMessageDeliveryProof,
  ErrorCode,
  IdentityId,
  PublicKey,
  TemporaryIdentityDelegationCredential,
} from '../../../shared/types';
import { verifySignedRequest } from '../utils/crypto';
import { deviceRepository, identityRepository, messageRepository, temporaryDeviceRepository } from '../db/repositories';
import { resolveDirectCommunicationAccess } from '../services/directGuestAccessService';
import { configService } from '../services/configService';
import {
  DirectMessageServiceError,
  deleteDirectMessage,
  editDirectMessage,
  fetchDirectMessageStatusSync,
  fetchDirectMessageSync,
  markDirectMessagesRead,
  sendDirectMessage,
  updateDirectMessageStatus,
} from '../services/directMessages';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';
import {
  claimAndPublishDirectEpochKey,
  DirectKeyEpochPersistenceError
} from '../services/directKeyEpochService';

const router = Router();
const messageRateLimits = getRateLimitRuntimeConfig().messages;

const messagesLimiter = createRateLimiter({
  name: 'api:messages',
  windowMs: messageRateLimits.windowMs,
  max: messageRateLimits.max,
  keyFn: ipFamilyKey,
});

router.use(messagesLimiter);
router.post('/reactions/list', verifySignature, requireActiveIdentity, requireTrustedDirectDevice, messageReactionsHandler('direct', false));
router.post('/reactions/set', verifySignature, requireActiveIdentity, requireTrustedDirectDevice, messageReactionsHandler('direct', true));

function getDirectChatParticipants(a: string, b: string): [IdentityId, IdentityId] {
  const left = (a || '').trim() as IdentityId;
  const right = (b || '').trim() as IdentityId;
  return left < right ? [left, right] : [right, left];
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function parseDirectKeyEnvelopePublisher(envelopeCiphertext: string): string | null {
  if (!envelopeCiphertext.startsWith('dk2:') || envelopeCiphertext.length > 64_000) return null;
  const remainder = envelopeCiphertext.slice('dk2:'.length);
  const separatorIndex = remainder.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === remainder.length - 1) return null;
  return remainder.slice(0, separatorIndex).trim() || null;
}

function getDirectChatId(a: string, b: string): string {
  const [left, right] = getDirectChatParticipants(a, b);
  return `${left}::${right}`;
}

function requireTrustedDirectDevice(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.device?.accessLevel === 'temporary') {
    res.status(403).json({
      status: 'error',
      error: { code: 'FORBIDDEN' as ErrorCode, message: 'Temporary devices cannot perform this direct-message action' }
    } as ApiResponse);
    return;
  }
  next();
}

async function requireGrantedTemporaryDirectChat(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.device?.accessLevel !== 'temporary') {
    next();
    return;
  }
  const familyId = req.familyId;
  const identityId = req.device.identityId;
  const payload = getSignedPayload<{ peerIdentityId?: string; recipientIdentityId?: string }>(req);
  const peerIdentityId = String(payload.peerIdentityId || payload.recipientIdentityId || '').trim();
  const directChatId = peerIdentityId ? getDirectChatId(identityId, peerIdentityId) : '';
  if (!familyId || !directChatId || !await temporaryDeviceRepository.hasChatAccess(familyId, req.device.deviceId, directChatId, 'direct')) {
    res.status(403).json({
      status: 'error',
      error: { code: 'FORBIDDEN' as ErrorCode, message: 'Temporary device has no access to this chat' }
    } as ApiResponse);
    return;
  }
  next();
}

async function requireGrantedTemporaryDirectMessage(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.device?.accessLevel !== 'temporary') {
    next();
    return;
  }
  const familyId = req.familyId;
  const payload = getSignedPayload<{ serverMessageId?: string }>(req);
  const serverMessageId = String(payload.serverMessageId || '').trim();
  const message = familyId && serverMessageId ? await messageRepository.findMessageById(familyId, serverMessageId) : null;
  const directChatId = message ? getDirectChatId(message.sender_identity_id, message.recipient_identity_id) : '';
  if (!familyId || !directChatId || !await temporaryDeviceRepository.hasChatAccess(familyId, req.device.deviceId, directChatId, 'direct')) {
    res.status(403).json({
      status: 'error',
      error: { code: 'FORBIDDEN' as ErrorCode, message: 'Temporary device has no access to this chat' }
    } as ApiResponse);
    return;
  }
  next();
}

function parseRegistrationAttestation(value: unknown): DeviceRegistrationAttestation | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as DeviceRegistrationAttestation;
    } catch {
      return null;
    }
  }
  return value as DeviceRegistrationAttestation;
}

function validateDirectEpochTransitionClaim(params: {
  claim: DirectEpochTransitionClaim | undefined;
  directChatId: string;
  participantIdentityIds: [IdentityId, IdentityId];
  epoch: number;
  previousEpoch: number | null;
  keyCommitment: string;
  proposerIdentityId: IdentityId;
  proposerDeviceId: string;
  proposerDevicePublicKey: PublicKey;
}): { ok: true } | { ok: false; message: string } {
  const claim = params.claim;
  if (!claim || claim.type !== 'dir:epoch-transition') {
    return { ok: false, message: 'signedEpochTransition is required' };
  }
  if (claim.signerId !== params.proposerDeviceId) {
    return { ok: false, message: 'Epoch transition signer must be proposer device' };
  }
  const payload = claim.payload as DirectEpochTransitionPayload | undefined;
  const expectedParticipants = [...params.participantIdentityIds].sort();
  const payloadParticipants = [...(payload?.participantIdentityIds || [])].sort();
  const matches =
    payload?.version === 1 &&
    payload?.purpose === 'direct-epoch-transition-v1' &&
    payload?.directChatId === params.directChatId &&
    payload?.epoch === params.epoch &&
    payload?.previousEpoch === params.previousEpoch &&
    payload?.keyCommitment === params.keyCommitment &&
    payload?.proposerIdentityId === params.proposerIdentityId &&
    payload?.proposerDeviceId === params.proposerDeviceId &&
    payloadParticipants[0] === expectedParticipants[0] &&
    payloadParticipants[1] === expectedParticipants[1];
  if (!matches) {
    return { ok: false, message: 'Epoch transition payload mismatch' };
  }
  if (!verifySignedRequest(claim, params.proposerDevicePublicKey)) {
    return { ok: false, message: 'Invalid epoch transition signature' };
  }
  return { ok: true };
}

function handleRouteError(res: Response, error: unknown, label: string) {
  if (error instanceof MessageRevisionConflict) return res.status(409).json({status:'error',error:{code:'CONFLICT',message:error.message}});
  if (error instanceof DirectMessageServiceError) {
    return res.status(error.status).json({
      status: 'error',
      error: {
        code: error.code,
        message: error.message,
      },
    } as ApiResponse);
  }

  routeLogger.error(`${label} error:`, error);
  return res.status(500).json({
    status: 'error',
    error: {
      code: 'INTERNAL_ERROR' as ErrorCode,
      message: 'Internal server error',
    },
  } as ApiResponse);
}

router.post('/send', verifySignature, requireActiveIdentity, requireGrantedTemporaryDirectChat, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const deviceId = req.device?.deviceId;
    if (!familyId || !identityId || !deviceId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing',
        },
      } as ApiResponse);
    }

    const payload = getSignedPayload<{
      recipientIdentityId?: string;
      ciphertext?: string;
      senderCiphertext?: string;
      notificationPreviewCiphertext?: string;
      senderSignature?: string;
      authorClaim?: DirectMessageAuthorClaim;
      temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
      clientMessageId?: string;
      clientCreatedAt?: number;
      epoch?: number;
    }>(req);

    const result = await sendDirectMessage({
      familyId,
      senderIdentityId: identityId,
      senderDeviceId: deviceId,
      recipientIdentityId: String(payload.recipientIdentityId || '').trim(),
      ciphertext: String(payload.ciphertext || ''),
      senderCiphertext: payload.senderCiphertext,
      notificationPreviewCiphertext: typeof payload.notificationPreviewCiphertext === 'string' ? payload.notificationPreviewCiphertext : null,
      senderSignature: String(payload.senderSignature || ''),
      authorClaim: payload.authorClaim,
      temporaryDevice: req.device?.accessLevel === 'temporary',
      temporaryIdentityDelegation: payload.temporaryIdentityDelegation,
      clientMessageId: String(payload.clientMessageId || '').trim(),
      clientCreatedAt: typeof payload.clientCreatedAt === 'number' ? payload.clientCreatedAt : null,
      epoch: typeof payload.epoch === 'number' ? payload.epoch : null,
    });

    return res.json({
      status: 'ok',
      result,
    } as ApiResponse);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message send');
  }
});

router.post('/key/claim-or-publish', verifySignature, requireActiveIdentity, requireTrustedDirectDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId as IdentityId | undefined;
    const deviceId = req.device?.deviceId;
    if (!familyId || !identityId || !deviceId || !req.device) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const payload = getSignedPayload<{
      peerIdentityId?: string;
      epoch?: number;
      keyCommitment?: string;
      signedEpochTransition?: DirectEpochTransitionClaim;
      envelopes?: Array<{ identityId: string; envelopeCiphertext: string }>;
    }>(req);
    const peerIdentityId = String(payload.peerIdentityId || '').trim() as IdentityId;
    const epoch = typeof payload.epoch === 'number' ? payload.epoch : 1;
    const keyCommitment = String(payload.keyCommitment || '').trim();
    if (!peerIdentityId || !isSha256Hex(keyCommitment) || !Array.isArray(payload.envelopes)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'peerIdentityId, sha256 keyCommitment and envelopes are required' } } as ApiResponse);
    }

    const access = await resolveDirectCommunicationAccess(familyId, identityId, peerIdentityId, 'messages');
    if (!access.allowed) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Direct messaging is not allowed' } } as ApiResponse);
    }

    const participantIdentityIds = getDirectChatParticipants(identityId, peerIdentityId);
    const directChatId = getDirectChatId(identityId, peerIdentityId);
    const currentEpoch = await messageRepository.getDirectCurrentEpoch(familyId, directChatId);
    const requestedReason = payload.signedEpochTransition?.payload?.reason;
    const isSafeRekeyAdvance = epoch === currentEpoch + 1 && requestedReason === 'rekey';
    if (epoch !== currentEpoch && !isSafeRekeyAdvance) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Direct key epoch mismatch' } } as ApiResponse);
    }
    const devicePublicKey: PublicKey = {
      algorithm: req.device.publicKey.algorithm as 'ed25519' | 'x25519',
      value: req.device.publicKey.value
    };
    const transitionCheck = validateDirectEpochTransitionClaim({
      claim: payload.signedEpochTransition,
      directChatId,
      participantIdentityIds,
      epoch,
      previousEpoch: epoch > 1 ? epoch - 1 : null,
      keyCommitment,
      proposerIdentityId: identityId,
      proposerDeviceId: deviceId,
      proposerDevicePublicKey: devicePublicKey
    });
    if (!transitionCheck.ok) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: transitionCheck.message } } as ApiResponse);
    }

    const allowed = new Set(participantIdentityIds);
    const normalizedEnvelopes: Array<{ identityId: IdentityId; envelopeCiphertext: string }> = [];
    const envelopeIdentityIds = new Set<IdentityId>();
    for (const envelope of payload.envelopes) {
      const envelopeIdentityId = String(envelope.identityId || '').trim() as IdentityId;
      const envelopeCiphertext = String(envelope.envelopeCiphertext || '').trim();
      const publisherIdentityId = parseDirectKeyEnvelopePublisher(envelopeCiphertext);
      if (
        !allowed.has(envelopeIdentityId)
        || publisherIdentityId !== identityId
        || envelopeIdentityIds.has(envelopeIdentityId)
      ) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Exactly one envelope is required for each direct chat participant' }
        } as ApiResponse);
      }
      envelopeIdentityIds.add(envelopeIdentityId);
      normalizedEnvelopes.push({ identityId: envelopeIdentityId, envelopeCiphertext });
    }
    if (participantIdentityIds.some((participantIdentityId) => !envelopeIdentityIds.has(participantIdentityId))) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Exactly one envelope is required for each direct chat participant' }
      } as ApiResponse);
    }

    const claimResult = await claimAndPublishDirectEpochKey({
        familyId,
        directChatId,
        epoch,
        keyCommitment,
        proposerIdentityId: identityId,
        proposerDeviceId: deviceId,
        signedEpochTransition: payload.signedEpochTransition!,
        envelopes: normalizedEnvelopes,
        advanceEpoch: isSafeRekeyAdvance
    });
    const existing = claimResult.existing;

    return res.json({
      status: 'ok',
      result: {
        directChatId,
        epoch,
        keyCommitment,
        signedEpochTransition: claimResult.inserted?.signed_epoch_transition || existing?.signed_epoch_transition || payload.signedEpochTransition,
        accepted: Boolean(claimResult.inserted),
        updated: normalizedEnvelopes.length
      }
    } as ApiResponse);
  } catch (error) {
    if (error instanceof DirectKeyEpochPersistenceError && error.kind === 'epoch_state_conflict') {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Direct key epoch mismatch' } } as ApiResponse);
    }
    if (error instanceof DirectKeyEpochPersistenceError && error.kind === 'commitment_conflict') {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'keyCommitment mismatch for this direct epoch' } } as ApiResponse);
    }
    return handleRouteError(res, error, 'Direct key claim-or-publish');
  }
});

router.post('/key/fetch', verifySignature, requireActiveIdentity, requireGrantedTemporaryDirectChat, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId as IdentityId | undefined;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    const payload = getSignedPayload<{ peerIdentityId?: string; epoch?: number }>(req);
    const peerIdentityId = String(payload.peerIdentityId || '').trim() as IdentityId;
    if (!peerIdentityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'peerIdentityId is required' } } as ApiResponse);
    }
    const access = await resolveDirectCommunicationAccess(familyId, identityId, peerIdentityId, 'messages');
    if (!access.allowed) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Direct messaging is not allowed' } } as ApiResponse);
    }

    const participantIdentityIds = getDirectChatParticipants(identityId, peerIdentityId);
    const directChatId = getDirectChatId(identityId, peerIdentityId);
    if (payload.epoch === undefined && req.device?.accessLevel !== 'temporary') {
      const config = await configService.getResolvedFamilyConfig(familyId);
      await messageRepository.bumpDirectEpochIfStale(
        familyId,
        directChatId,
        config.chatEpochRotationIntervalHours * 60 * 60 * 1000
      );
    }
    const epoch = typeof payload.epoch === 'number'
      ? payload.epoch
      : await messageRepository.getDirectCurrentEpoch(familyId, directChatId);
    const [epochKey, envelope] = await Promise.all([
      messageRepository.findDirectEpochKey(familyId, directChatId, epoch),
      req.device?.accessLevel === 'temporary'
        ? temporaryDeviceRepository.findDirectChatKeyEnvelope(familyId, req.device.deviceId, directChatId, epoch)
        : messageRepository.findDirectKeyEnvelopeForIdentity(familyId, directChatId, epoch, identityId)
    ]);
    const identityPublicKeys: Record<string, PublicKey> = {};
    const devicesByIdentityId: Record<string, unknown[]> = {};
    const [participantIdentities, participantDevices] = await Promise.all([
      identityRepository.findByIdentityIds(familyId, participantIdentityIds),
      deviceRepository.findActiveByIdentityIds(familyId, participantIdentityIds)
    ]);
    for (const identity of participantIdentities) {
      identityPublicKeys[identity.identity_id] = {
        algorithm: identity.public_key_algorithm as 'ed25519' | 'x25519',
        value: identity.public_key_value
      };
    }
    const participantDevicesByIdentityId = new Map<string, typeof participantDevices>();
    for (const device of participantDevices) {
      const devices = participantDevicesByIdentityId.get(device.identity_id) || [];
      devices.push(device);
      participantDevicesByIdentityId.set(device.identity_id, devices);
    }
    for (const participantIdentityId of participantIdentityIds) {
      devicesByIdentityId[participantIdentityId] = (participantDevicesByIdentityId.get(participantIdentityId) || [])
        .map((device) => ({
        deviceId: device.device_id,
        identityId: device.identity_id,
        publicKey: {
          algorithm: device.public_key_algorithm as 'ed25519' | 'x25519',
          value: device.public_key_value
        },
        encryptionPublicKey: device.encryption_public_key_value ? {
          algorithm: device.encryption_public_key_algorithm as 'x25519',
          value: device.encryption_public_key_value
        } : null,
        registrationAttestation: parseRegistrationAttestation((device as { registration_attestation?: unknown }).registration_attestation),
        createdAt: new Date(Number(device.created_at)).toISOString(),
        status: device.status
        }));
    }

    return res.json({
      status: 'ok',
      result: {
        directChatId,
        participantIdentityIds,
        epoch,
        keyCommitment: epochKey?.key_commitment || null,
        signedEpochTransition: epochKey?.signed_epoch_transition || null,
        proposerIdentityId: epochKey?.proposer_identity_id || null,
        proposerDeviceId: epochKey?.proposer_device_id || null,
        envelopeCiphertext: envelope?.envelope_ciphertext || null,
        publisherIdentityId: envelope?.publisher_identity_id || null,
        identityPublicKeys,
        devicesByIdentityId,
        hasEnvelope: Boolean(envelope),
        hasEpochKey: Boolean(epochKey),
        canRecoverByRekey: payload.epoch === undefined
      }
    } as ApiResponse);
  } catch (error) {
    return handleRouteError(res, error, 'Direct key fetch');
  }
});

router.post('/status', verifySignature, requireActiveIdentity, requireGrantedTemporaryDirectMessage, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing',
        },
      } as ApiResponse);
    }

    const payload = getSignedPayload<{ serverMessageId?: string; status?: 'delivered' | 'read'; deliveryProof?: DirectMessageDeliveryProof }>(req);
    const serverMessageId = String(payload.serverMessageId || '').trim();
    const status = payload.status;
    if (!serverMessageId || (status !== 'delivered' && status !== 'read')) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: 'serverMessageId and valid status are required',
        },
      } as ApiResponse);
    }

    const result = await updateDirectMessageStatus({
      familyId,
      identityId,
      deviceId: req.device?.deviceId,
      serverMessageId,
      status,
      deliveryProof: payload.deliveryProof,
    });

    return res.json({
      status: 'ok',
      result,
    } as ApiResponse);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message status');
  }
});

router.post('/list', verifySignature, requireActiveIdentity, requireGrantedTemporaryDirectChat, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const deviceId = req.device?.deviceId;
    if (!familyId || !identityId || !deviceId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing',
        },
      } as ApiResponse);
    }

    const payload = getSignedPayload<{ since?: number; limit?: number; peerIdentityId?: string }>(req);
    const peerIdentityId = typeof payload.peerIdentityId === 'string' && payload.peerIdentityId.trim()
      ? payload.peerIdentityId.trim()
      : undefined;
    const result = await fetchDirectMessageSync({
      familyId,
      identityId,
      deviceId,
      since: typeof payload.since === 'number' ? payload.since : undefined,
      limit: typeof payload.limit === 'number' ? payload.limit : undefined,
      peerIdentityId,
    });

    return res.json({ status: 'ok', result } as ApiResponse);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message list');
  }
});

router.post('/status-list', verifySignature, requireActiveIdentity, requireGrantedTemporaryDirectChat, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const deviceId = req.device?.deviceId;
    if (!familyId || !identityId || !deviceId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing',
        },
      } as ApiResponse);
    }

    const payload = getSignedPayload<{ since?: number; limit?: number; peerIdentityId?: string }>(req);
    const peerIdentityId = typeof payload.peerIdentityId === 'string' && payload.peerIdentityId.trim()
      ? payload.peerIdentityId.trim()
      : undefined;
    const result = await fetchDirectMessageStatusSync({
      familyId,
      identityId,
      deviceId,
      since: typeof payload.since === 'number' ? payload.since : undefined,
      limit: typeof payload.limit === 'number' ? payload.limit : undefined,
      peerIdentityId,
    });

    return res.json({ status: 'ok', result } as ApiResponse);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message status-list');
  }
});

function parseSyncAcknowledgement(req: AuthRequest): number | null {
  const syncedThrough = getSignedPayload<{ syncedThrough?: number }>(req).syncedThrough;
  return typeof syncedThrough === 'number'
    && Number.isSafeInteger(syncedThrough)
    && syncedThrough >= 0
    ? syncedThrough
    : null;
}

router.post('/sync/ack', verifySignature, requireActiveIdentity, requireTrustedDirectDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const deviceId = req.device?.deviceId;
    const syncedThrough = parseSyncAcknowledgement(req);
    if (!familyId || !deviceId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (syncedThrough === null) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid direct message sync acknowledgement' } } as ApiResponse);
    }
    const state = await messageRepository.getSyncState(familyId, deviceId);
    await messageRepository.updateSyncState(
      familyId,
      deviceId,
      Math.max(state.last_sync_at, syncedThrough),
      state.last_status_sync_at,
      Math.max(state.last_mutation_sync_at, syncedThrough)
    );
    return res.json({ status: 'ok', result: null } as ApiResponse<null>);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message sync acknowledgement');
  }
});

router.post('/sync-status/ack', verifySignature, requireActiveIdentity, requireTrustedDirectDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const deviceId = req.device?.deviceId;
    const syncedThrough = parseSyncAcknowledgement(req);
    if (!familyId || !deviceId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (syncedThrough === null) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid direct message status sync acknowledgement' } } as ApiResponse);
    }
    const state = await messageRepository.getSyncState(familyId, deviceId);
    await messageRepository.updateSyncState(
      familyId,
      deviceId,
      state.last_sync_at,
      Math.max(state.last_status_sync_at, syncedThrough),
      state.last_mutation_sync_at
    );
    return res.json({ status: 'ok', result: null } as ApiResponse<null>);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message status sync acknowledgement');
  }
});

router.post('/edit', verifySignature, requireActiveIdentity, requireGrantedTemporaryDirectMessage, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing',
        },
      } as ApiResponse);
    }

    const payload = getSignedPayload<{
      serverMessageId?: string;
      ciphertext?: string;
      senderCiphertext?: string;
      senderSignature?: string;
      authorClaim?: DirectMessageAuthorClaim;
      epoch?: number;
    }>(req);

    const result = await editDirectMessage({
      familyId,
      identityId,
      serverMessageId: String(payload.serverMessageId || '').trim(),
      ciphertext: String(payload.ciphertext || ''),
      senderCiphertext: payload.senderCiphertext,
      senderSignature: String(payload.senderSignature || ''),
      authorClaim: payload.authorClaim,
      temporaryDevice: req.device?.accessLevel === 'temporary',
      epoch: typeof payload.epoch === 'number' ? payload.epoch : null,
    });

    return res.json({
      status: 'ok',
      result,
    } as ApiResponse);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message edit');
  }
});

router.post('/delete', verifySignature, requireActiveIdentity, requireGrantedTemporaryDirectMessage, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing',
        },
      } as ApiResponse);
    }

    const payload = getSignedPayload<{ serverMessageId?: string; authorClaim?: DirectMessageAuthorClaim }>(req);
    const result = await deleteDirectMessage({
      familyId,
      identityId,
      serverMessageId: String(payload.serverMessageId || '').trim(),
      authorClaim: payload.authorClaim,
      temporaryDevice: req.device?.accessLevel === 'temporary',
    });

    return res.json({
      status: 'ok',
      result,
    } as ApiResponse);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message delete');
  }
});

router.post('/clear-boundary', verifySignature, requireActiveIdentity, requireTrustedDirectDevice, async (req: AuthRequest, res, next) => {
  try {
  const peer = String((req.signedRequest?.payload as {peerIdentityId?:string})?.peerIdentityId || '');
  const access = await resolveDirectCommunicationAccess(req.familyId!, req.device!.identityId, peer as IdentityId, 'messages');
  if (!access.allowed) return res.status(403).json({status:'error',error:{code:'FORBIDDEN'}});
  const result = await replayQuery(`SELECT COALESCE(MAX(chat_seq),0) AS boundary FROM messages WHERE family_id=$1 AND ((sender_identity_id=$2 AND recipient_identity_id=$3) OR (sender_identity_id=$3 AND recipient_identity_id=$2))`,[req.familyId,req.device!.identityId,peer]);
  return res.json({status:'ok',result:{clearThroughSequence:Number(result.rows[0].boundary)}});
  } catch (error) { next(error); }
});

router.post('/clear', verifySignature, requireActiveIdentity, requireTrustedDirectDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing',
        },
      } as ApiResponse);
    }

    const payload = getSignedPayload<{ peerIdentityId?: string; clearThroughSequence?: number }>(req);
    const peerIdentityId = String(payload.peerIdentityId || '').trim() as IdentityId;
    if (!peerIdentityId) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: 'peerIdentityId is required',
        },
      } as ApiResponse);
    }

    const access = await resolveDirectCommunicationAccess(familyId, identityId, peerIdentityId, 'messages');
    if (!access.allowed) {
      return res.status(403).json({
        status: 'error',
        error: {
          code: 'FORBIDDEN' as ErrorCode,
          message: 'Direct messaging is not allowed',
        },
      } as ApiResponse);
    }

    if (!Number.isSafeInteger(payload.clearThroughSequence) || Number(payload.clearThroughSequence) < 0) return res.status(400).json({status:'error',error:{code:'INVALID_REQUEST',message:'clearThroughSequence is required'}});
    const deletedCount = await messageRepository.deleteThreadMessages(familyId, identityId, peerIdentityId, payload.clearThroughSequence!);
    return res.json({
      status: 'ok',
      result: { deletedCount },
    } as ApiResponse);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message clear');
  }
});

router.post('/mark-read', verifySignature, requireActiveIdentity, requireGrantedTemporaryDirectChat, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing',
        },
      } as ApiResponse);
    }

    const payload = getSignedPayload<{ peerIdentityId?: string; readThrough?: number }>(req);
    const peerIdentityId = String(payload.peerIdentityId || '').trim();
    const readThrough = Number(payload.readThrough || 0);
    if (!peerIdentityId || !Number.isFinite(readThrough) || readThrough <= 0) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: 'peerIdentityId and valid readThrough are required',
        },
      } as ApiResponse);
    }

    const result = await markDirectMessagesRead({
      familyId,
      identityId,
      peerIdentityId,
      readThrough,
    });

    return res.json({
      status: 'ok',
      result,
    } as ApiResponse);
  } catch (error) {
    return handleRouteError(res, error, 'Direct message mark-read');
  }
});

export default router;
