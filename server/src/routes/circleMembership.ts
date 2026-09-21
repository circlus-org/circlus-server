import { Router } from 'express';
import type {
  ApiResponse,
  CircleEncryptedSharedMetadata,
  CircleEncryptedIdentityProfile,
  CircleMembershipStateRecord,
  CircleProfileEpochClaim,
  CircleProfileEpochEnvelope,
  ErrorCode,
  PublicKey,
} from '../../../shared/types';
import { query, transaction } from '../db';
import {
  getSignedPayload,
  requireActiveIdentity,
  requireAdmin,
  requireFullCircleIdentity,
  verifySignature,
  type AuthRequest,
} from '../middleware/auth';
import { listCircleIdentityAdmissionProofs } from '../services/circleMembershipProofService';
import {
  appendCircleMembershipState,
  listCircleMembershipStates,
} from '../services/circleMembershipStateService';
import { routeLogger } from '../utils/routeLogger';
import { verifySignedRequest } from '../utils/crypto';
import { isValidCircleProfileEpochAdvance } from '../services/circleProfileEpochPolicy';
import { decideCircleProfilePublication } from '../services/circleProfilePublicationPolicy';
import { circleProfileAvatarBlobId } from '../services/circleProfileAvatarPublication';
import { notifyCircleDirectoryChanged } from '../services/circleDirectoryNotificationService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';
import type { TenancyRequest } from '../middleware/tenancy';
import { createRateLimiter, deviceFamilyKey, ipFamilyKey } from '../middleware/rateLimit';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';

const router = Router();
const directoryRateLimits = getRateLimitRuntimeConfig().identities;
const rlDirectoryIp = createRateLimiter({
  name: 'circle-membership:directory-ip',
  windowMs: directoryRateLimits.windowMs,
  max: directoryRateLimits.directoryMax * 10,
  keyFn: ipFamilyKey,
});
const rlDirectoryDevice = createRateLimiter({
  name: 'circle-membership:directory-device',
  windowMs: directoryRateLimits.windowMs,
  max: directoryRateLimits.directoryMax,
  keyFn: deviceFamilyKey,
});

router.post('/head', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' } } as ApiResponse);
    }
    const result = await query<{
      membership_state_id: string | null;
      membership_sequence: string | number | null;
      profile_epoch: string | number | null;
      profile_epoch_count: string | number;
      profile_envelope_count: string | number;
      profile_count: string | number;
      profile_revision_sum: string | number;
      shared_metadata_revision: string | number | null;
    }>(
      `SELECT
         (SELECT state_id FROM circle_membership_states WHERE family_id = $1 ORDER BY sequence DESC LIMIT 1) AS membership_state_id,
         (SELECT sequence FROM circle_membership_states WHERE family_id = $1 ORDER BY sequence DESC LIMIT 1) AS membership_sequence,
         (SELECT MAX(epoch) FROM circle_profile_epochs WHERE family_id = $1) AS profile_epoch,
         (SELECT COUNT(*) FROM circle_profile_epochs WHERE family_id = $1) AS profile_epoch_count,
         (SELECT COUNT(*) FROM circle_profile_epoch_envelopes WHERE family_id = $1) AS profile_envelope_count,
         (SELECT COUNT(*) FROM circle_encrypted_identity_profiles WHERE family_id = $1) AS profile_count,
         (SELECT COALESCE(SUM(revision), 0)::text FROM circle_encrypted_identity_profiles WHERE family_id = $1) AS profile_revision_sum,
         (SELECT revision FROM circle_encrypted_shared_metadata WHERE family_id = $1) AS shared_metadata_revision`,
      [req.familyId]
    );
    const row = result.rows[0];
    return res.json({
      status: 'ok',
      result: {
        membershipStateId: row?.membership_state_id || null,
        membershipSequence: Number(row?.membership_sequence || 0),
        profileEpoch: Number(row?.profile_epoch || 0),
        profileEpochCount: Number(row?.profile_epoch_count || 0),
        profileEnvelopeCount: Number(row?.profile_envelope_count || 0),
        profileCount: Number(row?.profile_count || 0),
        profileRevisionSum: String(row?.profile_revision_sum || '0'),
        sharedMetadataRevision: Number(row?.shared_metadata_revision || 0),
      },
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Circle directory head load error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Unable to load Circle directory head' } } as ApiResponse);
  }
});

