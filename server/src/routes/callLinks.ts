import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { callLinkRepository, identityRepository } from '../db/repositories';
import { configService } from '../services/configService';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity, getRequestAuthorization, getSignedPayload } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import { getFeaturePolicyRuntimeConfig } from '../config/serverRuntimeConfig';
import type {
  LinkCapabilityDescriptor,
  LinkCapabilityMode,
  LinkCapabilityProof,
  LinkCapabilityRevocation
} from '../../../shared/linkCapability';
import { verifyCapabilityDescriptor, verifyCapabilityProof, verifyCapabilityRevocation } from '../services/linkCapabilityService';
import {
  CALL_LINK_DIRECT_GUEST_PERMISSIONS,
  type CallLinkAttachedInvitationKind
} from '../../../shared/callLinkInvitation';

const router = Router();
const CALL_LINK_TITLE_MAX_LENGTH = 120;
const CALL_LINK_TTL_MIN_HOURS = 1;
const CALL_LINK_TTL_MAX_HOURS = 365 * 24;

function serializeOwnedCallLink(row: Awaited<ReturnType<typeof callLinkRepository.findOwned>>[number]) {
  return {
    callLinkId: row.call_link_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    suggestJoinAfterCall: row.suggest_join_after_call,
    capabilityId: row.capability_id,
    capabilityMode: row.capability_mode,
    capabilityDescriptor: row.capability_descriptor,
    encryptedSecret: row.encrypted_secret,
    joinInvite: row.join_invite_id ? {
      inviteId: row.join_invite_id,
      title: row.join_invite_title,
      status: row.join_invite_status,
      expiresAt: row.join_invite_expires_at?.toISOString() ?? null,
    } : null,
    directGuestInvite: row.direct_guest_link_id ? {
      linkId: row.direct_guest_link_id,
      status: row.direct_guest_link_status
    } : null,
    attachedInvitation: row.join_invite_id
      && row.join_invite_token
      && row.join_invite_status === 'active'
      && !!row.join_invite_expires_at
      && row.join_invite_expires_at.getTime() > Date.now() ? {
      kind: 'circle_membership' as const
    } : row.direct_guest_link_id
      && row.direct_guest_link_status === 'active'
      && row.direct_guest_capability_descriptor ? {
        kind: 'direct_guest' as const,
        linkId: row.direct_guest_link_id,
        capabilityDescriptor: row.direct_guest_capability_descriptor
      } : null,
  };
}


