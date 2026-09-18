import { directGuestRegistrationRepository, identityRepository } from '../db/repositories';
import type { DirectGuestPermissionFlags } from '../db/repositories/directGuestLinkRepository';
import type { DirectGuestRegistrationPermissionFlags } from '../db/repositories/directGuestRegistrationRepository';

export type DirectGuestPermissions = {
  canMessage: boolean;
  canCall: boolean;
  canDirectFileTransfer: boolean;
  canServerAttachments: boolean;
  hostCanMessageGuest: boolean;
  guestCanMessageHost: boolean;
  hostCanCallGuest: boolean;
  guestCanCallHost: boolean;
  hostCanDirectFileTransferGuest: boolean;
  guestCanDirectFileTransferHost: boolean;
  hostCanServerAttachmentsGuest: boolean;
  guestCanServerAttachmentsHost: boolean;
  autoSubscribeToChannel: boolean;
};

export function normalizeDirectGuestPermissions(value: unknown): DirectGuestPermissions | null {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const autoSubscribeToChannel = source.autoSubscribeToChannel === true;
  const guestCanMessageHost = source.guestCanMessageHost === true || source.canMessage === true;
  const guestCanCallHost = source.guestCanCallHost === true || source.canCall === true;
  const requestedGuestCanDirectFileTransferHost = source.guestCanDirectFileTransferHost === true || source.canDirectFileTransfer === true;
  const hasCanServerAttachments = Object.prototype.hasOwnProperty.call(source, 'canServerAttachments');
  const hasGuestCanServerAttachmentsHost = Object.prototype.hasOwnProperty.call(source, 'guestCanServerAttachmentsHost');
  const requestedGuestCanServerAttachmentsHost = hasGuestCanServerAttachmentsHost
    ? source.guestCanServerAttachmentsHost === true
    : hasCanServerAttachments
      ? source.canServerAttachments === true
      : source.canDirectFileTransfer === true;
  if (!guestCanMessageHost && (requestedGuestCanDirectFileTransferHost || requestedGuestCanServerAttachmentsHost)) {
    return null;
  }
  const guestCanDirectFileTransferHost = guestCanMessageHost && requestedGuestCanDirectFileTransferHost;
  const guestCanServerAttachmentsHost = guestCanMessageHost && requestedGuestCanServerAttachmentsHost;
  const permissions: DirectGuestPermissions = {
    canMessage: guestCanMessageHost,
    canCall: guestCanCallHost,
    canDirectFileTransfer: guestCanDirectFileTransferHost,
    canServerAttachments: guestCanServerAttachmentsHost,
    hostCanMessageGuest: true,
    guestCanMessageHost,
    hostCanCallGuest: true,
    guestCanCallHost,
    hostCanDirectFileTransferGuest: true,
    guestCanDirectFileTransferHost,
    hostCanServerAttachmentsGuest: true,
    guestCanServerAttachmentsHost,
    autoSubscribeToChannel
  };
  return permissions.canMessage
    || permissions.canCall
    || permissions.canDirectFileTransfer
    || permissions.canServerAttachments
    || permissions.autoSubscribeToChannel
    ? permissions
    : null;
}

export function mapDirectGuestPermissionsToDb(permissions: DirectGuestPermissions): DirectGuestPermissionFlags {
  return {
    can_message: permissions.canMessage,
    can_call: permissions.canCall,
    can_direct_file_transfer: permissions.canDirectFileTransfer,
    can_server_attachments: permissions.canServerAttachments,
    host_can_message_guest: permissions.hostCanMessageGuest,
    guest_can_message_host: permissions.guestCanMessageHost,
    host_can_call_guest: permissions.hostCanCallGuest,
    guest_can_call_host: permissions.guestCanCallHost,
    host_can_direct_file_transfer_guest: permissions.hostCanDirectFileTransferGuest,
    guest_can_direct_file_transfer_host: permissions.guestCanDirectFileTransferHost,
    host_can_server_attachments_guest: permissions.hostCanServerAttachmentsGuest,
    guest_can_server_attachments_host: permissions.guestCanServerAttachmentsHost,
    auto_subscribe_to_channel: permissions.autoSubscribeToChannel
  };
}