router.post('/state', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' } } as ApiResponse);
    }
    const [states, membershipProofs] = await Promise.all([
      listCircleMembershipStates(req.familyId),
      listCircleIdentityAdmissionProofs(req.familyId),
    ]);
    return res.json({ status: 'ok', result: { states, membershipProofs, atomicAdminMembershipTransitions: true } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Circle membership state load error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Unable to load Circle membership state' } } as ApiResponse);
  }
});

router.post('/directory', rlDirectoryIp, verifySignature, requireActiveIdentity, requireFullCircleIdentity, rlDirectoryDevice, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' } } as ApiResponse);
    }
    const [membershipProofs, membershipStates] = await Promise.all([
      listCircleIdentityAdmissionProofs(req.familyId),
      listCircleMembershipStates(req.familyId),
    ]);
    const members = membershipProofs
      .filter((proof) => proof.status === 'active' && proof.role !== 'guest')
      .map((proof) => ({ identityId: proof.identityId, publicKey: proof.publicKey }));
    return res.json({
      status: 'ok',
      result: { members, membershipProofs, membershipStates },
    } as ApiResponse<{
      members: Array<{ identityId: string; publicKey: PublicKey }>;
      membershipProofs: Awaited<ReturnType<typeof listCircleIdentityAdmissionProofs>>;
      membershipStates: Awaited<ReturnType<typeof listCircleMembershipStates>>;
    }>);
  } catch (error) {
    routeLogger.error('Circle directory load error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Unable to load Circle directory' } } as ApiResponse);
  }
});

type ProfileEpochRow = {
  claim: CircleProfileEpochClaim;
};

type ProfileEpochEnvelopeRow = {
  epoch: number;
  key_commitment: string;
  membership_state_id: string;
  publisher_identity_id: string;
  recipient_identity_id: string;
  envelope_ciphertext: string;
};

type EncryptedProfileRow = {
  owner_identity_id: string;
  epoch: number;
  revision: number;
  source_revision: number | null;
  publication_id: string;
  publication_kind: 'manual' | 'republish';
  ciphertext: string;
  updated_at: Date;
};

type EncryptedSharedMetadataRow = {
  owner_identity_id: string;
  epoch: number;
  revision: number;
  ciphertext: string;
  updated_at: Date;
};

function mapEpochEnvelope(row: ProfileEpochEnvelopeRow): CircleProfileEpochEnvelope {
  return {
    epoch: Number(row.epoch),
    keyCommitment: row.key_commitment,
    membershipStateId: row.membership_state_id,
    publisherIdentityId: row.publisher_identity_id,
    recipientIdentityId: row.recipient_identity_id,
    envelopeCiphertext: row.envelope_ciphertext,
  };
}