router.post('/create', verifySignature, requireActiveIdentity, requireFullCircleIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const role = req.identity?.role;

    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const payload = getSignedPayload<{
      title?: unknown;
      ttlHours?: unknown;
      expiresAt?: unknown;
      suggestJoinAfterCall?: boolean;
      showCircleName?: boolean;
      mode?: LinkCapabilityMode;
      capabilityDescriptor?: LinkCapabilityDescriptor;
      encryptedSecret?: unknown;
      attachedInvitationKind?: CallLinkAttachedInvitationKind | null;
      directGuestCapabilityDescriptor?: LinkCapabilityDescriptor;
      directGuestPresentationTitle?: unknown;
    }>(req);
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (!title || title.length > CALL_LINK_TITLE_MAX_LENGTH) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: `title is required and must be at most ${CALL_LINK_TITLE_MAX_LENGTH} characters`
        }
      } as ApiResponse);
    }
    const defaultTtlHours = getFeaturePolicyRuntimeConfig().callLinks.ttlHours;
    const ttlHours = payload.ttlHours === undefined ? defaultTtlHours : Number(payload.ttlHours);
    if (!Number.isInteger(ttlHours) || ttlHours < CALL_LINK_TTL_MIN_HOURS || ttlHours > CALL_LINK_TTL_MAX_HOURS) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: `ttlHours must be an integer between ${CALL_LINK_TTL_MIN_HOURS} and ${CALL_LINK_TTL_MAX_HOURS}`
        }
      } as ApiResponse);
    }
    const attachedInvitationKind: CallLinkAttachedInvitationKind | null =
      payload.attachedInvitationKind === 'circle_membership'
      || payload.attachedInvitationKind === 'direct_guest'
        ? payload.attachedInvitationKind
        : payload.suggestJoinAfterCall === true
          ? 'circle_membership'
          : null;
    const suggestJoinAfterCall = attachedInvitationKind === 'circle_membership';
    // Links created by clients predating this option exposed the Circle name.
    const showCircleName = payload.showCircleName !== false;
    const mode: LinkCapabilityMode = payload.mode === 'single-use' ? 'single-use' : 'unlimited';

    const callLinkId = `cl_${nanoid(22)}`;
    const expiresAt = new Date(String(payload.expiresAt || ''));
    const requestedLifetimeMs = expiresAt.getTime() - Date.now();
    if (
      !Number.isFinite(expiresAt.getTime())
      || requestedLifetimeMs < CALL_LINK_TTL_MIN_HOURS * 60 * 60 * 1000 - 60_000
      || requestedLifetimeMs > CALL_LINK_TTL_MAX_HOURS * 60 * 60 * 1000
    ) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'expiresAt is outside the allowed range' }
      } as ApiResponse);
    }
    const encryptedSecret = payload.encryptedSecret;
    const encrypted = encryptedSecret && typeof encryptedSecret === 'object'
      ? encryptedSecret as Record<string, unknown>
      : null;
    const descriptor = payload.capabilityDescriptor;
    const descriptorScopeHasCircleName = Object.prototype.hasOwnProperty.call(
      descriptor?.payload?.scope || {},
      'showCircleName'
    );
    const descriptorScopeHasAttachedInvitation = Object.prototype.hasOwnProperty.call(
      descriptor?.payload?.scope || {},
      'attachedInvitationKind'
    );
    const expectedScope = {
      title,
      suggestJoinAfterCall,
      joinMode: suggestJoinAfterCall ? 'single-use' : null,
      ...(descriptorScopeHasCircleName ? { showCircleName } : {}),
      ...(descriptorScopeHasAttachedInvitation ? { attachedInvitationKind } : {})
    };
    const issuer = await identityRepository.findByIdentityId(familyId, identityId);
    if (
      !descriptor
      || !encrypted
      || encrypted.cipher !== 'aes-256-gcm'
      || encrypted.version !== 1
      || typeof encrypted.data !== 'string'
      || typeof encrypted.nonce !== 'string'
      || !issuer
      || !(await verifyCapabilityDescriptor({
        descriptor,
        issuerPublicKey: { algorithm: issuer.public_key_algorithm as 'ed25519', value: issuer.public_key_value },
        expectedKind: 'call-link',
        expectedIssuerIdentityId: identityId,
        expectedTargetIdentityId: identityId
      }))
      || descriptor.payload.mode !== mode
      || descriptor.payload.expiresAt !== expiresAt.toISOString()
      || (payload.showCircleName !== undefined && !descriptorScopeHasCircleName)
      || JSON.stringify(descriptor.payload.scope) !== JSON.stringify(expectedScope)
    ) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid call-link capability descriptor' }
      } as ApiResponse);
    }

    let directGuestInvitation: {
      linkId: string;
      capabilityDescriptor: LinkCapabilityDescriptor;
      presentationTitle: string | null;
    } | null = null;
    if (attachedInvitationKind === 'direct_guest') {
      if (!getRequestAuthorization(req).createGuestInvites) {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN' as ErrorCode, message: 'Guest links are restricted to the Circle owner' }
        } as ApiResponse);
      }
      const guestDescriptor = payload.directGuestCapabilityDescriptor;
      const presentationTitle = typeof payload.directGuestPresentationTitle === 'string'
        ? payload.directGuestPresentationTitle.trim().slice(0, 160) || null
        : null;
      const expectedGuestScope = {
        title,
        permissions: CALL_LINK_DIRECT_GUEST_PERMISSIONS,
        channelId: null,
        ...(payload.directGuestPresentationTitle !== undefined
          ? { hostIdentityName: presentationTitle }
          : {})
      };
      if (
        !guestDescriptor
        || !(await verifyCapabilityDescriptor({
          descriptor: guestDescriptor,
          issuerPublicKey: { algorithm: issuer.public_key_algorithm as 'ed25519', value: issuer.public_key_value },
          expectedKind: 'direct-guest',
          expectedIssuerIdentityId: identityId,
          expectedTargetIdentityId: identityId
        }))
        || guestDescriptor.payload.capabilityId !== descriptor.payload.capabilityId
        || guestDescriptor.payload.capabilityPublicKey.value !== descriptor.payload.capabilityPublicKey.value
        || guestDescriptor.payload.mode !== 'single-use'
        || guestDescriptor.payload.expiresAt !== expiresAt.toISOString()
        || JSON.stringify(guestDescriptor.payload.scope) !== JSON.stringify(expectedGuestScope)
      ) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid direct-guest capability descriptor' }
        } as ApiResponse);
      }
      directGuestInvitation = {
        linkId: `dgl_${nanoid(22)}`,
        capabilityDescriptor: guestDescriptor,
        presentationTitle
      };
    }

    const joinInviteToken = suggestJoinAfterCall ? descriptor.payload.capabilityId : null;
    const joinInviteId = suggestJoinAfterCall ? `invite-${nanoid(12)}` : null;
    const inviteExpiresAt = suggestJoinAfterCall ? expiresAt : null;

    const createResult = await callLinkRepository.createWithOptionalInvite({
      familyId,
      identityId,
      role,
      callLinkId,
      secretHash: descriptor.payload.capabilityId,
      title,
      suggestJoinAfterCall,
      expiresAt,
      joinInviteId,
      joinInviteToken,
      joinInviteExpiresAt: inviteExpiresAt,
      capabilityId: descriptor.payload.capabilityId,
      capabilityMode: mode,
      capabilityDescriptor: descriptor,
      encryptedSecret: encryptedSecret as any,
      directGuestInvitation,
    });

    if (!createResult.ok) {
      return res.status(403).json({
        status: 'error',
        error: {
          code: 'FORBIDDEN' as ErrorCode,
          message: 'Invitation permission required'
        }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        callLinkId,
        title,
        expiresAt: expiresAt.toISOString(),
        suggestJoinAfterCall: createResult.suggestJoinAfterCall,
        joinInviteId: createResult.joinInviteId,
        directGuestLinkId: createResult.directGuestLinkId ?? null
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Create call link error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
}));

