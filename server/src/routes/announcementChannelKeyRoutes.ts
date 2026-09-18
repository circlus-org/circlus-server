import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  getSignedPayload,
  requireActiveIdentity,
  verifySignature,
  type AuthRequest
} from '../middleware/auth';
import {
  announcementChannelRepository,
  identityRepository
} from '../db/repositories';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import { canReadAnnouncementChannel } from './announcementChannelAccess';
import {
  AnnouncementChannelKeyEpochPersistenceError,
  claimAndPublishAnnouncementChannelEpochKey
} from '../services/announcementChannelKeyEpochService';
import { listCircleIdentityAdmissionProofs } from '../services/circleMembershipProofService';
import { listCircleMembershipStates } from '../services/circleMembershipStateService';

const router = Router();

router.post('/:channelId/keys/claim', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const deviceId = req.device?.deviceId;
    const channelId = String(req.params.channelId || '').trim();
    if (!familyId || !identityId || !deviceId || !channelId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Channel context is required' } } as ApiResponse);
    }
    const channel = await announcementChannelRepository.findById(familyId, channelId);
    if (!channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' } } as ApiResponse);
    }
    const payload = getSignedPayload<{
      epoch?: unknown;
      keyCommitment?: unknown;
      membershipStateId?: unknown;
      envelopes?: Array<{ identityId?: unknown; envelopeCiphertext?: unknown }>;
    }>(req);
    const epoch = Number(payload.epoch);
    const keyCommitment = String(payload.keyCommitment || '').trim().toLowerCase();
    const membershipStateId = String(payload.membershipStateId || '').trim();
    const membershipStates = await listCircleMembershipStates(familyId);
    if (epoch !== Number(channel.key_epoch) || !/^[a-f0-9]{64}$/.test(keyCommitment)
      || membershipStates.at(-1)?.claim.payload.stateId !== membershipStateId) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Channel key epoch or commitment is invalid' } } as ApiResponse);
    }
    const rawEnvelopes = Array.isArray(payload.envelopes) ? payload.envelopes : [];
    const envelopes = rawEnvelopes.map((item) => ({
      identityId: String(item.identityId || '').trim(),
      envelopeCiphertext: String(item.envelopeCiphertext || ''),
    })).filter((item) => item.identityId && item.envelopeCiphertext);
    if (rawEnvelopes.length > 500 || envelopes.length !== rawEnvelopes.length) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid channel key envelope' } } as ApiResponse);
    }
    const eligible = await announcementChannelRepository.listMissingKeyRecipients({
      familyId,
      channelId,
      ownerIdentityId: identityId,
      epoch,
    });
    const eligibleIds = new Set(eligible.map((item) => item.identity_id));
    const envelopeIds = new Set(envelopes.map((envelope) => envelope.identityId));
    if (envelopeIds.size !== envelopes.length || eligible.some((recipient) => !envelopeIds.has(recipient.identity_id))) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'An envelope is required for every channel key recipient' } } as ApiResponse);
    }
    for (const envelope of envelopes) {
      if (!eligibleIds.has(envelope.identityId) || !envelope.envelopeCiphertext.startsWith(`gk2:${identityId}:`) || envelope.envelopeCiphertext.length > 64_000) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid channel key envelope' } } as ApiResponse);
      }
    }
    await claimAndPublishAnnouncementChannelEpochKey({
        familyId,
        channelId,
        epoch,
        keyCommitment,
        proposerIdentityId: identityId,
        proposerDeviceId: deviceId,
        signedEpochTransition: req.signedRequest,
        membershipStateId,
        envelopes
    });
    return res.json({ status: 'ok', result: { channelId, epoch, keyCommitment, updated: envelopes.length } } as ApiResponse);
  } catch (error) {
    if (error instanceof AnnouncementChannelKeyEpochPersistenceError) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Channel epoch was initialized with another key' } } as ApiResponse);
    }
    routeLogger.error('Claim channel epoch key error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/keys/publish', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    if (!familyId || !identityId || !channelId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Channel context is required' } } as ApiResponse);
    }
    const channel = await announcementChannelRepository.findById(familyId, channelId);
    if (!channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' } } as ApiResponse);
    }
    const payload = getSignedPayload<{
      epoch?: unknown;
      keyCommitment?: unknown;
      membershipStateId?: unknown;
      envelopes?: Array<{ identityId?: unknown; envelopeCiphertext?: unknown }>;
    }>(req);
    const epoch = Number(payload.epoch);
    const commitment = String(payload.keyCommitment || '').trim().toLowerCase();
    const membershipStateId = String(payload.membershipStateId || '').trim();
    const membershipStates = await listCircleMembershipStates(familyId);
    const epochKey = await announcementChannelRepository.findEpochKey(familyId, channelId, epoch);
    if (!epochKey || epoch !== Number(channel.key_epoch) || epochKey.key_commitment !== commitment
      || membershipStates.at(-1)?.claim.payload.stateId !== membershipStateId) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Channel epoch key is not initialized' } } as ApiResponse);
    }
    const missing = await announcementChannelRepository.listMissingKeyRecipients({ familyId, channelId, ownerIdentityId: identityId, epoch });
    const missingIds = new Set(missing.map((item) => item.identity_id));
    const envelopes = (Array.isArray(payload.envelopes) ? payload.envelopes : []).map((item) => ({
      identityId: String(item.identityId || '').trim(),
      envelopeCiphertext: String(item.envelopeCiphertext || ''),
    })).filter((item) => item.identityId && item.envelopeCiphertext);
    for (const envelope of envelopes) {
      if (!missingIds.has(envelope.identityId) || !envelope.envelopeCiphertext.startsWith(`gk2:${identityId}:`) || envelope.envelopeCiphertext.length > 64_000) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid channel key envelope' } } as ApiResponse);
      }
    }
    await announcementChannelRepository.upsertKeyEnvelopes({
      familyId, channelId, epoch, publisherIdentityId: identityId, membershipStateId, envelopes,
    });
    return res.json({ status: 'ok', result: { channelId, epoch, updated: envelopes.length } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Publish channel key envelopes error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/keys/missing', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const channel = familyId ? await announcementChannelRepository.findById(familyId, channelId) : null;
    if (!familyId || !identityId || !channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' } } as ApiResponse);
    }
    const payload = getSignedPayload<{ epoch?: unknown }>(req);
    const requestedEpoch = payload.epoch === undefined ? Number(channel.key_epoch) : Number(payload.epoch);
    const currentEpoch = Number(channel.key_epoch);
    if (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < currentEpoch || requestedEpoch > currentEpoch + 1) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'The requested channel epoch is invalid' } } as ApiResponse);
    }
    const epoch = requestedEpoch;
    const recipients = await announcementChannelRepository.listMissingKeyRecipients({ familyId, channelId, ownerIdentityId: identityId, epoch });
    const [membershipProofs, membershipStates] = await Promise.all([
      listCircleIdentityAdmissionProofs(familyId, {
        includeDirectGuests: true,
        directGuestIdentityIds: recipients.map((recipient) => recipient.identity_id),
      }),
      listCircleMembershipStates(familyId),
    ]);
    const epochKey = await announcementChannelRepository.findEpochKey(familyId, channelId, epoch);
    return res.json({
      status: 'ok',
      result: {
        channelId,
        epoch,
        keyCommitment: epochKey?.key_commitment || null,
        recipients: recipients.map((item) => ({
          identityId: item.identity_id,
          publicKey: { algorithm: item.public_key_algorithm, value: item.public_key_value },
          sourceLinkId: item.source_link_id,
          subscriptionClaim: item.subscription_claim,
        })),
        membershipProofs,
        membershipStates,
      },
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List missing channel key envelopes error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/keys/rotate', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const deviceId = req.device?.deviceId;
    const channelId = String(req.params.channelId || '').trim();
    const channel = familyId ? await announcementChannelRepository.findById(familyId, channelId) : null;
    if (!familyId || !identityId || !deviceId || !channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' } } as ApiResponse);
    }
    const payload = getSignedPayload<{
      nextEpoch?: unknown;
      keyCommitment?: unknown;
      membershipStateId?: unknown;
      envelopes?: Array<{ identityId?: unknown; envelopeCiphertext?: unknown }>;
      reason?: unknown;
    }>(req);
    const nextEpoch = Number(payload.nextEpoch);
    const keyCommitment = String(payload.keyCommitment || '').trim().toLowerCase();
    const membershipStateId = String(payload.membershipStateId || '').trim();
    const membershipStates = await listCircleMembershipStates(familyId);
    const reason = payload.reason === 'forced_removal' || payload.reason === 'compromise' || payload.reason === 'manual'
      ? payload.reason
      : null;
    if (nextEpoch !== Number(channel.key_epoch) + 1 || !/^[a-f0-9]{64}$/.test(keyCommitment) || !reason
      || membershipStates.at(-1)?.claim.payload.stateId !== membershipStateId) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'The next channel epoch is invalid' } } as ApiResponse);
    }
    const eligible = await announcementChannelRepository.listMissingKeyRecipients({
      familyId,
      channelId,
      ownerIdentityId: identityId,
      epoch: nextEpoch,
    });
    const envelopes = (Array.isArray(payload.envelopes) ? payload.envelopes : []).map((item) => ({
      identityId: String(item.identityId || '').trim(),
      envelopeCiphertext: String(item.envelopeCiphertext || ''),
    })).filter((item) => item.identityId && item.envelopeCiphertext);
    const expectedIds = new Set(eligible.map((item) => item.identity_id));
    const actualIds = new Set(envelopes.map((item) => item.identityId));
    if (expectedIds.size !== actualIds.size || [...expectedIds].some((id) => !actualIds.has(id))) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'A key envelope is required for every active subscriber' } } as ApiResponse);
    }
    if (envelopes.some((item) => !item.envelopeCiphertext.startsWith(`gk2:${identityId}:`) || item.envelopeCiphertext.length > 64_000)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid channel key envelope' } } as ApiResponse);
    }
    const activated = await announcementChannelRepository.rotateEpoch({
      familyId,
      channelId,
      ownerIdentityId: identityId,
      proposerDeviceId: deviceId,
      nextEpoch,
      keyCommitment,
      signedEpochTransition: req.signedRequest,
      membershipStateId,
      envelopes,
    });
    if (!activated) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Channel epoch changed concurrently' } } as ApiResponse);
    }
    return res.json({ status: 'ok', result: { channelId, keyEpoch: activated, reason } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Rotate channel key epoch error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/keys/fetch', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    if (!familyId || !identityId || !await canReadAnnouncementChannel(familyId, channelId, identityId)) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' } } as ApiResponse);
    }
    const channel = await announcementChannelRepository.findById(familyId, channelId);
    const payload = getSignedPayload<{ epoch?: unknown }>(req);
    const epoch = Number(payload.epoch || channel?.key_epoch || 1);
    const [epochKey, envelope, membershipProofs, membershipStates] = await Promise.all([
      announcementChannelRepository.findEpochKey(familyId, channelId, epoch),
      announcementChannelRepository.findKeyEnvelope(familyId, channelId, epoch, identityId),
      listCircleIdentityAdmissionProofs(familyId, {
        includeDirectGuests: true,
        directGuestIdentityIds: [identityId],
      }),
      listCircleMembershipStates(familyId),
    ]);
    const publisher = envelope
      ? await identityRepository.findByIdentityId(familyId, envelope.publisher_identity_id)
      : null;
    return res.json({
      status: 'ok',
      result: {
        channelId,
        epoch,
        keyCommitment: epochKey?.key_commitment || null,
        signedEpochTransition: epochKey?.signed_epoch_transition || null,
        membershipStateId: envelope?.membership_state_id || epochKey?.membership_state_id || null,
        membershipProofs,
        membershipStates,
        envelopeCiphertext: envelope?.envelope_ciphertext || null,
        publisherIdentityId: envelope?.publisher_identity_id || null,
        publisherPublicKey: publisher ? { algorithm: publisher.public_key_algorithm, value: publisher.public_key_value } : null,
        hasEnvelope: Boolean(envelope),
      },
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Fetch channel key envelope error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

export default router;
