jest.mock('../db/repositories', () => ({
  identityRepository: { findByIdentityId: jest.fn() },
  directGuestRegistrationRepository: { findActiveByPair: jest.fn() }
}));

import { directGuestRegistrationRepository, identityRepository } from '../db/repositories';
import {
  mapDirectGuestPermissionsFromDb,
  normalizeDirectGuestPermissions,
  resolveDirectCommunicationAccess
} from './directGuestAccessService';

describe('direct guest permission mapping', () => {
  test('keeps broadcast separate from guest message permission', () => {
    const permissions = normalizeDirectGuestPermissions({
      canMessage: false,
      canCall: false,
      canDirectFileTransfer: false,
      autoSubscribeToChannel: true
    });

    expect(permissions).toEqual(expect.objectContaining({
      canMessage: false,
      guestCanMessageHost: false,
      hostCanMessageGuest: false,
      autoSubscribeToChannel: true
    }));
  });

  test('maps legacy guest-facing fields separately from host-facing access', () => {
    const permissions = mapDirectGuestPermissionsFromDb({
      can_message: false,
      can_call: false,
      can_direct_file_transfer: false,
      host_can_message_guest: false,
      guest_can_message_host: false,
      host_can_call_guest: false,
      guest_can_call_host: false,
      host_can_direct_file_transfer_guest: false,
      guest_can_direct_file_transfer_host: false,
      auto_subscribe_to_channel: true
    });

    expect(permissions).toEqual(expect.objectContaining({
      canMessage: false,
      canCall: false,
      canDirectFileTransfer: false,
      hostCanMessageGuest: false,
      hostCanCallGuest: false,
      hostCanDirectFileTransferGuest: false,
      guestCanMessageHost: false,
      guestCanCallHost: false,
      guestCanDirectFileTransferHost: false,
      autoSubscribeToChannel: true
    }));
  });

  test('keeps direct file transfer separate from server attachments', () => {
    const permissions = normalizeDirectGuestPermissions({
      canMessage: true,
      canCall: false,
      canDirectFileTransfer: true,
      canServerAttachments: false
    });

    expect(permissions).toEqual(expect.objectContaining({
      canDirectFileTransfer: true,
      guestCanDirectFileTransferHost: true,
      canServerAttachments: false,
      guestCanServerAttachmentsHost: false
    }));
  });

  test('rejects call-only guest access', () => {
    expect(normalizeDirectGuestPermissions({
      canMessage: false,
      canCall: true,
      canDirectFileTransfer: false,
      canServerAttachments: false,
      autoSubscribeToChannel: true
    })).toBeNull();
  });

  test('rejects file permissions when guest messages are disabled', () => {
    expect(normalizeDirectGuestPermissions({
      canMessage: false,
      canCall: true,
      canDirectFileTransfer: true,
      canServerAttachments: false
    })).toBeNull();

    expect(normalizeDirectGuestPermissions({
      canMessage: false,
      canCall: true,
      canDirectFileTransfer: false,
      canServerAttachments: true
    })).toBeNull();
  });

  test('disables legacy file permissions when guest messages are disabled', () => {
    const permissions = mapDirectGuestPermissionsFromDb({
      can_message: false,
      can_call: true,
      can_direct_file_transfer: true,
      can_server_attachments: true,
      guest_can_message_host: false,
      guest_can_direct_file_transfer_host: true,
      guest_can_server_attachments_host: true
    });

    expect(permissions).toEqual(expect.objectContaining({
      canMessage: false,
      canDirectFileTransfer: false,
      canServerAttachments: false,
      guestCanDirectFileTransferHost: false,
      guestCanServerAttachmentsHost: false
    }));
  });
});

describe('direct communication access for a self-chat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows an active identity to use its Favorites message thread', async () => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ status: 'active' });

    await expect(resolveDirectCommunicationAccess(
      'circle-1',
      'identity-1',
      'identity-1',
      'messages'
    )).resolves.toEqual({ allowed: true, relation: 'member' });

    expect(identityRepository.findByIdentityId).toHaveBeenCalledWith('circle-1', 'identity-1');
    expect(directGuestRegistrationRepository.findActiveByPair).not.toHaveBeenCalled();
  });

  it('does not turn the Favorites self-chat into a self-call target', async () => {
    await expect(resolveDirectCommunicationAccess(
      'circle-1',
      'identity-1',
      'identity-1',
      'calls'
    )).resolves.toEqual({ allowed: false, reason: 'invalid_identity_pair' });

    expect(identityRepository.findByIdentityId).not.toHaveBeenCalled();
  });

  it('rejects a self-chat when the identity is no longer active', async () => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ status: 'deleted' });

    await expect(resolveDirectCommunicationAccess(
      'circle-1',
      'identity-1',
      'identity-1',
      'messages'
    )).resolves.toEqual({ allowed: false, reason: 'identity_not_active' });
  });
});