export function mapDirectGuestPermissionsFromDb(
  flags: DirectGuestPermissionFlags | DirectGuestRegistrationPermissionFlags
): DirectGuestPermissions {
  const hostCanMessageGuest = true;
  const guestCanMessageHost = flags.guest_can_message_host ?? flags.can_message;
  const hostCanCallGuest = true;
  const guestCanCallHost = flags.guest_can_call_host ?? flags.can_call;
  const hostCanDirectFileTransferGuest = true;
  const guestCanDirectFileTransferHost = !!guestCanMessageHost
    && !!(flags.guest_can_direct_file_transfer_host ?? flags.can_direct_file_transfer);
  const hostCanServerAttachmentsGuest = true;
  const guestCanServerAttachmentsHost = !!guestCanMessageHost
    && !!(flags.guest_can_server_attachments_host ?? flags.can_server_attachments ?? flags.can_direct_file_transfer);
  return {
    canMessage: !!guestCanMessageHost,
    canCall: !!guestCanCallHost,
    canDirectFileTransfer: !!guestCanDirectFileTransferHost,
    canServerAttachments: !!guestCanServerAttachmentsHost,
    hostCanMessageGuest: !!hostCanMessageGuest,
    guestCanMessageHost: !!guestCanMessageHost,
    hostCanCallGuest: !!hostCanCallGuest,
    guestCanCallHost: !!guestCanCallHost,
    hostCanDirectFileTransferGuest: !!hostCanDirectFileTransferGuest,
    guestCanDirectFileTransferHost: !!guestCanDirectFileTransferHost,
    hostCanServerAttachmentsGuest: !!hostCanServerAttachmentsGuest,
    guestCanServerAttachmentsHost: !!guestCanServerAttachmentsHost,
    autoSubscribeToChannel: 'auto_subscribe_to_channel' in flags
      ? !!flags.auto_subscribe_to_channel
      : false
  };
}

export async function resolveDirectCommunicationAccess(
  familyId: string,
  identityA: string,
  identityB: string,
  mode: 'messages' | 'calls' | 'direct_files' | 'server_attachments'
): Promise<
  | { allowed: true; relation: 'member' }
  | { allowed: true; relation: 'direct_guest'; permissions: DirectGuestPermissions; hostIdentityId: string; guestIdentityId: string }
  | { allowed: false; reason: string }
> {
  if (!identityA || !identityB) {
    return { allowed: false, reason: 'invalid_identity_pair' };
  }

  // Favorites is an encrypted direct thread owned by a single Circle identity.
  // Authentication still binds the action to that identity; only the usual
  // two-party relationship check is unnecessary for this self-chat.
  if (identityA === identityB) {
    if (mode === 'calls') {
      return { allowed: false, reason: 'invalid_identity_pair' };
    }
    const identity = await identityRepository.findByIdentityId(familyId, identityA as any);
    return identity?.status === 'active'
      ? { allowed: true, relation: 'member' }
      : { allowed: false, reason: 'identity_not_active' };
  }

  const [a, b] = await Promise.all([
    identityRepository.findByIdentityId(familyId, identityA as any),
    identityRepository.findByIdentityId(familyId, identityB as any),
  ]);

  if (!a || !b || a.status !== 'active' || b.status !== 'active') {
    return { allowed: false, reason: 'identity_not_active' };
  }

  const aIsGuest = a.role === 'guest';
  const bIsGuest = b.role === 'guest';

  if (!aIsGuest && !bIsGuest) {
    return { allowed: true, relation: 'member' };
  }

  const registration = await directGuestRegistrationRepository.findActiveByPair(familyId, identityA, identityB);
  if (!registration) {
    return { allowed: false, reason: 'guest_pair_not_registered' };
  }

  const permissions = mapDirectGuestPermissionsFromDb(registration);
  const actorIsHost = identityA === registration.host_identity_id;
  const actorIsGuest = identityA === registration.guest_identity_id;
  const allowed = mode === 'messages'
    ? actorIsHost
      ? permissions.hostCanMessageGuest
      : actorIsGuest && permissions.guestCanMessageHost
      : mode === 'calls'
        ? actorIsHost
          ? permissions.hostCanCallGuest
          : actorIsGuest && permissions.guestCanCallHost
      : mode === 'direct_files'
        ? actorIsHost
          ? permissions.hostCanDirectFileTransferGuest
          : actorIsGuest && permissions.guestCanDirectFileTransferHost
        : actorIsHost
          ? permissions.hostCanServerAttachmentsGuest
          : actorIsGuest && permissions.guestCanServerAttachmentsHost;

  if (!allowed) {
    return {
      allowed: false,
      reason: mode === 'messages'
        ? 'messages_not_allowed'
        : mode === 'calls'
          ? 'calls_not_allowed'
          : mode === 'direct_files'
            ? 'direct_files_not_allowed'
            : 'server_attachments_not_allowed'
    };
  }

  return {
    allowed: true,
    relation: 'direct_guest',
    permissions,
    hostIdentityId: registration.host_identity_id,
    guestIdentityId: registration.guest_identity_id,
  };
}
