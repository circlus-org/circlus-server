import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { query, transaction, inTransactionContext } from '../db';
import { inviteRepository, identityRepository, systemEventRepository } from '../db/repositories';
import { sendToIdentityWs } from '../ws/wsGateway';
import type { FindByTokenResult } from '../db/repositories/inviteRepository.queries';
import { verifySignature, requireActiveIdentity, requireAdmin, getRequestAuthorization, getSignedPayload } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import type {
  LinkCapabilityDescriptor,
  LinkCapabilityMode,
  LinkCapabilityRevocation
} from '../../../shared/linkCapability';
import { verifyCapabilityDescriptor, verifyCapabilityRevocation } from '../services/linkCapabilityService';

const router = Router();

function canCreateInvites(identity?: AuthRequest['identity']): boolean {
  return getRequestAuthorization({ identity } as AuthRequest).createCircleInvites;
}

type CreateInvitePayload = {
  mode?: LinkCapabilityMode;
  expiresAt?: unknown;
  capabilityDescriptor?: LinkCapabilityDescriptor;
  encryptedSecret?: unknown;
  encryptedMembershipCheckpointBundle?: unknown;
  guestDelivery?: { registrationId: string; guestIdentityId: string; encryptedSecret: string };
};

type InviteAcceptanceRow = {
  invite_id: string;
  accepted_by_identity_id: string;
  accepted_by_public_key: string | null;
  accepted_at: Date;
  admission_claim: unknown | null;
};

function isEncryptedBlob(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const blob = value as Record<string, unknown>;
  return blob.cipher === 'aes-256-gcm'
    && typeof blob.data === 'string'
    && typeof blob.nonce === 'string'
    && blob.version === 1;
}

function serializeInvite(invite: FindByTokenResult, acceptances: InviteAcceptanceRow[] = []) {
  return {
    inviteId: invite.invite_id,
    token: invite.token,
    createdBy: invite.created_by,
    createdAt: invite.created_at.toISOString(),
    expiresAt: invite.expires_at.toISOString(),
    maxUses: invite.max_uses,
    usedCount: invite.used_count,
    status: invite.status,
    reusable: invite.max_uses > 1,
    capabilityId: (invite as FindByTokenResult & { capability_id?: string | null }).capability_id ?? null,
    capabilityMode: (invite as FindByTokenResult & { capability_mode?: LinkCapabilityMode | null }).capability_mode ?? null,
    capabilityDescriptor: (invite as FindByTokenResult & { capability_descriptor?: LinkCapabilityDescriptor | null }).capability_descriptor ?? null,
    encryptedSecret: (invite as FindByTokenResult & { encrypted_secret?: unknown | null }).encrypted_secret ?? null,
    encryptedMembershipCheckpointBundle: (invite as FindByTokenResult & { encrypted_membership_checkpoint_bundle?: unknown | null }).encrypted_membership_checkpoint_bundle ?? null,
    acceptances: acceptances.map((acceptance) => ({
      identityId: acceptance.accepted_by_identity_id,
      identityName: null,
      identityPublicKey: acceptance.accepted_by_public_key,
      acceptedAt: acceptance.accepted_at.toISOString(),
      admissionClaim: acceptance.admission_claim
    }))
  };
}

async function findInviteAcceptances(familyId: string, inviteIds: string[]): Promise<Map<string, InviteAcceptanceRow[]>> {
  const map = new Map<string, InviteAcceptanceRow[]>();
  if (inviteIds.length === 0) return map;

  const result = await query<InviteAcceptanceRow>(
    `SELECT invite_id,
            accepted_by_identity_id,
            accepted_by_public_key,
            accepted_at,
            admission_claim
     FROM invite_acceptances
     WHERE family_id = $1
       AND invite_id = ANY($2::text[])
     ORDER BY accepted_at DESC`,
    [familyId, inviteIds]
  );

  for (const row of result.rows) {
    const rows = map.get(row.invite_id) || [];
    rows.push(row);
    map.set(row.invite_id, rows);
  }

  return map;
}

/**
 * Get invite quota status for current identity
 */
router.post('/status', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identity = req.identity;

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        canCreate: canCreateInvites(identity),
        unlimited: canCreateInvites(identity),
        remaining: canCreateInvites(identity) ? null : 0
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Invite status error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
});

/**
 * Create a new invite token
 * Owners and explicitly authorized members may create both invitation modes.
 */