function mapEncryptedProfile(row: EncryptedProfileRow): CircleEncryptedIdentityProfile {
  return {
    ownerIdentityId: row.owner_identity_id,
    epoch: Number(row.epoch),
    revision: Number(row.revision),
    sourceRevision: row.source_revision === null ? null : Number(row.source_revision),
    publicationId: row.publication_id,
    publicationKind: row.publication_kind,
    ciphertext: row.ciphertext,
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapEncryptedSharedMetadata(row: EncryptedSharedMetadataRow): CircleEncryptedSharedMetadata {
  return {
    ownerIdentityId: row.owner_identity_id,
    epoch: Number(row.epoch),
    revision: Number(row.revision),
    ciphertext: row.ciphertext,
    updatedAt: row.updated_at.toISOString(),
  };
}

router.post('/profile-state', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId || !req.identity?.identityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle identity is required' } } as ApiResponse);
    }
    const [epochs, envelopes, epochRecipients, profiles, sharedMetadata] = await Promise.all([
      query<ProfileEpochRow>(
        `SELECT claim FROM circle_profile_epochs WHERE family_id = $1 ORDER BY epoch ASC`,
        [req.familyId]
      ),
      query<ProfileEpochEnvelopeRow>(
        `SELECT epoch, key_commitment, membership_state_id, publisher_identity_id,
                recipient_identity_id, envelope_ciphertext
           FROM circle_profile_epoch_envelopes
          WHERE family_id = $1 AND recipient_identity_id = $2
          ORDER BY epoch ASC`,
        [req.familyId, req.identity.identityId]
      ),
      query<{ epoch: number; recipient_identity_id: string }>(
        `SELECT epoch, recipient_identity_id FROM circle_profile_epoch_envelopes WHERE family_id = $1 ORDER BY epoch ASC`,
        [req.familyId]
      ),
      query<EncryptedProfileRow>(
        `SELECT owner_identity_id, epoch, revision, source_revision, publication_id,
                publication_kind, ciphertext, updated_at
           FROM circle_encrypted_identity_profiles
          WHERE family_id = $1
          ORDER BY updated_at DESC`,
        [req.familyId]
      ),
      query<EncryptedSharedMetadataRow>(
        `SELECT owner_identity_id, epoch, revision, ciphertext, updated_at
           FROM circle_encrypted_shared_metadata
          WHERE family_id = $1`,
        [req.familyId]
      ),
    ]);
    return res.json({
      status: 'ok',
      result: {
        epochs: epochs.rows.map((row) => row.claim),
        envelopes: envelopes.rows.map(mapEpochEnvelope),
        epochRecipients: epochRecipients.rows.map((row) => ({ epoch: Number(row.epoch), recipientIdentityId: row.recipient_identity_id })),
        profiles: profiles.rows.map(mapEncryptedProfile),
        sharedMetadata: sharedMetadata.rows[0] ? mapEncryptedSharedMetadata(sharedMetadata.rows[0]) : null,
      },
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Circle encrypted profile state load error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Unable to load encrypted Circle profiles' } } as ApiResponse);
  }
});

router.post('/shared-metadata/publish', verifySignature, requireActiveIdentity, requireAdmin, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId || !req.identity?.identityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle owner identity is required' } } as ApiResponse);
    }
    const metadata = getSignedPayload<{ metadata?: Partial<CircleEncryptedSharedMetadata> }>(req).metadata;
    const ownerIdentityId = typeof metadata?.ownerIdentityId === 'string' ? metadata.ownerIdentityId.trim() : '';
    const epoch = Number(metadata?.epoch);
    const revision = Number(metadata?.revision);
    const ciphertext = typeof metadata?.ciphertext === 'string' ? metadata.ciphertext.trim() : '';
    if (ownerIdentityId !== req.identity.identityId || !Number.isSafeInteger(epoch) || epoch < 1
      || !Number.isSafeInteger(revision) || revision < 1 || !ciphertext || ciphertext.length > 16384) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Invalid encrypted Circle metadata' } } as ApiResponse);
    }
    const result = await transaction(async (client) => {
      const latestEpoch = await client.query<{ epoch: number }>(
        `SELECT epoch FROM circle_profile_epochs WHERE family_id = $1 ORDER BY epoch DESC LIMIT 1 FOR UPDATE`,
        [req.familyId]
      );
      if (Number(latestEpoch.rows[0]?.epoch) !== epoch) return { conflict: true as const };
      const current = await client.query<EncryptedSharedMetadataRow>(
        `SELECT owner_identity_id, epoch, revision, ciphertext, updated_at
           FROM circle_encrypted_shared_metadata WHERE family_id = $1 FOR UPDATE`,
        [req.familyId]
      );
      const previous = current.rows[0];
      if (previous && revision <= Number(previous.revision)) {
        return { conflict: false as const, applied: false, metadata: mapEncryptedSharedMetadata(previous) };
      }
      const saved = await client.query<EncryptedSharedMetadataRow>(
        `INSERT INTO circle_encrypted_shared_metadata
           (family_id, owner_identity_id, epoch, revision, ciphertext)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (family_id) DO UPDATE SET
           owner_identity_id = EXCLUDED.owner_identity_id,
           epoch = EXCLUDED.epoch,
           revision = EXCLUDED.revision,
           ciphertext = EXCLUDED.ciphertext,
           updated_at = NOW()
         RETURNING owner_identity_id, epoch, revision, ciphertext, updated_at`,
        [req.familyId, ownerIdentityId, epoch, revision, ciphertext]
      );
      return { conflict: false as const, applied: true, metadata: mapEncryptedSharedMetadata(saved.rows[0]!) };
    });
    if (result.conflict) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Circle profile epoch changed' } } as ApiResponse);
    }
    if (result.applied) await notifyCircleDirectoryChanged(req.familyId, 'profile');
    return res.json({ status: 'ok', result: { applied: result.applied, metadata: result.metadata } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Encrypted Circle metadata publish error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Unable to publish encrypted Circle metadata' } } as ApiResponse);
  }
});