router.post('/mine', verifySignature, requireActiveIdentity, requireFullCircleIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    const links = await callLinkRepository.findOwned(familyId, identityId);
    return res.json({
      status: 'ok',
      result: { links: links.map(serializeOwnedCallLink) }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List call links error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/:callLinkId/revoke', verifySignature, requireActiveIdentity, requireFullCircleIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const payload = getSignedPayload<{ revocation: LinkCapabilityRevocation }>(req);
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    const existing = await callLinkRepository.findById(familyId, String(req.params.callLinkId || '').trim());
    const issuer = await identityRepository.findByIdentityId(familyId, identityId);
    if (!existing || !existing.capability_id || !issuer || !payload.revocation || !verifyCapabilityRevocation({
      revocation: payload.revocation,
      issuerPublicKey: { algorithm: issuer.public_key_algorithm as 'ed25519', value: issuer.public_key_value },
      capabilityId: existing.capability_id,
      issuerIdentityId: identityId
    })) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Valid identity-signed revocation is required' }
      } as ApiResponse);
    }
    const result = await callLinkRepository.revokeOwned({
      familyId,
      identityId,
      callLinkId: String(req.params.callLinkId || '').trim(),
      unlimitedInvites: req.identity?.role === 'owner',
    });
    if (!result.ok) {
      const notFound = result.reason === 'not_found';
      return res.status(notFound ? 404 : 400).json({
        status: 'error',
        error: {
          code: (notFound ? 'NOT_FOUND' : 'INVALID_STATE') as ErrorCode,
          message: notFound ? 'Call link not found' : 'Call link is not active'
        }
      } as ApiResponse);
    }
    await callLinkRepository.setCapabilityRevocation(familyId, result.row.call_link_id, payload.revocation);
    return res.json({
      status: 'ok',
      result: {
        link: serializeOwnedCallLink(result.row),
        remaining: result.remaining,
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Revoke call link error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/resolve', async (req, res) => {
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

    const linkId = String(req.body?.linkId || '').trim();
    const capabilityId = String(req.body?.capabilityId || '').trim();
    const capabilityProof = req.body?.proof as LinkCapabilityProof | undefined;

    if (!linkId || !capabilityId || !capabilityProof) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'linkId and capability proof are required'
        }
      } as ApiResponse);
    }

    const row = await callLinkRepository.findById(familyId, linkId);
    if (!row || row.status !== 'active' || !Number.isFinite(row.expires_at.getTime()) || row.expires_at.getTime() <= Date.now()) {
      return res.status(404).json({
        status: 'error',
        error: {
          code: 'NOT_FOUND' as ErrorCode,
          message: 'Call link not found'
        }
      } as ApiResponse);
    }

    const descriptor = row.capability_descriptor;
    if (!descriptor || capabilityId !== row.capability_id || !verifyCapabilityProof({
      proof: capabilityProof,
      descriptor,
      expectedAction: 'resolve'
    })) {
      return res.status(404).json({
        status: 'error',
        error: {
          code: 'NOT_FOUND' as ErrorCode,
          message: 'Call link not found'
        }
      } as ApiResponse);
    }

    const targetIdentity = await identityRepository.findByIdentityId(familyId, row.target_identity_id);
    if (!targetIdentity || targetIdentity.status !== 'active') {
      return res.status(404).json({
        status: 'error',
        error: {
          code: 'NOT_FOUND' as ErrorCode,
          message: 'Call target is not available'
        }
      } as ApiResponse);
    }

    const familyConfig = await configService.getFamilyConfig(familyId);
    return res.json({
      status: 'ok',
      result: {
        title: typeof descriptor.payload.scope?.title === 'string'
          ? descriptor.payload.scope.title.trim() || row.title
          : row.title,
        targetIdentityId: targetIdentity.identity_id,
        targetIdentityName: null,
        serverName: descriptor.payload.scope?.showCircleName === false
          ? null
          : familyConfig?.server_name || 'Family Server',
        suggestJoinAfterCall: row.suggest_join_after_call,
        joinInviteAvailable: Boolean(row.join_invite_token),
        attachedInvitation: row.join_invite_token ? {
          kind: 'circle_membership' as const
        } : row.direct_guest_link_id
          && row.direct_guest_link_status === 'active'
          && row.direct_guest_capability_descriptor ? {
            kind: 'direct_guest' as const,
            linkId: row.direct_guest_link_id,
            capabilityDescriptor: row.direct_guest_capability_descriptor
          } : null,
        capabilityDescriptor: descriptor,
        issuerPublicKey: {
          algorithm: targetIdentity.public_key_algorithm as 'ed25519',
          value: targetIdentity.public_key_value
        }
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Resolve call link error:', error);
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