router.post('/create', verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const identityId = req.device!.identityId;
    const familyId = req.familyId;
    const requestIdentity = req.identity;
    const payload = getSignedPayload<CreateInvitePayload>(req);
    const mode: LinkCapabilityMode = payload.mode === 'unlimited' ? 'unlimited' : 'single-use';

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    if (!canCreateInvites(requestIdentity)) {
      return res.status(403).json({
        status: 'error',
        error: {
          code: 'FORBIDDEN' as ErrorCode,
          message: 'Invitation creation permission required'
        }
      } as ApiResponse);
    }

    const inviteId = `invite-${nanoid(12)}`;

    const expiresAt = new Date(String(payload.expiresAt || ''));
    const maxExpiry = Date.now() + 365 * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > maxExpiry) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'expiresAt must be within the next 365 days' }
      } as ApiResponse);
    }

    if (!payload.capabilityDescriptor || !isEncryptedBlob(payload.encryptedSecret)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Signed capability descriptor and encrypted secret are required' }
      } as ApiResponse);
    }
    const issuer = await identityRepository.findByIdentityId(familyId, identityId);
    if (!issuer || !(await verifyCapabilityDescriptor({
      descriptor: payload.capabilityDescriptor,
      issuerPublicKey: { algorithm: issuer.public_key_algorithm as 'ed25519', value: issuer.public_key_value },
      expectedKind: 'circle-invite',
      expectedIssuerIdentityId: identityId,
      expectedTargetIdentityId: identityId
    }))) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid capability descriptor' }
      } as ApiResponse);
    }
    const descriptorPayload = payload.capabilityDescriptor.payload;
    const descriptorScope = descriptorPayload.scope;
    if (
      descriptorPayload.mode !== mode
      || descriptorPayload.expiresAt !== expiresAt.toISOString()
      || !descriptorScope
      || typeof descriptorScope !== 'object'
      || Array.isArray(descriptorScope)
      || Object.prototype.hasOwnProperty.call(descriptorScope, 'title')
    ) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Capability descriptor does not match invite settings' }
      } as ApiResponse);
    }
    if (!Object.prototype.hasOwnProperty.call(descriptorScope, 'membershipCheckpoint')) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invite membership checkpoint is required' }
      } as ApiResponse);
    }
    if (!isEncryptedBlob(payload.encryptedMembershipCheckpointBundle)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invite membership checkpoint bundle is required' }
      } as ApiResponse);
    }

    const guestDelivery = payload.guestDelivery;
    let guestPublicKey: { public_key_algorithm: string; public_key_value: string } | null = null;
    if (guestDelivery) {
      if (mode !== 'single-use' || !guestDelivery.registrationId || !guestDelivery.guestIdentityId
        || typeof guestDelivery.encryptedSecret !== 'string'
        || !guestDelivery.encryptedSecret.startsWith('v3:')
        || guestDelivery.encryptedSecret.length > 8192
        || descriptorScope.guestRegistrationId !== guestDelivery.registrationId
        || descriptorScope.guestIdentityId !== guestDelivery.guestIdentityId) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid directed guest invitation' } } as ApiResponse);
      }
      const registration = await query<{ public_key_algorithm: string; public_key_value: string }>(
        `SELECT i.public_key_algorithm, i.public_key_value
         FROM direct_guest_registrations r JOIN identities i
           ON i.family_id = r.family_id AND i.identity_id = r.guest_identity_id
         WHERE r.family_id = $1 AND r.registration_id = $2
           AND r.host_identity_id = $3 AND r.guest_identity_id = $4
           AND r.status = 'active' AND i.status = 'active' AND i.role = 'guest'`,
        [familyId, guestDelivery.registrationId, identityId, guestDelivery.guestIdentityId]
      );
      guestPublicKey = registration.rows[0] || null;
      if (!guestPublicKey || descriptorScope.guestPublicKey !== guestPublicKey.public_key_value) {
        return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Guest registration is no longer active' } } as ApiResponse);
      }
    } else if (descriptorScope.guestRegistrationId || descriptorScope.guestIdentityId || descriptorScope.guestPublicKey) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Directed guest invitation requires delivery' } } as ApiResponse);
    }

    const createInvite = () => inviteRepository.create({
      familyId,
      inviteId,
      token: descriptorPayload.capabilityId,
      createdBy: identityId,
      expiresAt,
      maxUses: mode === 'single-use' ? 1 : 2147483647,
      capabilityId: descriptorPayload.capabilityId,
      capabilityMode: mode,
      capabilityDescriptor: payload.capabilityDescriptor,
      encryptedSecret: payload.encryptedSecret as any,
      encryptedMembershipCheckpointBundle: payload.encryptedMembershipCheckpointBundle as any
    });
    let event: import('../../../shared/types').SystemEventRecord<'invite:guest-membership'> | null = null;
    const invite = guestDelivery
      ? await transaction((client) => inTransactionContext(client, async () => {
          const created = await createInvite();
          const config = await query<{ circle_id: string }>('SELECT circle_id FROM family_config WHERE family_id = $1', [familyId]);
          event = {
            eventId: systemEventRepository.createEventId(),
            circleId: config.rows[0].circle_id,
            recipientIdentityId: guestDelivery.guestIdentityId,
            type: 'invite:guest-membership',
            payload: { inviteId, hostIdentityId: identityId, guestIdentityId: guestDelivery.guestIdentityId,
              registrationId: guestDelivery.registrationId, encryptedSecret: guestDelivery.encryptedSecret,
              expiresAt: expiresAt.toISOString() },
            serverTimestamp: Date.now()
          };
          await systemEventRepository.insertEvent({ ...event, familyId, createdAt: event.serverTimestamp });
          return created;
        }))
      : await createInvite();
    if (event) {
      try { sendToIdentityWs(familyId, guestDelivery!.guestIdentityId, { type: 'system:event', data: event }); } catch { /* sync will deliver it */ }
    }

    return res.json({
      status: 'ok',
      result: {
        invite: serializeInvite(invite),
        remaining: null,
        unlimited: true
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Create invite error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
}));

