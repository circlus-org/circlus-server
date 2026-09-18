import type { LinkCapabilityDescriptor } from './linkCapability';

export type CallLinkAttachedInvitationKind = 'circle_membership' | 'direct_guest';

export type CallLinkAttachedInvitation =
  | { kind: 'circle_membership' }
  | {
      kind: 'direct_guest';
      linkId: string;
      capabilityDescriptor: LinkCapabilityDescriptor;
    };

/**
 * A call-linked guest invitation grants durable conversation access only.
 * File transfer, server attachments, and channel subscription remain explicit
 * guest-link choices and are never enabled as a side effect of a call link.
 */
export const CALL_LINK_DIRECT_GUEST_PERMISSIONS = Object.freeze({
  canMessage: true,
  canCall: true,
  canDirectFileTransfer: false,
  canServerAttachments: false,
  hostCanMessageGuest: true,
  guestCanMessageHost: true,
  hostCanCallGuest: true,
  guestCanCallHost: true,
  hostCanDirectFileTransferGuest: false,
  guestCanDirectFileTransferHost: false,
  hostCanServerAttachmentsGuest: false,
  guestCanServerAttachmentsHost: false,
  autoSubscribeToChannel: false
});
