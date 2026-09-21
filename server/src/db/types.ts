// PostgreSQL Database Types
// These types match the database schema

export interface DBFamilyConfig {
  id: string;
  family_id: string;
  circle_id: string;
  server_name: string;
  public_base_url: string;
  first_owner_invite_token: string | null;
  no_names_on_server: boolean;
  message_ttl_hours: number;
  chat_epoch_rotation_interval_hours: number;
  chat_epoch_key_retention_hours: number;
  extra_trusted_client_origins: string[];
  attachments_enabled: boolean;
  max_attachment_file_size_bytes: number | null;
  attachment_storage_quota_bytes: number | null;
  attachment_retention_seconds: number | null;
  members_can_use_guest_server_attachments: boolean;
  max_member_identities: number | null;
  max_total_identities: number | null;
  used_attachment_storage_bytes: number;
  reserved_attachment_storage_bytes: number;
  message_archive_server_policy: 'disabled' | 'text' | 'text_with_attachments';
  message_archive_server_max_bytes: number | null;
  message_archive_circle_policy: 'disabled' | 'text' | 'text_with_attachments';
  message_archive_circle_max_bytes: number | null;
  // Provisioning fields (NULL for circles not created via admin panel)
  status: 'pending_owner' | 'pending_import' | 'active' | 'suspended' | 'revoked';
  owner_identity_id: string | null;
  created_by_server_admin_id: string | null;
  claimed_at: Date | null;
  revoked_at: Date | null;
  suspended_at: Date | null;
  join_invite_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DBAttachmentBlob {
  id: string;
  blob_id: string;
  family_id: string;
  uploader_identity_id: string;
  chat_type: 'direct' | 'group' | 'channel' | null;
  chat_id: string | null;
  sender_identity_id: string | null;
  linked_message_id: string | null;
  blob_purpose: 'encrypted_payload' | 'public_presentation';
  original_file_name: string | null;
  mime_type: string | null;
  plaintext_size_bytes: number;
  ciphertext_size_bytes: number;
  ciphertext_sha256: string | null;
  storage_key: string;
  status: 'reserved' | 'uploaded' | 'committed' | 'pending_delete' | 'deleted' | 'expired';
  expires_at: Date;
  committed_at: Date | null;
  deleted_at: Date | null;
  deleted_by_identity_id: string | null;
  delete_reason: 'user_request' | 'expired' | 'failed_commit' | 'admin_delete' | null;
  created_at: Date;
  updated_at: Date;
}

export interface DBAttachmentUploadReservation {
  id: string;
  reservation_id: string;
  blob_id: string;
  family_id: string;
  uploader_identity_id: string;
  upload_token_hash: string;
  plaintext_size_bytes: number;
  ciphertext_size_bytes: number | null;
  status: 'reserved' | 'uploading' | 'uploaded' | 'committed' | 'released' | 'expired';
  reserved_until: Date;
  uploaded_at: Date | null;
  committed_at: Date | null;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DBIdentity {
  id: string;
  identity_id: string;
  family_id: string;
  public_key_algorithm: 'ed25519' | 'x25519';
  public_key_value: string;
  encrypted_private_key: {
    cipher: 'aes-256-gcm';
    data: string;
    nonce: string;
    version: number;
  } | null;
  created_at: Date;
  status: 'active' | 'disabled' | 'removed';
  removed_at: Date | null;
  removed_by_identity_id: string | null;
  role: 'owner' | 'member' | 'guest' | null;
  publish_identity: boolean;
  identity_name: string | null;
  presence_visible: boolean;
  presence_last_seen_at: Date | null;

  // Circle invitation creation permission. Owners are always allowed.
  can_create_invites: boolean;
  can_create_guest_invites: boolean;

}

export interface DBDevice {
  id: string;
  device_id: string;
  identity_id: string;
  family_id: string;
  public_key_algorithm: 'ed25519' | 'x25519';
  public_key_value: string;
  created_at: Date;
  last_seen_at: Date | null;
  status: 'active' | 'revoked';
  inactivity_warning_sent_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: 'manual' | 'inactivity' | null;
}

export interface DBInvite {
  id: string;
  invite_id: string;
  token: string;
  family_id: string;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  max_uses: number;
  used_count: number;
  status: 'active' | 'expired' | 'exhausted' | 'revoked';
}

export interface DBVault {
  id: string;
  identity_id: string;
  family_id: string;
  encrypted_vault: {
    cipher: 'aes-256-gcm';
    data: string;
    nonce: string;
    version: number;
  };
  updated_at: Date;
  revision: number | null;
  status: 'present' | 'absent';
}

export interface DBCallSession {
  id: string;
  call_session_id: string;
  family_id: string;
  participants: string[];
  initiator: string;
  created_at: Date;
  accepted_at: Date | null;
  ended_at: Date | null;
  state: 'new' | 'ringing' | 'accepted' | 'connecting' | 'active' | 'ended' | 'failed' | 'expired';
  sdp_offer: string | null;
  sdp_answer: string | null;
  ice_candidates: Array<{ from: string; candidate: string }> | null;
  expires_at: Date | null;
}

export interface DBCallLink {
  id: string;
  call_link_id: string;
  family_id: string;
  target_identity_id: string;
  created_by: string;
  secret_hash: string;
  suggest_join_after_call: boolean;
  join_invite_id: string | null;
  join_invite_token: string | null;
  direct_guest_link_id: string | null;
  status: 'active' | 'revoked' | 'expired';
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
}

export interface DBCallWhitelistEntry {
  id: string;
  family_id: string;
  owner_identity_id: string;
  external_identity_id: string;
  external_public_key_algorithm: 'ed25519' | 'x25519';
  external_public_key_value: string;
  status: 'active' | 'revoked';
  created_at: Date;
  updated_at: Date;
}

export interface DBPushSubscription {
  id: string;
  push_id: string;
  device_id: string;
  family_id: string;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  delivery_method: 'direct' | 'relay';
  relay_token: string | null;
  status: 'active' | 'disabled' | 'invalid';
  created_at: Date;
  updated_at: Date;
}

export interface DBServerAdmin {
  server_admin_id: string;
  principal_identity_id: string;
  display_name: string | null;
  status: 'active' | 'revoked' | 'superseded';
  granted_at: Date;
  revoked_at: Date | null;
  granted_via: 'bootstrap' | 'recovery' | 'admin_grant';
  granted_by_server_admin_id: string | null;
}

export interface DBServerAdminClaim {
  claim_id: string;
  token_hash: string;
  status: 'pending' | 'used' | 'expired' | 'revoked';
  expires_at: Date;
  created_at: Date;
  used_at: Date | null;
  used_by_identity_id: string | null;
  created_via: 'cli';
  note: string | null;
}


export interface DBTenantOwnerClaim {
  claim_id: string;
  family_id: string;
  token_hash: string;
  status: 'pending' | 'used' | 'expired' | 'revoked';
  expires_at: Date;
  created_at: Date;
  used_at: Date | null;
  used_by_identity_id: string | null;
}

export interface DBDeviceEnrollment {
  id: string;
  family_id: string;
  enrollment_id: string;
  requested_trusted_device_id: string | null;
  requested_identity_id: string | null;
  new_device_ciphertext: string | null;
  new_device_cipher: string | null;
  new_device_id: string | null;
  new_device_public_key_algorithm: 'ed25519' | 'x25519' | null;
  new_device_public_key_value: string | null;
  new_device_encryption_public_key_algorithm: 'x25519' | null;
  new_device_encryption_public_key_value: string | null;
  origin: string | null;
  origin_verified: boolean;
  request_ip: string | null;
  request_user_agent: string | null;
  trusted_read_at: Date | null;
  state: 'reserved' | 'pending_origin_check' | 'pending_trusted_read' | 'pending_trusted_approval' | 'approved' | 'rejected' | 'expired' | 'consumed' | 'activated';
  access_mode: 'temporary' | 'full_circle';
  encrypted_temporary_membership: string | null;
  cipher: string | null;
  approved_by_device_id: string | null;
  created_at: Date;
  expires_at: Date;
  enrollment_expires_at: Date | null;
  payload_expires_at: Date | null;
  temporary_access_expires_at: Date | null;
  approved_at: Date | null;
  consumed_at: Date | null;
  delivered_at: Date | null;
  activated_at: Date | null;
  bootstrap_commitment: string | null;
  bootstrap_payload: import('../../../shared/deviceEnrollmentLink').DeviceEnrollmentBootstrapPayload | null;
  enrollment_kind: 'qr' | 'platform_recovery';
  platform_recovery_binding_id: string | null;
  platform_recovery_request: import('../../../shared/platformRecovery').BeginPlatformRecoveryEnrollmentResponse | null;
  platform_recovery_proof: import('../../../shared/platformRecovery').PlatformRecoveryProofBundle | null;
  approval_sender_public_key_algorithm: 'ed25519' | null;
  approval_sender_public_key_value: string | null;
}

export interface DBTemporaryDevice {
  id: string;
  device_id: string;
  identity_id: string;
  family_id: string;
  public_key_algorithm: 'ed25519' | 'x25519';
  public_key_value: string;
  encryption_public_key_algorithm: 'x25519' | null;
  encryption_public_key_value: string | null;
  approved_by_device_id: string;
  created_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
  status: 'active' | 'revoked' | 'expired';
  can_call: boolean;
}

export interface DBTemporaryAccessRequest {
  id: string;
  request_id: string;
  request_type: 'contacts' | 'trusted_access' | 'temporary_renewal';
  family_id: string;
  identity_id: string;
  enrollment_id: string;
  temporary_device_id: string;
  temporary_device_public_key_algorithm: 'ed25519' | 'x25519';
  temporary_device_public_key_value: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  encrypted_payload: string | null;
  cipher: string | null;
  approved_by_device_id: string | null;
  created_at: Date;
  expires_at: Date;
  approved_at: Date | null;
  consumed_at: Date | null;
}