function normalizedEpochEnvelope(input: Partial<CircleProfileEpochEnvelope> | null | undefined): CircleProfileEpochEnvelope | null {
  if (!input || typeof input !== 'object') return null;
  const epoch = Number(input.epoch);
  const keyCommitment = typeof input.keyCommitment === 'string' ? input.keyCommitment.trim() : '';
  const membershipStateId = typeof input.membershipStateId === 'string' ? input.membershipStateId.trim() : '';
  const publisherIdentityId = typeof input.publisherIdentityId === 'string' ? input.publisherIdentityId.trim() : '';
  const recipientIdentityId = typeof input.recipientIdentityId === 'string' ? input.recipientIdentityId.trim() : '';
  const envelopeCiphertext = typeof input.envelopeCiphertext === 'string' ? input.envelopeCiphertext.trim() : '';
  if (!Number.isSafeInteger(epoch) || epoch < 1 || !keyCommitment || !membershipStateId || !publisherIdentityId || !recipientIdentityId || !envelopeCiphertext || envelopeCiphertext.length > 65536) return null;
  return { epoch, keyCommitment, membershipStateId, publisherIdentityId, recipientIdentityId, envelopeCiphertext };
}

router.post('/profile-epoch/publish', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId || !req.identity?.identityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle identity is required' } } as ApiResponse);
    }
    const payload = getSignedPayload<{ claim?: CircleProfileEpochClaim; envelopes?: Array<Partial<CircleProfileEpochEnvelope>> }>(req);
    const claim = payload.claim;
    const envelopes = Array.isArray(payload.envelopes) ? payload.envelopes.map(normalizedEpochEnvelope) : [];
    if (!claim || envelopes.length === 0 || envelopes.some((item) => !item)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Invalid Circle profile epoch' } } as ApiResponse);
    }
    const normalized = envelopes as CircleProfileEpochEnvelope[];
    const states = await listCircleMembershipStates(req.familyId);
    const head = states.at(-1)?.claim;
    const boundState = states.find((state) => state.claim.payload.stateId === claim.payload.membershipStateId)?.claim;
    const signer = head?.payload.members.find((member) => member.identityId === claim.signerId);
    if (
      claim.type !== 'circle:profile-epoch'
      || claim.signerId !== req.identity.identityId
      || claim.payload.version !== 1
      || claim.payload.purpose !== 'circle-profile-epoch-v1'
      || !head
      || !boundState
      || boundState.payload.stateId !== head.payload.stateId
      || claim.payload.circleId !== head.payload.circleId
      || claim.payload.membershipSequence !== boundState.payload.sequence
      || !signer
      || !verifySignedRequest(claim, signer.publicKey)
      || normalized.some((envelope) => (
        envelope.epoch !== claim.payload.epoch
        || envelope.keyCommitment !== claim.payload.keyCommitment
        || envelope.membershipStateId !== claim.payload.membershipStateId
        || envelope.publisherIdentityId !== claim.signerId
        || !head.payload.members.some((member) => member.identityId === envelope.recipientIdentityId)
      ))
    ) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Untrusted Circle profile epoch' } } as ApiResponse);
    }
    const previous = await query<{ epoch: number; key_commitment: string; membership_sequence: string }>(
      `SELECT epoch, key_commitment, membership_sequence FROM circle_profile_epochs WHERE family_id = $1 ORDER BY epoch DESC LIMIT 1`,
      [req.familyId]
    );
    const prior = previous.rows[0];
    if (!isValidCircleProfileEpochAdvance({
      claim,
      previous: prior ? {
        epoch: Number(prior.epoch),
        keyCommitment: prior.key_commitment,
        membershipSequence: Number(prior.membership_sequence),
      } : null,
      membershipStates: states,
    })) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Invalid Circle profile epoch transition' } } as ApiResponse);
    }
    await transaction(async (client) => {
      await client.query(`SELECT family_id FROM family_config WHERE family_id = $1 FOR UPDATE`, [req.familyId]);
      await client.query(
        `INSERT INTO circle_profile_epochs (family_id, epoch, membership_state_id, membership_sequence, key_commitment, claim)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [req.familyId, claim.payload.epoch, claim.payload.membershipStateId, claim.payload.membershipSequence, claim.payload.keyCommitment, JSON.stringify(claim)]
      );
      for (const envelope of normalized) {
        await client.query(
          `INSERT INTO circle_profile_epoch_envelopes (
             family_id, epoch, recipient_identity_id, publisher_identity_id,
             membership_state_id, key_commitment, envelope_ciphertext
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (family_id, epoch, recipient_identity_id) DO NOTHING`,
          [req.familyId, envelope.epoch, envelope.recipientIdentityId, envelope.publisherIdentityId, envelope.membershipStateId, envelope.keyCommitment, envelope.envelopeCiphertext]
        );
      }
    });
    await notifyCircleDirectoryChanged(req.familyId, 'profile_epoch');
    return res.json({ status: 'ok', result: { epoch: claim.payload.epoch } } as ApiResponse);
  } catch (error) {
    routeLogger.warn('Circle profile epoch publish rejected:', error);
    return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Unable to publish Circle profile epoch' } } as ApiResponse);
  }
});

router.post('/profile-epoch/envelopes/publish', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId || !req.identity?.identityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle identity is required' } } as ApiResponse);
    }
    const payload = getSignedPayload<{ envelopes?: Array<Partial<CircleProfileEpochEnvelope>> }>(req);
    const envelopes = Array.isArray(payload.envelopes) ? payload.envelopes.map(normalizedEpochEnvelope) : [];
    if (envelopes.length === 0 || envelopes.some((item) => !item)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Invalid Circle profile key envelopes' } } as ApiResponse);
    }
    const normalized = envelopes as CircleProfileEpochEnvelope[];
    const [states, epochResult] = await Promise.all([
      listCircleMembershipStates(req.familyId),
      query<{ epoch: number; key_commitment: string }>(`SELECT epoch, key_commitment FROM circle_profile_epochs WHERE family_id = $1 ORDER BY epoch DESC LIMIT 1`, [req.familyId]),
    ]);
    const head = states.at(-1)?.claim;
    const epoch = epochResult.rows[0];
    if (!head || !epoch || !head.payload.members.some((member) => member.identityId === req.identity!.identityId) || normalized.some((envelope) => (
      envelope.publisherIdentityId !== req.identity!.identityId
      || envelope.epoch !== Number(epoch.epoch)
      || envelope.keyCommitment !== epoch.key_commitment
      || envelope.membershipStateId !== head.payload.stateId
      || !head.payload.members.some((member) => member.identityId === envelope.recipientIdentityId)
    ))) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Untrusted Circle profile key envelopes' } } as ApiResponse);
    }
    await transaction(async (client) => {
      for (const envelope of normalized) {
        await client.query(
          `INSERT INTO circle_profile_epoch_envelopes (
             family_id, epoch, recipient_identity_id, publisher_identity_id,
             membership_state_id, key_commitment, envelope_ciphertext
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (family_id, epoch, recipient_identity_id) DO NOTHING`,
          [req.familyId, envelope.epoch, envelope.recipientIdentityId, envelope.publisherIdentityId, envelope.membershipStateId, envelope.keyCommitment, envelope.envelopeCiphertext]
        );
      }
    });
    await notifyCircleDirectoryChanged(req.familyId, 'profile_epoch');
    return res.json({ status: 'ok', result: { published: normalized.length } } as ApiResponse);
  } catch (error) {
    routeLogger.warn('Circle profile key envelope publish rejected:', error);
    return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Unable to publish Circle profile key envelopes' } } as ApiResponse);
  }
});

router.post('/profiles/publish', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId || !req.identity?.identityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle identity is required' } } as ApiResponse);
    }
    const payload = getSignedPayload<{
      profile?: Partial<CircleEncryptedIdentityProfile>;
      avatarMutation?: unknown;
      stagedAvatarBlobId?: unknown;
    }>(req);
    const profile = payload.profile;
    const ownerIdentityId = typeof profile?.ownerIdentityId === 'string' ? profile.ownerIdentityId.trim() : '';
    const epoch = Number(profile?.epoch);
    const revision = Number(profile?.revision);
    const sourceRevision = profile?.sourceRevision === null ? null : Number(profile?.sourceRevision);
    const publicationId = typeof profile?.publicationId === 'string' ? profile.publicationId.trim() : '';
    const publicationKind = profile?.publicationKind === 'manual' || profile?.publicationKind === 'republish'
      ? profile.publicationKind
      : null;
    const ciphertext = typeof profile?.ciphertext === 'string' ? profile.ciphertext.trim() : '';
    const avatarMutation = payload.avatarMutation === 'set' || payload.avatarMutation === 'clear' || payload.avatarMutation === 'keep'
      ? payload.avatarMutation
      : 'keep';
    const stagedAvatarBlobId = typeof payload.stagedAvatarBlobId === 'string' ? payload.stagedAvatarBlobId.trim() : null;
    if (ownerIdentityId !== req.identity.identityId || !Number.isSafeInteger(epoch) || epoch < 1
      || !Number.isSafeInteger(revision) || revision < 1
      || (sourceRevision !== null && (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1))
      || publicationId.length < 16 || publicationId.length > 160 || !publicationKind
      || !ciphertext || ciphertext.length > 131072
      || (avatarMutation === 'set' && !stagedAvatarBlobId)
      || (avatarMutation !== 'set' && stagedAvatarBlobId)
      || (stagedAvatarBlobId && stagedAvatarBlobId !== circleProfileAvatarBlobId(ownerIdentityId, publicationId))) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Invalid encrypted Circle profile' } } as ApiResponse);
    }
    const result = await transaction(async (client) => {
      await client.query(`SELECT family_id FROM family_config WHERE family_id = $1 FOR UPDATE`, [req.familyId]);
      const lockedEpoch = await client.query<{ epoch: number }>(
        `SELECT epoch FROM circle_profile_epochs WHERE family_id = $1 ORDER BY epoch DESC LIMIT 1`,
        [req.familyId]
      );
      if (Number(lockedEpoch.rows[0]?.epoch) !== epoch) {
        if (stagedAvatarBlobId) {
          await client.query(
            `UPDATE attachment_blobs
                SET status = CASE WHEN status IN ('deleted', 'expired') THEN status ELSE 'pending_delete' END,
                    delete_reason = COALESCE(delete_reason, 'failed_commit'), updated_at = NOW()
              WHERE family_id = $1 AND blob_id = $2 AND uploader_identity_id = $3`,
            [req.familyId, stagedAvatarBlobId, ownerIdentityId]
          );
        }
        return { conflict: true as const };
      }
      if (stagedAvatarBlobId) {
        const staged = await client.query<{ blob_id: string }>(
          `SELECT blob_id FROM attachment_blobs
            WHERE family_id = $1 AND blob_id = $2 AND uploader_identity_id = $3 AND status = 'committed'
            FOR UPDATE`,
          [req.familyId, stagedAvatarBlobId, ownerIdentityId]
        );
        if (!staged.rows[0]) throw new Error('Staged encrypted avatar is unavailable');
      }
      const currentResult = await client.query<EncryptedProfileRow>(
        `SELECT owner_identity_id, epoch, revision, source_revision, publication_id,
                publication_kind, ciphertext, updated_at
           FROM circle_encrypted_identity_profiles
          WHERE family_id = $1 AND owner_identity_id = $2
          FOR UPDATE`,
        [req.familyId, ownerIdentityId]
      );
      const current = currentResult.rows[0] || null;
      const decision = decideCircleProfilePublication(current ? {
        revision: Number(current.revision),
        sourceRevision: current.source_revision === null ? null : Number(current.source_revision),
        publicationId: current.publication_id,
        publicationKind: current.publication_kind,
      } : null, { revision, sourceRevision, publicationId, publicationKind });
      if (decision === 'idempotent') {
        return { conflict: false as const, applied: false, profile: mapEncryptedProfile(current) };
      }
      if (decision === 'reject' && current) {
        if (stagedAvatarBlobId) {
          await client.query(
            `UPDATE attachment_blobs
                SET status = CASE WHEN status IN ('deleted', 'expired') THEN status ELSE 'pending_delete' END,
                    delete_reason = COALESCE(delete_reason, 'failed_commit'), updated_at = NOW()
              WHERE family_id = $1 AND blob_id = $2 AND uploader_identity_id = $3`,
            [req.familyId, stagedAvatarBlobId, ownerIdentityId]
          );
        }
        return { conflict: false as const, applied: false, profile: mapEncryptedProfile(current) };
      }
      if (decision === 'reject') throw new Error('Circle profile compare-and-swap conflict');
      const saved = await client.query<EncryptedProfileRow>(
        `INSERT INTO circle_encrypted_identity_profiles (
           family_id, owner_identity_id, epoch, revision, source_revision,
           publication_id, publication_kind, ciphertext
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (family_id, owner_identity_id)
         DO UPDATE SET epoch = EXCLUDED.epoch, revision = EXCLUDED.revision,
           source_revision = EXCLUDED.source_revision, publication_id = EXCLUDED.publication_id,
           publication_kind = EXCLUDED.publication_kind, ciphertext = EXCLUDED.ciphertext, updated_at = NOW()
         RETURNING owner_identity_id, epoch, revision, source_revision, publication_id,
                   publication_kind, ciphertext, updated_at`,
        [req.familyId, ownerIdentityId, epoch, revision, sourceRevision, publicationId, publicationKind, ciphertext]
      );
      if (avatarMutation === 'set') {
        await client.query(
          `UPDATE attachment_blobs SET expires_at = '9999-12-31'::timestamp, updated_at = NOW()
            WHERE family_id = $1 AND blob_id = $2 AND uploader_identity_id = $3 AND status = 'committed'`,
          [req.familyId, stagedAvatarBlobId, ownerIdentityId]
        );
        await client.query(
          `WITH previous AS (
             SELECT avatar_blob_id
               FROM identities
              WHERE family_id = $2 AND identity_id = $3
              FOR UPDATE
           ), updated_identity AS (
             UPDATE identities
                SET avatar_blob_id = $1, avatar_updated_at = NOW()
              WHERE family_id = $2 AND identity_id = $3
              RETURNING identity_id
           )
           UPDATE attachment_blobs
              SET status = CASE WHEN status IN ('deleted', 'expired') THEN status ELSE 'pending_delete' END,
                  delete_reason = COALESCE(delete_reason, 'user_request'), updated_at = NOW()
            WHERE family_id = $2
              AND blob_id = (SELECT avatar_blob_id FROM previous)
              AND blob_id <> $1`,
          [stagedAvatarBlobId, req.familyId, ownerIdentityId]
        );
      } else if (avatarMutation === 'clear') {
        await client.query(
          `WITH previous AS (
             SELECT avatar_blob_id
               FROM identities
              WHERE family_id = $1 AND identity_id = $2
              FOR UPDATE
           ), updated_identity AS (
             UPDATE identities
                SET avatar_blob_id = NULL, avatar_updated_at = NOW()
              WHERE family_id = $1 AND identity_id = $2
              RETURNING identity_id
           )
           UPDATE attachment_blobs
              SET status = CASE WHEN status IN ('deleted', 'expired') THEN status ELSE 'pending_delete' END,
                  delete_reason = COALESCE(delete_reason, 'user_request'), updated_at = NOW()
            WHERE family_id = $1
              AND blob_id = (SELECT avatar_blob_id FROM previous)`,
          [req.familyId, ownerIdentityId]
        );
      }
      return { conflict: false as const, applied: true, profile: mapEncryptedProfile(saved.rows[0]!) };
    });
    if (result.conflict) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Circle profile epoch changed' } } as ApiResponse);
    }
    if (result.applied) await notifyCircleDirectoryChanged(req.familyId, 'profile');
    return res.json({
      status: 'ok',
      result: { applied: result.applied, profile: result.profile },
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Encrypted Circle profile publish error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Unable to publish encrypted Circle profile' } } as ApiResponse);
  }
});

router.post('/state/append', verifySignature, requireActiveIdentity, async (req: AuthRequest & TenancyRequest, res) => {
  try {
    if (!req.familyId || !req.identity?.identityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle identity is required' } } as ApiResponse);
    }
    const record = getSignedPayload<{ state?: CircleMembershipStateRecord }>(req).state;
    if (req.circleSuspended && (
      record?.claim?.payload?.action !== 'remove'
      || record.claim.signerId !== req.identity.identityId
      || record.claim.payload.subjectIdentityId !== req.identity.identityId
    )) {
      return res.status(423).json({ status: 'error', error: { code: 'CIRCLE_SUSPENDED', message: 'Only leaving your own Circle membership is allowed during suspension' } } as ApiResponse);
    }
    if (
      !record
      || record.claim.signerId !== req.identity.identityId
      || record.claim.payload.action === 'add'
      || !(
        record.claim.payload.action === 'genesis'
        || record.claim.payload.action === 'repair'
        || (record.claim.payload.action === 'remove'
          && record.claim.signerId === record.claim.payload.subjectIdentityId)
      )
      || record.claim.payload.vpsId !== getServerIdentityRuntimeConfig().vpsId
      || record.claim.payload.circleId !== req.circleId
    ) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Use the matching atomic operation for administrative membership changes' } } as ApiResponse);
    }
    await transaction(async (client) => {
      await appendCircleMembershipState({ familyId: req.familyId!, record, client });
    });
    await notifyCircleDirectoryChanged(req.familyId, 'membership');
    return res.json({ status: 'ok', result: { stateId: record.claim.payload.stateId, sequence: record.claim.payload.sequence } } as ApiResponse);
  } catch (error) {
    routeLogger.warn('Circle membership state append rejected:', error);
    return res.status(409).json({
      status: 'error',
      error: { code: 'INVALID_STATE' as ErrorCode, message: error instanceof Error ? error.message : 'Invalid Circle membership state' }
    } as ApiResponse);
  }
});

export default router;
