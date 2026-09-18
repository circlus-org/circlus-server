import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  identityRepository,
  inviteRepository,
  familyConfigRepository,
  systemEventRepository
} from '../db/repositories';
import { isInviteCreatorActive, isInviteValid } from '../services/inviteService';
import { configService } from '../services/configService';
import { getRequestHost, type TenancyRequest } from '../middleware/tenancy';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { hashClaimToken } from '../utils/claimTokens';
import { deriveIdentityIdFromPublicKey } from '../../../shared/identityId';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';
import {
  MemberIdentityRegistrationError,
  registerMemberIdentity
} from '../services/memberIdentityRegistrationService';
import { registerOwnerIdentity } from '../services/ownerIdentityRegistrationService';
import { sendApiError } from '../utils/apiResponses';
import type { FindByTokenResult } from '../db/repositories/inviteRepository.queries';
import type {
  RegisterIdentityPayload,
  RegisterOwnerIdentityPayload,
  ApiResponse,
  ErrorCode,
  IdentityId,
  IdentityRecord,
  PublicKey
} from '../../../shared/types';
import type { LinkCapabilityDescriptor, LinkCapabilityProof } from '../../../shared/linkCapability';
import { verifyCapabilityProof } from '../services/linkCapabilityService';
import { listCircleIdentityAdmissionProofs } from '../services/circleMembershipProofService';
import { listCircleMembershipStates } from '../services/circleMembershipStateService';
import { sendToIdentityWs } from '../ws/wsGateway';
import { notifyCircleDirectoryChanged } from '../services/circleDirectoryNotificationService';

const router = Router();
const authRateLimits = getRateLimitRuntimeConfig().auth;

async function insertAndPushInviteAcceptedEvent(params: {
  familyId: string;
  recipientIdentityId: IdentityId;
  circleId: string;
  inviteId: string;
  acceptedIdentityId: IdentityId;
  acceptedIdentityPublicKey: PublicKey;
  acceptedIdentityName?: string;
}): Promise<void> {
  const eventId = systemEventRepository.createEventId();
  const createdAt = Date.now();
  const payload = {
    inviteId: params.inviteId,
    acceptedIdentityId: params.acceptedIdentityId,
    acceptedIdentityPublicKey: params.acceptedIdentityPublicKey,
    acceptedIdentityName: params.acceptedIdentityName
  };
  await systemEventRepository.insertEvent({
    eventId,
    familyId: params.familyId,
    recipientIdentityId: params.recipientIdentityId,
    circleId: params.circleId,
    type: 'invite:accepted',
    payload,
    createdAt
  });
  try {
    sendToIdentityWs(params.familyId, params.recipientIdentityId, {
      type: 'system:sync-result',
      data: {
        events: [{
          eventId,
          recipientIdentityId: params.recipientIdentityId,
          circleId: params.circleId,
          type: 'invite:accepted',
          payload,
          serverTimestamp: createdAt
        }],
        syncedThrough: createdAt
      },
      timestamp: Date.now()
    });
  } catch (error) {
    routeLogger.warn('Invite accepted realtime push failed:', error);
  }
}