/**
 * Get invites created by current identity
 */
router.post('/mine', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const identityId = req.device!.identityId;
    const familyId = req.familyId;

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const invites = await inviteRepository.findByCreator(familyId, identityId);
    const acceptancesByInviteId = await findInviteAcceptances(familyId, invites.map((invite) => invite.invite_id));

    return res.json({
      status: 'ok',
      result: {
        invites: invites.map((invite) => serializeInvite(invite, acceptancesByInviteId.get(invite.invite_id) || []))
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Get own invites error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
});

router.post('/audit', verifySignature, requireActiveIdentity, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    const result = await query<{
      invite_id: string;
      capability_id: string;
      capability_descriptor: LinkCapabilityDescriptor;
      issuer_identity_id: string;
      issuer_public_key_algorithm: 'ed25519';
      issuer_public_key_value: string;
      accepted_identity_id: string;
      accepted_public_key_algorithm: 'ed25519';
      accepted_public_key_value: string;
      admission_claim: unknown;
      accepted_at: Date;
    }>(
      `SELECT invite.invite_id, invite.capability_id, invite.capability_descriptor,
              issuer.identity_id AS issuer_identity_id,
              issuer.public_key_algorithm AS issuer_public_key_algorithm,
              issuer.public_key_value AS issuer_public_key_value,
              acceptance.accepted_by_identity_id AS accepted_identity_id,
              accepted.public_key_algorithm AS accepted_public_key_algorithm,
              accepted.public_key_value AS accepted_public_key_value,
              acceptance.admission_claim,
              acceptance.accepted_at
         FROM invites invite
         JOIN identities issuer
           ON issuer.family_id = invite.family_id AND issuer.identity_id = invite.created_by
         JOIN invite_acceptances acceptance
           ON acceptance.family_id = invite.family_id AND acceptance.invite_id = invite.invite_id
         JOIN identities accepted
           ON accepted.family_id = acceptance.family_id
          AND accepted.identity_id = acceptance.accepted_by_identity_id
        WHERE invite.family_id = $1
          AND invite.capability_mode = 'single-use'
          AND invite.capability_descriptor IS NOT NULL
          AND acceptance.admission_claim IS NOT NULL
        ORDER BY invite.created_at DESC, acceptance.accepted_at ASC`,
      [familyId]
    );
    return res.json({
      status: 'ok',
      result: result.rows.map((row) => ({
        inviteId: row.invite_id,
        capabilityId: row.capability_id,
        descriptor: row.capability_descriptor,
        issuerIdentityId: row.issuer_identity_id,
        issuerPublicKey: { algorithm: row.issuer_public_key_algorithm, value: row.issuer_public_key_value },
        acceptedIdentityId: row.accepted_identity_id,
        acceptedIdentityName: null,
        acceptedPublicKey: { algorithm: row.accepted_public_key_algorithm, value: row.accepted_public_key_value },
        admissionClaim: row.admission_claim,
        acceptedAt: row.accepted_at.toISOString()
      }))
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Invite audit error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

/**
 * Revoke an owned active invite while retaining its audit history.
 */
router.post('/:inviteId/revoke', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const identityId = req.device!.identityId;
    const familyId = req.familyId;
    const { inviteId } = req.params;
    const payload = getSignedPayload<{ revocation: LinkCapabilityRevocation }>(req);

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const existing = await inviteRepository.findById(familyId, inviteId);
    const issuer = await identityRepository.findByIdentityId(familyId, identityId);
    const capabilityId = (existing as FindByTokenResult & { capability_id?: string | null } | null)?.capability_id;
    if (!existing || !capabilityId || !issuer || !payload.revocation || !verifyCapabilityRevocation({
      revocation: payload.revocation,
      issuerPublicKey: { algorithm: issuer.public_key_algorithm as 'ed25519', value: issuer.public_key_value },
      capabilityId,
      issuerIdentityId: identityId
    })) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Valid identity-signed revocation is required' }
      } as ApiResponse);
    }

    const result = await inviteRepository.revokeOwnedInvite({
      inviteId,
      familyId,
      identityId,
      unlimited: true,
      revocation: payload.revocation
    });

    if (!result.ok) {
      return res.status(result.status).json({
        status: 'error',
        error: {
          code: result.code,
          message: result.message
        }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        invite: result.invite ? serializeInvite(result.invite) : null,
        remaining: result.remaining,
        deleted: result.deleted
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Revoke own invite error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
});

export default router;
