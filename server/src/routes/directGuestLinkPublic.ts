import { routeLogger } from '../utils/routeLogger';
import { isDeepStrictEqual } from 'node:util';
import { Router, type Response } from 'express';
import { nanoid } from 'nanoid';
import type { TenancyRequest } from '../middleware/tenancy';
import { configService } from '../services/configService';
import { deriveIdentityIdFromPublicKey } from '../../../shared/identityId';
import {
  announcementChannelRepository,
  deviceRepository,
  directGuestLinkRepository,
  directGuestPublicRepository,
  identityRepository
} from '../db/repositories';
import { mapDirectGuestPermissionsFromDb } from '../services/directGuestAccessService';
import { familyIdentityQuotaService } from '../services/familyIdentityQuotaService';
import { publicSiteGeneratorService } from '../services/publicSiteGeneratorService';
import { normalizeTrustedOrigin } from '../utils/trustedOrigins';
import type { ApiResponse, ChannelSubscriptionAcceptance, DeviceKeyBindingPayload, DeviceRecord, DeviceRegistrationAttestation, ErrorCode, IdentityId, IdentityRecord, PublicKey, RegisterDevicePayload, SignedRequest } from '../../../shared/types';
import { DirectGuestHostUnavailableError } from '../db/repositories/directGuestPublicRepository';
import { notifyCircleDirectoryChanged } from '../services/circleDirectoryNotificationService';
import type {
  DirectGuestAcceptance,
  LinkCapabilityDescriptor,
  LinkCapabilityProof
} from '../../../shared/linkCapability';
import { verifyCapabilityProof } from '../services/linkCapabilityService';
import { verifySignedRequest } from '../utils/crypto';
import { resolveIdentityAuthorization } from '../services/authorizationResolver';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

const router = Router();

function sendGuestInvitePermissionDenied(res: Response) {
  return res.status(403).json({
    status: 'error',
    error: { code: 'FORBIDDEN' as ErrorCode, message: 'Guest invitation permission is required' }
  } as ApiResponse);
}

function sendGuestLinkUnavailable(res: Response) {
  return res.status(404).json({
    status: 'error',
    error: { code: 'NOT_FOUND' as ErrorCode, message: 'Direct guest link not found' }
  } as ApiResponse);
}

function withoutGuestServerAttachments<T extends {
  can_server_attachments?: boolean | null;
  guest_can_server_attachments_host?: boolean | null;
}>(record: T): T {
  return {
    ...record,
    can_server_attachments: false,
    guest_can_server_attachments_host: false,
  };
}