const rlCheckInvite = createRateLimiter({
  name: 'auth:check-invite',
  windowMs: authRateLimits.windowMs,
  max: authRateLimits.checkInviteMax,
  keyFn: ipFamilyKey
});
const rlRegister = createRateLimiter({
  name: 'auth:register',
  windowMs: authRateLimits.windowMs,
  max: authRateLimits.registerMax,
  keyFn: ipFamilyKey
});
router.post('/check-invite', rlCheckInvite, async (req, res) => {
  try {
    const { familyId } = req as TenancyRequest;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const capabilityId = String(req.body?.capabilityId || '').trim();
    const capabilityProof = req.body?.proof as LinkCapabilityProof | undefined;
    const token = capabilityId || String(req.body?.token || '').trim();

    if (!token) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVITE_INVALID' as ErrorCode,
          message: 'Invite token is required'
        }
      } as ApiResponse);
    }

    const invite = await inviteRepository.findByToken(familyId, token);

    if (!invite) {
      const inviteForAnotherFamily = await inviteRepository.findByTokenAnyFamily(token);
      if (inviteForAnotherFamily && inviteForAnotherFamily.family_id !== familyId) {
        const expectedConfig = await configService.getResolvedFamilyConfig(inviteForAnotherFamily.family_id);
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'INVITE_DOMAIN_MISMATCH' as ErrorCode,
            message: 'Invite belongs to another circle domain',
            details: {
              requestHost: getRequestHost(req),
              expectedPublicBaseUrl: expectedConfig.config?.public_base_url || null
            }
          }
        } as ApiResponse);
      }
      return res.status(404).json({
        status: 'error',
        error: {
          code: 'INVITE_INVALID' as ErrorCode,
          message: 'Invite not found'
        }
      } as ApiResponse);
    }

    if (!isInviteValid(invite) || !(await isInviteCreatorActive(invite))) {
      const code: ErrorCode = invite.status === 'expired'
        ? 'INVITE_EXPIRED'
        : invite.status === 'exhausted'
          ? 'INVITE_EXHAUSTED'
          : 'INVITE_INVALID';

      return res.status(400).json({
        status: 'error',
        error: {
          code,
          message: `Invite is ${invite.status}`
        }
      } as ApiResponse);
    }

    const descriptor = (invite as FindByTokenResult & { capability_descriptor?: LinkCapabilityDescriptor | null }).capability_descriptor;
    if (!descriptor && invite.created_by !== 'system') {
      return res.status(404).json({
        status: 'error',
        error: { code: 'INVITE_INVALID' as ErrorCode, message: 'Invite capability is required' }
      } as ApiResponse);
    }
    if (descriptor) {
      if (!descriptor || !capabilityProof || !verifyCapabilityProof({
        proof: capabilityProof,
        descriptor,
        expectedAction: 'resolve'
      })) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'INVITE_INVALID' as ErrorCode, message: 'Invite proof is invalid' }
        } as ApiResponse);
      }
    }

    const [familyConfig, membershipStates, membershipProofs] = await Promise.all([
      configService.getResolvedFamilyConfig(familyId),
      listCircleMembershipStates(familyId),
      listCircleIdentityAdmissionProofs(familyId),
    ]);
    const issuer = descriptor && invite.created_by !== 'system'
      ? await identityRepository.findByIdentityId(familyId, invite.created_by)
      : null;

    return res.json({
      status: 'ok',
      result: {
        valid: true,
        serverName: familyConfig.serverName,
        noNamesOnServer: familyConfig.noNamesOnServer,
        expiresAt: invite.expires_at,
        mode: (invite as FindByTokenResult & { capability_mode?: string | null }).capability_mode ?? undefined,
        descriptor: descriptor ?? undefined,
        issuerPublicKey: issuer
          ? { algorithm: issuer.public_key_algorithm as 'ed25519', value: issuer.public_key_value }
          : undefined,
        issuerIdentityName: undefined,
        encryptedMembershipCheckpointBundle: (invite as FindByTokenResult & { encrypted_membership_checkpoint_bundle?: unknown | null }).encrypted_membership_checkpoint_bundle ?? undefined,
        membershipStates,
        membershipProofs,
      }
    } as ApiResponse);

  } catch (error) {
    routeLogger.error('Check invite error:', error);
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
 * Register the initial owner identity and redeem the owner claim atomically.
 * Device registration remains a separate identity-signed operation.
 */
router.post('/register-owner', rlRegister, async (req, res) => {
  try {
    const { familyId } = req as TenancyRequest;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const payload: RegisterOwnerIdentityPayload = req.body;
    if (!payload.inviteToken || !payload.ownerClaimToken || !payload.identityPublicKey) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Missing required fields' }
      } as ApiResponse);
    }

    const identityId = await deriveIdentityIdFromPublicKey(payload.identityPublicKey);
    const tokenHash = hashClaimToken(payload.ownerClaimToken.trim());
    const outcome = await registerOwnerIdentity({
      familyId,
      identityId,
      tokenHash,
      payload
    });

    if (!outcome.ok) {
      return res.status(outcome.status).json({
        status: 'error',
        error: { code: outcome.code, message: outcome.message }
      } as ApiResponse);
    }

    if (outcome.inviteCreator && outcome.inviteCreator !== 'system') {
      try {
        await insertAndPushInviteAcceptedEvent({
          familyId,
          recipientIdentityId: outcome.inviteCreator,
          circleId: (await configService.requireFamilyConfig(familyId)).circle_id,
          inviteId: outcome.inviteId,
          acceptedIdentityId: outcome.identity.identity_id as IdentityId,
          acceptedIdentityPublicKey: payload.identityPublicKey,
          acceptedIdentityName: undefined
        });
      } catch (error) {
        routeLogger.error('Owner invite accepted event error:', error);
      }
    }

    const identity: IdentityRecord = {
      identityId: outcome.identity.identity_id,
      publicKey: {
        algorithm: outcome.identity.public_key_algorithm as 'ed25519' | 'x25519',
        value: outcome.identity.public_key_value
      },
      encryptedPrivateKey: outcome.identity.encrypted_private_key as any,
      createdAt: outcome.identity.created_at.toISOString(),
      status: outcome.identity.status as 'active' | 'disabled',
      role: 'owner'
    };
    return res.json({
      status: 'ok',
      result: {
        identity,
        serverAdmin: outcome.serverAdmin
          ? {
              serverAdminId: outcome.serverAdmin.server_admin_id,
              identityId: outcome.serverAdmin.principal_identity_id,
              grantedAt: outcome.serverAdmin.granted_at.toISOString()
            }
          : null
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Register owner identity error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

/**
 * Register new identity (public endpoint)
 */
router.post('/register', rlRegister, async (req, res) => {
  try {
    const { familyId } = req as TenancyRequest;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const payload: RegisterIdentityPayload = req.body;

    if (!payload.inviteToken || !payload.identityPublicKey) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Missing required fields'
        }
      } as ApiResponse);
    }

    const identityId = await deriveIdentityIdFromPublicKey(payload.identityPublicKey);

    const existingByPublicKey = await identityRepository.findByPublicKey(familyId, payload.identityPublicKey.value);
    const canPromoteExistingGuest = (row: typeof existingByPublicKey) => row?.identity_id === identityId
      && row.status === 'active' && row.role === 'guest'
      && row.public_key_algorithm === payload.identityPublicKey.algorithm
      && row.public_key_value === payload.identityPublicKey.value;
    if (existingByPublicKey && !canPromoteExistingGuest(existingByPublicKey)) {
      return res.status(409).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Identity already exists'
        },
        result: {
          identityId,
        }
      } as ApiResponse);
    }

    const existingById = await identityRepository.findByIdentityId(familyId, identityId);
    if (existingById && !canPromoteExistingGuest(existingById)) {
      return res.status(409).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Derived identityId already exists'
        },
        result: {
          identityId,
        }
      } as ApiResponse);
    }

    // Check invite
    const invite = await inviteRepository.findByToken(familyId, payload.inviteToken);

    if (!invite || !isInviteValid(invite) || !(await isInviteCreatorActive(invite))) {
      if (!invite) {
        const inviteForAnotherFamily = await inviteRepository.findByTokenAnyFamily(payload.inviteToken);
        if (inviteForAnotherFamily && inviteForAnotherFamily.family_id !== familyId) {
          const expectedConfig = await configService.getResolvedFamilyConfig(inviteForAnotherFamily.family_id);
          return res.status(409).json({
            status: 'error',
            error: {
              code: 'INVITE_DOMAIN_MISMATCH' as ErrorCode,
              message: 'Invite belongs to another circle domain',
              details: {
                requestHost: getRequestHost(req),
                expectedPublicBaseUrl: expectedConfig.config?.public_base_url || null
              }
            }
          } as ApiResponse);
        }
      }
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVITE_INVALID' as ErrorCode,
          message: 'Invalid invite'
        }
      } as ApiResponse);
    }

    const storedFamilyConfig = await familyConfigRepository.findByFamilyId(familyId);
    if (storedFamilyConfig?.status === 'pending_owner' && storedFamilyConfig.join_invite_id === invite.invite_id) {
      return res.status(409).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Owner invite must be accepted through owner registration'
        }
      } as ApiResponse);
    }

    if (!(invite as FindByTokenResult & { capability_descriptor?: LinkCapabilityDescriptor | null }).capability_descriptor) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVITE_INVALID' as ErrorCode, message: 'Invite capability is required' }
      } as ApiResponse);
    }

    const { identity, inviteCreator, inviteId } = await registerMemberIdentity({
      familyId,
      identityId,
      payload,
      noNamesOnServer: true
    });
    void notifyCircleDirectoryChanged(familyId, 'membership');

    // Notify invite creator that this invite has been accepted.
    if (inviteCreator && inviteCreator !== 'system') {
      const familyConfig = await configService.requireFamilyConfig(familyId);
      const circleId = familyConfig.circle_id;
      await insertAndPushInviteAcceptedEvent({
        familyId,
        recipientIdentityId: inviteCreator,
        circleId,
        inviteId,
        acceptedIdentityId: identity.identity_id as IdentityId,
        acceptedIdentityPublicKey: {
          algorithm: identity.public_key_algorithm as 'ed25519' | 'x25519',
          value: identity.public_key_value
        },
        acceptedIdentityName: undefined
      });
    }

    const result: IdentityRecord = {
      identityId: identity.identity_id,
      publicKey: {
        algorithm: identity.public_key_algorithm as 'ed25519' | 'x25519',
        value: identity.public_key_value
      },
      encryptedPrivateKey: identity.encrypted_private_key as any,
      createdAt: identity.created_at.toISOString(),
      status: identity.status as 'active' | 'disabled',
      role: (identity.role as 'owner' | 'member' | 'guest' | null) || undefined
    };

    return res.json({
      status: 'ok',
      result: {
        identity: result
      }
    } as ApiResponse);

  } catch (error) {
    if (error instanceof MemberIdentityRegistrationError) {
      return sendApiError(res, error.status, error.code, error.message, error.details);
    }
    routeLogger.error('Register identity error:', error);
    return sendApiError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

/**
 * Register device (signed by identity key)
 * This is called right after registration or when adding new device
 */

export default router;