router.post('/resolve', async (req, res) => {
  try {
    const { familyId } = req as TenancyRequest;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const linkId = String(req.body?.linkId || '').trim();
    const capabilityId = String(req.body?.capabilityId || '').trim();
    const capabilityProof = req.body?.proof as LinkCapabilityProof | undefined;
    if (!linkId || !capabilityId || !capabilityProof) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'linkId and capability proof are required' }
      } as ApiResponse);
    }

    const link = await directGuestLinkRepository.findById(familyId, linkId);
    const descriptor = link?.capability_descriptor as LinkCapabilityDescriptor | null | undefined;
    const authorized = Boolean(
      descriptor
      && capabilityId === link?.capability_id
      && verifyCapabilityProof({ proof: capabilityProof, descriptor, expectedAction: 'resolve' })
    );
    if (!link || !authorized) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Direct guest link not found' }
      } as ApiResponse);
    }
    if (link.status !== 'active') {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: `Direct guest link is ${link.status}` }
      } as ApiResponse);
    }
    if (link.expires_at && link.expires_at.getTime() <= Date.now()) {
      return sendGuestLinkUnavailable(res);
    }

    const familyConfig = await configService.getResolvedFamilyConfig(familyId);
    const hostIdentity = await identityRepository.findByIdentityId(familyId, link.host_identity_id as IdentityId);
    if (!hostIdentity || hostIdentity.status !== 'active') {
      return sendGuestLinkUnavailable(res);
    }
    const hostAuthorization = resolveIdentityAuthorization({
      status: hostIdentity.status,
      role: hostIdentity.role,
      canCreateGuestInvites: hostIdentity.can_create_guest_invites
    });
    if (!hostAuthorization.createGuestInvites) {
      return sendGuestInvitePermissionDenied(res);
    }
    const effectiveLink = hostIdentity?.role === 'member' && familyConfig.membersCanUseGuestServerAttachments === false
      ? withoutGuestServerAttachments(link)
      : link;
    const defaults = await directGuestLinkRepository.getDefaults(familyId, link.host_identity_id);
    const presentation = {
      title: link.presentation_title || defaults?.presentation_title || null,
      description: link.presentation_description || defaults?.presentation_description || null,
      imageUrl: link.presentation_image_url || defaults?.presentation_image_url || null,
    };
    const invitationChannel = link.auto_subscribe_to_channel
      ? await announcementChannelRepository.findByLink(familyId, link.link_id)
      : null;

    return res.json({
      status: 'ok',
      result: {
        linkId: link.link_id,
        permissions: mapDirectGuestPermissionsFromDb(effectiveLink),
        presentation,
        channelInvitation: invitationChannel?.status === 'active'
          ? {
              channelId: invitationChannel.channel_id,
              title: invitationChannel.title,
              description: invitationChannel.description,
            }
          : null,
        hostIdentityId: link.host_identity_id,
        hostIdentityName: null,
        hostIdentityPublicKey: hostIdentity ? {
          algorithm: hostIdentity.public_key_algorithm as 'ed25519' | 'x25519',
          value: hostIdentity.public_key_value
        } : null,
        capabilityDescriptor: descriptor || undefined,
        issuerPublicKey: descriptor && hostIdentity ? {
          algorithm: hostIdentity.public_key_algorithm as 'ed25519',
          value: hostIdentity.public_key_value
        } : undefined,
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Resolve direct guest link error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/accept', async (req, res) => {
  try {
    const { familyId, circleId } = req as TenancyRequest;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const payload = (req.body || {}) as {
      linkId?: string;
      capabilityId?: string;
      capabilityProof?: LinkCapabilityProof;
      guestAcceptance?: DirectGuestAcceptance;
      identityPublicKey?: PublicKey;
      encryptedIdentityPrivateKey?: unknown;
      deviceId?: string;
      devicePublicKey?: PublicKey;
      deviceEncryptionPublicKey?: PublicKey;
      deviceKeyBinding?: SignedRequest<DeviceKeyBindingPayload, string>;
      deviceRegistration?: SignedRequest<RegisterDevicePayload, IdentityId>;
      encryptedPhysicalDeviceId?: unknown;
      channelSubscriptionAcceptance?: ChannelSubscriptionAcceptance;
    };

    const linkId = String(payload.linkId || '').trim();
    const capabilityId = String(payload.capabilityId || '').trim();
    if (!linkId || !capabilityId || !payload.capabilityProof || !payload.guestAcceptance || !payload.identityPublicKey || !payload.deviceId || !payload.devicePublicKey || !payload.deviceEncryptionPublicKey || !payload.deviceKeyBinding || !payload.deviceRegistration) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Missing required fields' }
      } as ApiResponse);
    }

    if (payload.identityPublicKey.algorithm !== 'ed25519' || payload.devicePublicKey.algorithm !== 'ed25519') {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Unsupported public key algorithm' }
      } as ApiResponse);
    }
    if (payload.deviceEncryptionPublicKey.algorithm !== 'x25519') {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Unsupported device encryption public key algorithm' }
      } as ApiResponse);
    }
    if (!/^device-[A-Za-z0-9_-]{8,80}$/.test(payload.deviceId)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid deviceId' }
      } as ApiResponse);
    }

    const identityId = await deriveIdentityIdFromPublicKey(payload.identityPublicKey);
    const deviceKeyBinding = payload.deviceKeyBinding;
    const bindingPayload = deviceKeyBinding.payload;
    const bindingValid = deviceKeyBinding.type === 'device:key-binding'
      && bindingPayload?.version === 1
      && bindingPayload?.purpose === 'device-key-binding-v1'
      && bindingPayload.identityId === identityId
      && bindingPayload.devicePublicKey?.algorithm === payload.devicePublicKey.algorithm
      && bindingPayload.devicePublicKey?.value === payload.devicePublicKey.value
      && bindingPayload.deviceEncryptionPublicKey?.algorithm === payload.deviceEncryptionPublicKey.algorithm
      && bindingPayload.deviceEncryptionPublicKey?.value === payload.deviceEncryptionPublicKey.value
      && verifySignedRequest(deviceKeyBinding, payload.devicePublicKey);
    if (!bindingValid) {
      return res.status(401).json({
        status: 'error',
        error: { code: 'INVALID_SIGNATURE' as ErrorCode, message: 'Invalid device key binding' }
      } as ApiResponse);
    }

    const deviceRegistration = payload.deviceRegistration;
    const registrationPayload = deviceRegistration.payload;
    const registrationValid = deviceRegistration.type === 'auth:register-device'
      && deviceRegistration.signerId === identityId
      && deviceRegistration.vpsId === getServerIdentityRuntimeConfig().vpsId
      && deviceRegistration.circleId === circleId
      && registrationPayload?.deviceId === payload.deviceId
      && registrationPayload.devicePublicKey?.algorithm === payload.devicePublicKey.algorithm
      && registrationPayload.devicePublicKey?.value === payload.devicePublicKey.value
      && registrationPayload.deviceEncryptionPublicKey?.algorithm === payload.deviceEncryptionPublicKey.algorithm
      && registrationPayload.deviceEncryptionPublicKey?.value === payload.deviceEncryptionPublicKey.value
      && isDeepStrictEqual(registrationPayload.deviceKeyBinding, deviceKeyBinding)
      && isDeepStrictEqual(registrationPayload.encryptedPhysicalDeviceId ?? null, payload.encryptedPhysicalDeviceId ?? null)
      && verifySignedRequest(deviceRegistration, payload.identityPublicKey);
    if (!registrationValid) {
      return res.status(401).json({
        status: 'error',
        error: { code: 'INVALID_SIGNATURE' as ErrorCode, message: 'Invalid device registration attestation' }
      } as ApiResponse);
    }
    const registrationAttestation: DeviceRegistrationAttestation = {
      version: 1,
      identitySignedRequest: deviceRegistration,
      deviceKeyBinding
    };

    const link = await directGuestLinkRepository.findById(familyId, linkId);
    const descriptor = link?.capability_descriptor as LinkCapabilityDescriptor | null | undefined;
    let admissionClaim: { capabilityProof: LinkCapabilityProof; subjectAcceptance: DirectGuestAcceptance } | null = null;
    if (descriptor) {
      const capabilityProof = payload.capabilityProof;
      const subjectAcceptance = payload.guestAcceptance;
      const claimId = String(capabilityProof?.payload?.claimId || '').trim();
      if (
        capabilityId !== link?.capability_id
        || !capabilityProof
        || !subjectAcceptance
        || !claimId
        || !verifyCapabilityProof({
          proof: capabilityProof,
          descriptor,
          expectedAction: 'direct-guest:claim',
          expectedSubjectIdentityId: identityId,
          expectedSubjectPublicKey: payload.identityPublicKey
        })
        || subjectAcceptance.type !== 'direct-guest:acceptance'
        || subjectAcceptance.signerId !== identityId
        || subjectAcceptance.payload?.version !== 2
        || subjectAcceptance.payload?.purpose !== 'circlus-direct-guest-acceptance-v2'
        || subjectAcceptance.payload?.capabilityId !== capabilityId
        || subjectAcceptance.payload?.claimId !== claimId
        || subjectAcceptance.payload?.identityPublicKey?.algorithm !== payload.identityPublicKey.algorithm
        || subjectAcceptance.payload?.identityPublicKey?.value !== payload.identityPublicKey.value
        || !isDeepStrictEqual(subjectAcceptance.payload.capabilityProof, capabilityProof)
        || !verifySignedRequest(subjectAcceptance, payload.identityPublicKey)
      ) {
        return sendGuestLinkUnavailable(res);
      }
      admissionClaim = { capabilityProof, subjectAcceptance };
    }
    if (!link || !descriptor || !admissionClaim) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Direct guest link not found' }
      } as ApiResponse);
    }
    let created = await directGuestPublicRepository.findExistingGuestIdentityDeviceAndRegistration({
      familyId,
      linkId,
      identityId,
      deviceId: payload.deviceId
    });
    const registrationAlreadyExisted = Boolean(created);
    if (link.expires_at && link.expires_at.getTime() <= Date.now()) {
      return sendGuestLinkUnavailable(res);
    }
    const hostIdentity = await identityRepository.findByIdentityId(familyId, link.host_identity_id as IdentityId);
    if (!hostIdentity || hostIdentity.status !== 'active') {
      return sendGuestLinkUnavailable(res);
    }
    const familyConfig = await configService.getResolvedFamilyConfig(familyId);
    const hostAuthorization = resolveIdentityAuthorization({
      status: hostIdentity.status,
      role: hostIdentity.role,
      canCreateGuestInvites: hostIdentity.can_create_guest_invites
    });
    if (!registrationAlreadyExisted && !hostAuthorization.createGuestInvites) {
      return sendGuestInvitePermissionDenied(res);
    }
    const effectiveLink = hostIdentity.role === 'member' && familyConfig.membersCanUseGuestServerAttachments === false
      ? withoutGuestServerAttachments(link)
      : link;

    const invitationChannel = link.auto_subscribe_to_channel
      ? await announcementChannelRepository.findByLink(familyId, link.link_id)
      : null;
    const channelSubscriptionAcceptance = payload.channelSubscriptionAcceptance;
    if (link.auto_subscribe_to_channel) {
      const channelId = invitationChannel?.channel_id || '';
      const subscriptionPayload = channelSubscriptionAcceptance?.payload;
      const sourceProof = subscriptionPayload?.sourceLinkProof;
      const descriptorChannelId = String(descriptor.payload.scope?.channelId || '').trim();
      if (
        !channelId
        || descriptorChannelId !== channelId
        || channelSubscriptionAcceptance?.type !== 'announcement-channel:subscription'
        || channelSubscriptionAcceptance.signerId !== identityId
        || subscriptionPayload?.version !== 1
        || subscriptionPayload.purpose !== 'circlus-channel-subscription-v1'
        || subscriptionPayload.channelId !== channelId
        || subscriptionPayload.subscriberIdentityId !== identityId
        || subscriptionPayload.sourceLinkId !== link.link_id
        || subscriptionPayload.sourceLinkCapabilityId !== capabilityId
        || !sourceProof
        || !verifyCapabilityProof({
          proof: sourceProof,
          descriptor,
          expectedAction: 'direct-guest:subscribe',
          expectedSubjectIdentityId: identityId,
        })
        || sourceProof.payload.context?.channelId !== channelId
        || !verifySignedRequest(channelSubscriptionAcceptance, payload.identityPublicKey)
      ) {
        return sendGuestLinkUnavailable(res);
      }
    }

    if (created) {
      const sameIdentityKey = created.identity.public_key_value === payload.identityPublicKey.value;
      const sameDeviceKey = created.device.public_key_value === payload.devicePublicKey.value;
      const existingEncryptionKey = (created.device as any).encryption_public_key_value || null;
      const submittedEncryptionKey = payload.deviceEncryptionPublicKey?.value || null;
      if (!sameIdentityKey || !sameDeviceKey || existingEncryptionKey !== submittedEncryptionKey) {
        return res.status(409).json({
          status: 'error',
          error: { code: 'INVALID_STATE' as ErrorCode, message: 'Registered guest key material does not match' }
        } as ApiResponse);
      }
    } else if (link.status !== 'active') {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: `Direct guest link is ${link.status}` }
      } as ApiResponse);
    }

    if (!created) {
      const quotaCheck = await familyIdentityQuotaService.checkCanCreateIdentity(familyId, 'guest');
      if (!quotaCheck.allowed) {
        return res.status(quotaCheck.status).json({
          status: 'error',
          error: {
            code: quotaCheck.code as ErrorCode,
            message: quotaCheck.message,
            details: quotaCheck.details,
          }
        } as ApiResponse);
      }

      const existingIdentity = await identityRepository.findByPublicKey(familyId, payload.identityPublicKey.value);
      if (existingIdentity) {
        return res.status(409).json({
          status: 'error',
          error: { code: 'INVALID_STATE' as ErrorCode, message: 'Identity already exists' }
        } as ApiResponse);
      }

      const existingDevice = await deviceRepository.findByPublicKey(familyId, payload.devicePublicKey.value);
      if (existingDevice) {
        return res.status(409).json({
          status: 'error',
          error: { code: 'INVALID_STATE' as ErrorCode, message: 'Device already exists' }
        } as ApiResponse);
      }
      const existingDeviceId = await deviceRepository.findByDeviceId(familyId, payload.deviceId);
      if (existingDeviceId) {
        return res.status(409).json({
          status: 'error',
          error: { code: 'INVALID_STATE' as ErrorCode, message: 'Device id already exists' }
        } as ApiResponse);
      }

      created = await directGuestPublicRepository.createGuestIdentityDeviceAndRegistration({
        familyId,
        identityId,
        deviceId: payload.deviceId,
        registrationId: `dgr_${nanoid(22)}`,
        identityPublicKey: payload.identityPublicKey!,
        encryptedIdentityPrivateKey: payload.encryptedIdentityPrivateKey,
        devicePublicKey: payload.devicePublicKey!,
        deviceEncryptionPublicKey: payload.deviceEncryptionPublicKey || null,
        registrationAttestation,
        webOrigin: normalizeTrustedOrigin(req.get('origin')),
        encryptedPhysicalDeviceId: payload.encryptedPhysicalDeviceId || null,
        capabilityId: link.capability_id || null,
        admissionClaim,
        channelSubscriptionClaim: channelSubscriptionAcceptance || null,
        link: effectiveLink,
      });
      if (!registrationAlreadyExisted) void notifyCircleDirectoryChanged(familyId, 'membership');

      if (link.max_uses !== null) {
        void directGuestLinkRepository.revokeIfExhausted(familyId, linkId)
          .then(async () => {
            const exhaustedLink = await directGuestLinkRepository.findById(familyId, linkId);
            if (exhaustedLink?.status === 'revoked' && exhaustedLink.public_site_visible) {
              await publicSiteGeneratorService.regenerateSite(familyId);
            }
          })
          .catch((error) => {
            routeLogger.error('Failed to refresh public site after guest link exhaustion:', error);
          });
      }
    }

    const identityResult: IdentityRecord = {
      identityId: created.identity.identity_id,
      publicKey: {
        algorithm: created.identity.public_key_algorithm as 'ed25519' | 'x25519',
        value: created.identity.public_key_value,
      },
      encryptedPrivateKey: created.identity.encrypted_private_key as unknown as IdentityRecord['encryptedPrivateKey'],
      createdAt: created.identity.created_at.toISOString(),
      status: created.identity.status as 'active' | 'disabled',
      role: (created.identity.role as 'owner' | 'member' | 'guest' | null) || undefined,
    };

    const deviceResult: DeviceRecord = {
      deviceId: created.device.device_id,
      identityId: created.device.identity_id,
      publicKey: {
        algorithm: created.device.public_key_algorithm as 'ed25519' | 'x25519',
        value: created.device.public_key_value,
      },
      encryptionPublicKey: (created.device as any).encryption_public_key_value
        ? {
            algorithm: (created.device as any).encryption_public_key_algorithm as 'x25519',
            value: (created.device as any).encryption_public_key_value,
          }
        : null,
      webOrigin: (created.device as any).web_origin || null,
      encryptedPhysicalDeviceId: (created.device as any).encrypted_physical_device_id || null,
      createdAt: created.device.created_at.toISOString(),
      status: created.device.status as 'active' | 'revoked',
    };

    const registrationPermissions = hostIdentity?.role === 'member' && familyConfig.membersCanUseGuestServerAttachments === false
      ? mapDirectGuestPermissionsFromDb(withoutGuestServerAttachments(created.registration))
      : mapDirectGuestPermissionsFromDb(created.registration);

    return res.json({
      status: 'ok',
      result: {
        registrationId: created.registration.registration_id,
        permissions: {
          ...registrationPermissions,
          autoSubscribeToChannel: !!link.auto_subscribe_to_channel,
        },
        hostIdentityId: link.host_identity_id,
        hostIdentityName: null,
        hostIdentityPublicKey: hostIdentity ? {
          algorithm: hostIdentity.public_key_algorithm as 'ed25519' | 'x25519',
          value: hostIdentity.public_key_value
        } : null,
        identity: identityResult,
        device: deviceResult,
      }
    } as ApiResponse);
  } catch (error) {
    if (error instanceof DirectGuestHostUnavailableError) {
      return sendGuestLinkUnavailable(res);
    }
    routeLogger.error('Accept direct guest link error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

export default router;
