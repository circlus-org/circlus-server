import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import type { ErrorCode } from '@shared/types';
import { circleInspectorRepository } from '../db/repositories/circleInspectorRepository';
import { query } from '../db';
import { verifySignature, requireActiveIdentity, requireAdmin, getSignedPayload } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import {
  createToken,
  jsonError,
  jsonOk,
  requireInspectorSession,
  tableBlock,
  tokenHash,
  type InspectorRequest
} from './inspectorSupport';
import { registerInspectorReadRoutes } from './inspectorReadRoutes';

const router = Router();
const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

router.post('/requests/:requestId/approve', verifySignature, requireActiveIdentity, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId || !req.identity || !req.device) {
      return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Family context is missing');
    }

    const payload = getSignedPayload<{
      requestToken?: string;
      ttlMinutes?: number;
    }>(req);
    const requestToken = String(payload.requestToken || '').trim();
    if (!requestToken) {
      return jsonError(res, 400, 'INVALID_STATE' as ErrorCode, 'Request token is required');
    }

    const ttlMinutes = Number(payload.ttlMinutes || 60);
    const ttlMs = Math.max(5 * 60 * 1000, Math.min(MAX_SESSION_TTL_MS, Math.floor(ttlMinutes * 60 * 1000)));
    const now = Date.now();
    // The session gets its own credential. The request token stays a one-time
    // pickup key for it, so the value carried by the approve link and its QR
    // code is never itself accepted as a session bearer token.
    const sessionToken = createToken('cis');
    const result = await circleInspectorRepository.approveRequest({
      familyId,
      requestId: String(req.params.requestId || ''),
      requestTokenHash: tokenHash(requestToken),
      approvedByIdentityId: req.identity.identityId,
      approvedByDeviceId: req.device.deviceId,
      sessionTokenHash: tokenHash(sessionToken),
      sessionTokenHandoff: sessionToken,
      now,
      sessionExpiresAt: now + ttlMs
    });

    if (!result) {
      return jsonError(res, 404, 'NOT_FOUND' as ErrorCode, 'Pending inspector request not found');
    }

    return jsonOk(res, {
      requestId: result.request.request_id,
      status: result.request.status,
      sessionId: result.session.session_id,
      sessionExpiresAt: result.session.expires_at,
      revokedPreviousSessionIds: result.revokedSessionIds
    });
  } catch (error) {
    routeLogger.error('Approve inspector request error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

router.post('/sessions/list', verifySignature, requireActiveIdentity, requireAdmin, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId) return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Family context is missing');
    const now = Date.now();
    const sessions = await circleInspectorRepository.listActiveSessions(req.familyId, now);
    return jsonOk(res, {
      activeCount: sessions.length,
      sessions: sessions.map((session) => ({
        sessionId: session.session_id,
        requestId: session.request_id,
        viewerLabel: session.viewer_label,
        approvedByIdentityId: session.approved_by_identity_id,
        createdAt: session.created_at,
        expiresAt: session.expires_at,
        lastUsedAt: session.last_used_at,
        revokedAt: session.revoked_at
      }))
    });
  } catch (error) {
    routeLogger.error('List inspector sessions error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

router.post('/sessions/:sessionId/revoke', verifySignature, requireActiveIdentity, requireAdmin, async (req: AuthRequest, res) => {
  try {
    if (!req.familyId || !req.identity) return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Family context is missing');
    const ok = await circleInspectorRepository.revokeSession({
      familyId: req.familyId,
      sessionId: String(req.params.sessionId || ''),
      revokedByIdentityId: req.identity.identityId,
      now: Date.now()
    });
    if (!ok) return jsonError(res, 404, 'NOT_FOUND' as ErrorCode, 'Inspector session not found');
    return jsonOk(res, { sessionId: req.params.sessionId, revoked: true });
  } catch (error) {
    routeLogger.error('Revoke inspector session error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

router.get('/summary', requireInspectorSession, async (req: InspectorRequest, res) => {
  try {
    const familyId = req.familyId!;
    const result = await query(
      `SELECT
        (SELECT COUNT(*) FROM identities WHERE family_id = $1) AS identities,
        (SELECT COUNT(*) FROM devices WHERE family_id = $1) AS devices,
        (SELECT COUNT(DISTINCT direct_chat_id) FROM messages WHERE family_id = $1) AS direct_chats,
        (SELECT COUNT(*) FROM group_chats WHERE family_id = $1) AS group_chats,
        (SELECT COUNT(*) FROM messages WHERE family_id = $1) AS direct_messages,
        (SELECT COUNT(*) FROM group_chat_messages WHERE family_id = $1) AS group_messages,
        (SELECT COUNT(*) FROM call_logs WHERE family_id = $1) AS calls,
        (SELECT COUNT(*) FROM call_client_diagnostics WHERE family_id = $1) AS call_client_diagnostics,
        (SELECT COUNT(*) FROM call_ice_diagnostics WHERE family_id = $1) AS call_ice_diagnostics,
        (SELECT COUNT(*) FROM call_handling_events WHERE family_id = $1) AS call_handling_events`,
      [familyId]
    );
    return jsonOk(res, { summary: result.rows[0] || {} });
  } catch (error) {
    routeLogger.error('Inspector summary error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

router.get('/server', requireInspectorSession, async (req: InspectorRequest, res) => {
  try {
    const familyId = req.familyId!;
    const now = Date.now();
    const blocks = await Promise.all([
      tableBlock({
        table: 'family_config',
        title: 'Circle configuration',
        description: 'High-level server-side settings for this circle: public URL, retention limits, attachment/archive policies, trusted browser origins, and storage counters. Invite tokens and encrypted content are not shown.',
        sql: `SELECT family_id, server_name, public_base_url, status, no_names_on_server,
                     message_ttl_hours, extra_trusted_client_origins,
                     attachments_enabled, max_attachment_file_size_bytes, attachment_storage_quota_bytes,
                     attachment_retention_seconds, used_attachment_storage_bytes, reserved_attachment_storage_bytes,
                     owner_identity_id, join_invite_id, chat_epoch_rotation_interval_hours,
                     chat_epoch_key_retention_hours, message_archive_server_policy,
                     message_archive_server_max_bytes, message_archive_circle_policy,
                     message_archive_circle_max_bytes, created_at, updated_at, claimed_at, revoked_at
              FROM family_config
              WHERE family_id = $1`,
        values: [familyId]
      }),
      tableBlock({
        table: 'family_domains',
        title: 'Domain mappings',
        description: 'Hosts that route requests into this circle. Useful when debugging wrong-domain, reverse-proxy, or stale-domain issues.',
        sql: `SELECT host, public_base_url, role, status, is_current, source,
                     created_at, verified_at, disabled_at, replaced_at
              FROM family_domains
              WHERE family_id = $1
              ORDER BY is_current DESC, created_at DESC`,
        values: [familyId]
      }),
      tableBlock({
        table: 'circle_inspector_requests',
        title: 'Inspector approval requests',
        description: 'Short-lived requests created by the Inspector page before an owner approves access. Request/session tokens are stored only as hashes and are not shown.',
        sql: `SELECT request_id, viewer_label, status, approved_by_identity_id,
                     approved_by_device_id, created_at, expires_at, approved_at,
                     request_token_hash IS NOT NULL AS has_request_token_hash
              FROM circle_inspector_requests
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 100`,
        values: [familyId]
      }),
      tableBlock({
        table: 'circle_inspector_sessions',
        title: 'Inspector sessions',
        description: 'Approved Inspector access sessions. Use this to see when access was granted, last used, expired, or revoked. Session token hashes are not shown.',
        sql: `SELECT session_id, request_id, approved_by_identity_id, approved_by_device_id,
                     created_at, expires_at, last_used_at, revoked_at, revoked_by_identity_id,
                     session_token_hash IS NOT NULL AS has_session_token_hash,
                     (revoked_at IS NULL AND expires_at > $2) AS active
              FROM circle_inspector_sessions
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 100`,
        values: [familyId, now]
      }),
      tableBlock({
        table: 'server_admins',
        title: 'Server administrators',
        description: 'Server-level admin identities from this circle that may manage server-wide settings. Global admin claims are intentionally not shown in a circle-scoped inspector.',
        sql: `SELECT sa.server_admin_id, sa.principal_identity_id, sa.status, sa.granted_at,
                     sa.revoked_at, sa.granted_via, sa.granted_by_server_admin_id
              FROM server_admins sa
              INNER JOIN identities i ON i.identity_id = sa.principal_identity_id AND i.family_id = $1
              ORDER BY sa.granted_at DESC
              LIMIT 100`,
        values: [familyId]
      }),
      tableBlock({
        table: 'tenant_owner_claims',
        title: 'Circle owner claims',
        description: 'Claim links used to bind an owner identity to this circle. Token hashes are hidden; this shows lifecycle and usage metadata.',
        sql: `SELECT claim_id, status, expires_at, created_at, used_at, used_by_identity_id,
                     token_hash IS NOT NULL AS has_token_hash
              FROM tenant_owner_claims
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 100`,
        values: [familyId]
      })
    ]);
    return jsonOk(res, { blocks });
  } catch (error) {
    routeLogger.error('Inspector server transparency error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

router.get('/access', requireInspectorSession, async (req: InspectorRequest, res) => {
  try {
    const familyId = req.familyId!;
    const blocks = await Promise.all([
      tableBlock({
        table: 'invites',
        title: 'Member invite links',
        description: 'Registration invites for new circle members. Plain invite tokens are not shown; usage, expiry, and status are visible. Acceptances are listed separately.',
        sql: `SELECT invite_id, created_by, created_at, expires_at, max_uses, used_count, status,
                     token IS NOT NULL AS has_invite_token
              FROM invites
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'invite_acceptances',
        title: 'Invite acceptances',
        description: 'Audit trail of identities that accepted member invites.',
        sql: `SELECT invite_id, accepted_by_identity_id,
                     accepted_by_public_key IS NOT NULL AS has_public_key,
                     accepted_at
              FROM invite_acceptances
              WHERE family_id = $1
              ORDER BY accepted_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'direct_guest_links',
        title: 'Direct guest links',
        description: 'Secret-protected links that allow outside guests to message, call, or transfer files with a host. Link secrets and encrypted secrets are not shown.',
        sql: `SELECT link_id, host_identity_id, created_by_identity_id, status,
                     can_message, can_call, can_direct_file_transfer, max_uses,
                     created_at, updated_at, revoked_at,
                     secret_hash IS NOT NULL AS has_secret_hash,
                     encrypted_secret IS NOT NULL AS has_encrypted_secret,
                     presentation_image_url IS NOT NULL AS has_presentation_image
              FROM direct_guest_links
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'group_chat_participants',
        title: 'Group chat participants',
        description: 'Membership rows for group chats: active/left status, join order, and mute flag.',
        sql: `SELECT chat_id, identity_id, added_by_identity_id, joined_at, left_at,
                     is_active, join_order, muted
              FROM group_chat_participants
              WHERE family_id = $1
              ORDER BY joined_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'device_enrollments',
        title: 'Device enrollment requests',
        description: 'Requests for adding a new trusted device. Encrypted membership/device payloads are represented only as presence flags.',
        sql: `SELECT enrollment_id, new_device_id, origin, origin_verified,
                     request_ip, request_user_agent, state, approved_by_device_id,
                     created_at, expires_at, approved_at, consumed_at, trusted_read_at,
                     encrypted_temporary_membership IS NOT NULL AS has_encrypted_temporary_membership,
                     new_device_ciphertext IS NOT NULL AS has_new_device_ciphertext,
                     new_device_public_key_value IS NOT NULL AS has_new_device_public_key,
                     new_device_encryption_public_key_value IS NOT NULL AS has_new_device_encryption_key
              FROM device_enrollments
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'temporary_access_requests',
        title: 'Temporary access approval requests',
        description: 'Requests that grant a temporary device limited contacts or trusted access. Encrypted payloads are not shown.',
        sql: `SELECT request_id, request_type, identity_id, enrollment_id, temporary_device_id,
                     temporary_device_public_key_algorithm, status, approved_by_device_id,
                     created_at, expires_at, approved_at, consumed_at,
                     encrypted_payload IS NOT NULL AS has_encrypted_payload
              FROM temporary_access_requests
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'temporary_devices',
        title: 'Temporary devices',
        description: 'Short-lived devices approved for limited access. Public key presence, approval metadata, expiry, and status are visible.',
        sql: `SELECT device_id, identity_id, public_key_algorithm, approved_by_device_id,
                     created_at, last_seen_at, expires_at, status,
                     encryption_public_key_value IS NOT NULL AS has_encryption_key,
                     approval_attestation_payload IS NOT NULL AS has_approval_attestation
              FROM temporary_devices
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'temporary_device_chat_access',
        title: 'Temporary device chat access',
        description: 'Which chats each temporary device may read/use, without exposing message contents.',
        sql: `SELECT temporary_device_id, chat_id, chat_type, created_at
              FROM temporary_device_chat_access
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'call_links',
        title: 'Direct call links',
        description: 'Secret-protected links for starting direct calls. Link secrets are hidden; target, status, expiry, and join-invite linkage are visible.',
        sql: `SELECT call_link_id, target_identity_id, created_by, suggest_join_after_call,
                     join_invite_token IS NOT NULL AS has_join_invite_token,
                     status, created_at, expires_at, last_used_at,
                     secret_hash IS NOT NULL AS has_secret_hash
              FROM call_links
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'call_sessions',
        title: 'Live call sessions',
        description: 'WebRTC signaling sessions and their lifecycle state. SDP offers/answers and ICE candidates are represented only by presence/count flags.',
        sql: `SELECT call_session_id, participants, initiator, state, created_at,
                     accepted_at, ended_at, expires_at,
                     sdp_offer IS NOT NULL AS has_sdp_offer,
                     sdp_answer IS NOT NULL AS has_sdp_answer,
                     CASE
                       WHEN jsonb_typeof(ice_candidates) = 'array' THEN jsonb_array_length(ice_candidates)
                       ELSE 0
                     END AS ice_candidate_count
              FROM call_sessions
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'call_whitelist_entries',
        title: 'External call whitelist',
        description: 'External identities that local users have allowed to call them. Only public identity/key metadata and status are shown.',
        sql: `SELECT owner_identity_id, external_identity_id, external_public_key_algorithm,
                     external_public_key_value IS NOT NULL AS has_external_public_key,
                     status, created_at, updated_at
              FROM call_whitelist_entries
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      })
    ]);
    return jsonOk(res, { blocks });
  } catch (error) {
    routeLogger.error('Inspector access transparency error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

router.get('/storage', requireInspectorSession, async (req: InspectorRequest, res) => {
  try {
    const familyId = req.familyId!;
    const blocks = await Promise.all([
      tableBlock({
        table: 'attachment_blobs',
        title: 'Attachment blobs',
        description: 'Server-side records for encrypted uploaded files. Routing, sizes, status, retention metadata, and ciphertext digest state are visible; blob ciphertext is not returned.',
        sql: `SELECT blob_id, uploader_identity_id, blob_purpose, chat_type, chat_id, sender_identity_id,
                     linked_message_id, original_file_name, mime_type, plaintext_size_bytes,
                     ciphertext_size_bytes, ciphertext_sha256 IS NOT NULL AS has_ciphertext_hash,
                     storage_key IS NOT NULL AS has_storage_key, status, expires_at,
                     committed_at, deleted_at, deleted_by_identity_id, delete_reason,
                     created_at, updated_at
              FROM attachment_blobs
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'attachment_upload_reservations',
        title: 'Attachment upload reservations',
        description: 'Temporary upload reservations used before an attachment is committed. Upload token hashes are hidden.',
        sql: `SELECT reservation_id, blob_id, uploader_identity_id, plaintext_size_bytes,
                     ciphertext_size_bytes, status, reserved_until, uploaded_at,
                     committed_at, released_at, created_at, updated_at,
                     upload_token_hash IS NOT NULL AS has_upload_token_hash
              FROM attachment_upload_reservations
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'circle_file_access',
        title: 'Circle file access grants',
        description: 'Which file blobs belong to this Circle, including opaque encrypted avatar blobs and explicitly public site assets.',
        sql: `SELECT access_id, blob_id, purpose, granted_at
              FROM circle_file_access
              WHERE family_id = $1
              ORDER BY granted_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'identity_backups',
        title: 'Profile backups',
        description: 'Encrypted profile backup blobs stored by Circle secret namespace and device slot. The encrypted backup itself is not shown.',
        sql: `SELECT backup_id, last_uploader_identity_id, last_uploader_device_id, backup_slot_id, version,
                     encrypted_backup IS NOT NULL AS has_encrypted_backup,
                     created_at, updated_at
              FROM identity_backups
              WHERE family_id = $1
              ORDER BY updated_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'message_archive_jobs',
        title: 'Message archive jobs',
        description: 'Per-identity encrypted archive configuration and status. Wrapped keys and encrypted manifests are not returned.',
        sql: `SELECT archive_id, owner_identity_id, writer_device_id, destination_type,
                     mode, archive_key_version, manifest_revision, status,
                     last_archived_at, created_at, updated_at,
                     wrapped_archive_key IS NOT NULL AS has_wrapped_archive_key,
                     encrypted_manifest IS NOT NULL AS has_encrypted_manifest
              FROM message_archive_jobs
              WHERE family_id = $1
              ORDER BY updated_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'message_archive_segments',
        title: 'Message archive segments',
        description: 'Encrypted archive chunks and their sizes/counts. Segment ciphertext is not returned.',
        sql: `SELECT segment_id, archive_id, owner_identity_id, writer_device_id,
                     period_key, state, revision, period_started_at, period_ended_at,
                     message_count, byte_size, created_at, updated_at,
                     encrypted_segment IS NOT NULL AS has_encrypted_segment
              FROM message_archive_segments
              WHERE family_id = $1
              ORDER BY updated_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'vaults',
        title: 'Encrypted vaults',
        description: 'Per-identity encrypted user vault records. The encrypted vault JSON is not returned, only lifecycle metadata.',
        sql: `SELECT identity_id, revision, status, updated_at,
                     encrypted_vault IS NOT NULL AS has_encrypted_vault
              FROM vaults
              WHERE family_id = $1
              ORDER BY updated_at DESC
              LIMIT 200`,
        values: [familyId]
      })
    ]);
    return jsonOk(res, { blocks });
  } catch (error) {
    routeLogger.error('Inspector storage transparency error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

router.get('/sync', requireInspectorSession, async (req: InspectorRequest, res) => {
  try {
    const familyId = req.familyId!;
    const blocks = await Promise.all([
      tableBlock({
        table: 'system_events',
        title: 'System events',
        description: 'Server-visible events delivered to devices, such as missed calls or membership changes. Payload JSON is returned as metadata for debugging.',
        sql: `SELECT event_id, recipient_identity_id, circle_id, type, payload, created_at
              FROM system_events
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'system_device_sync',
        title: 'System event sync cursors',
        description: 'Per-device cursor showing how far each device has synced system events.',
        sql: `SELECT device_id, last_system_sync_at
              FROM system_device_sync
              WHERE family_id = $1
              ORDER BY last_system_sync_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'message_device_sync',
        title: 'Message sync cursors',
        description: 'Per-device cursors for direct message, status, and mutation sync. Useful for diagnosing stale devices.',
        sql: `SELECT device_id, last_sync_at, last_status_sync_at, last_mutation_sync_at
              FROM message_device_sync
              WHERE family_id = $1
              ORDER BY GREATEST(last_sync_at, last_status_sync_at, last_mutation_sync_at) DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'call_device_sync',
        title: 'Call history sync cursors',
        description: 'Per-device cursor for call history sync.',
        sql: `SELECT device_id, last_call_history_sync_at
              FROM call_device_sync
              WHERE family_id = $1
              ORDER BY last_call_history_sync_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'identity_read_cursors',
        title: 'Direct chat read cursors',
        description: 'Read-through positions for direct conversations. This exposes read metadata, not message plaintext.',
        sql: `SELECT reader_identity_id, peer_identity_id, read_through, updated_at
              FROM identity_read_cursors
              WHERE family_id = $1::text
              ORDER BY updated_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'group_chat_reads',
        title: 'Group chat read cursors',
        description: 'Last-read timestamps per identity and group chat.',
        sql: `SELECT chat_id, identity_id, last_read_at
              FROM group_chat_reads
              WHERE family_id = $1
              ORDER BY last_read_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'direct_chat_seq',
        title: 'Direct chat sequence counters',
        description: 'Last server-assigned sequence number per direct chat. Useful for diagnosing ordering gaps.',
        sql: `SELECT direct_chat_id, last_seq
              FROM direct_chat_seq
              WHERE family_id = $1::text
              ORDER BY last_seq DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'group_chat_seq',
        title: 'Group chat sequence counters',
        description: 'Last server-assigned sequence number per group chat.',
        sql: `SELECT chat_id, last_seq
              FROM group_chat_seq
              WHERE family_id = $1::text
              ORDER BY last_seq DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'direct_chat_epoch_state',
        title: 'Direct chat epoch state',
        description: 'Current encryption epoch per direct chat. Shows key-rotation metadata only.',
        sql: `SELECT direct_chat_id, current_epoch, updated_at
              FROM direct_chat_epoch_state
              WHERE family_id = $1
              ORDER BY updated_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'direct_chat_epoch_keys',
        title: 'Direct chat epoch key commitments',
        description: 'Key-rotation commitments for direct chats. Signed transitions are represented by presence flags, not full payloads.',
        sql: `SELECT direct_chat_id, epoch, proposer_identity_id, proposer_device_id,
                     key_commitment IS NOT NULL AS has_key_commitment,
                     signed_epoch_transition IS NOT NULL AS has_signed_epoch_transition,
                     created_at
              FROM direct_chat_epoch_keys
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'direct_chat_key_envelopes',
        title: 'Direct chat key envelopes',
        description: 'Encrypted per-identity key envelopes for direct chat epochs. Envelope ciphertext is not returned; this shows coverage.',
        sql: `SELECT direct_chat_id, epoch, identity_id, publisher_identity_id,
                     envelope_ciphertext IS NOT NULL AS has_envelope_ciphertext,
                     created_at
              FROM direct_chat_key_envelopes
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'group_chat_epoch_keys',
        title: 'Group chat epoch key commitments',
        description: 'Key-rotation commitments for group chats. Signed transitions are represented by presence flags.',
        sql: `SELECT chat_id, epoch, proposer_identity_id, proposer_device_id,
                     key_commitment IS NOT NULL AS has_key_commitment,
                     signed_epoch_transition IS NOT NULL AS has_signed_epoch_transition,
                     created_at
              FROM group_chat_epoch_keys
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'group_chat_key_envelopes',
        title: 'Group chat key envelopes',
        description: 'Encrypted per-identity key envelopes for group chat epochs. Ciphertext is not returned; this shows whether envelopes exist.',
        sql: `SELECT chat_id, epoch, identity_id, publisher_identity_id,
                     envelope_ciphertext IS NOT NULL AS has_envelope_ciphertext,
                     created_at
              FROM group_chat_key_envelopes
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'temporary_device_group_chat_key_envelopes',
        title: 'Temporary device group key envelopes',
        description: 'Encrypted group chat keys prepared for temporary devices. Ciphertext and publisher public keys are represented by presence flags.',
        sql: `SELECT temporary_device_id, chat_id, epoch, publisher_identity_id,
                     envelope_ciphertext IS NOT NULL AS has_envelope_ciphertext,
                     publisher_enc_public_key_value IS NOT NULL AS has_publisher_encryption_key,
                     created_at
              FROM temporary_device_group_chat_key_envelopes
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'temporary_device_direct_chat_key_envelopes',
        title: 'Temporary device direct key envelopes',
        description: 'Encrypted direct chat keys prepared for temporary devices. Ciphertext and publisher public keys are represented by presence flags.',
        sql: `SELECT temporary_device_id, direct_chat_id, epoch, publisher_identity_id,
                     envelope_ciphertext IS NOT NULL AS has_envelope_ciphertext,
                     publisher_enc_public_key_value IS NOT NULL AS has_publisher_encryption_key,
                     created_at
              FROM temporary_device_direct_chat_key_envelopes
              WHERE family_id = $1
              ORDER BY created_at DESC
              LIMIT 300`,
        values: [familyId]
      }),
      tableBlock({
        table: 'device_notification_bindings',
        title: 'Device notification bindings',
        description: 'Notification route bindings for devices. Direct mobile delivery tokens and payload encryption keys are represented only by presence and expiry.',
        sql: `SELECT web_device_id, mobile_endpoint_id, mobile_endpoint_ref, route,
                     bound_web_origin, status, bound_at, unbound_at, created_at, updated_at,
                     delivery_token IS NOT NULL AS has_delivery_token,
                     delivery_token_expires_at,
                     push_encryption_public_key IS NOT NULL AS has_push_encryption_key
              FROM device_notification_bindings
              WHERE family_id = $1
              ORDER BY updated_at DESC
              LIMIT 200`,
        values: [familyId]
      }),
      tableBlock({
        table: 'push_subscriptions',
        title: 'Web push subscriptions',
        description: 'Browser push subscriptions. Endpoint and keys are not returned; this shows delivery method and status.',
        sql: `SELECT push_id, device_id, delivery_method, status, created_at, updated_at,
                     endpoint IS NOT NULL AS has_endpoint,
                     keys_p256dh IS NOT NULL AS has_p256dh_key,
                     keys_auth IS NOT NULL AS has_auth_key,
                     relay_token IS NOT NULL AS has_relay_token
              FROM push_subscriptions
              WHERE family_id = $1
              ORDER BY updated_at DESC
              LIMIT 200`,
        values: [familyId]
      })
    ]);
    return jsonOk(res, { blocks });
  } catch (error) {
    routeLogger.error('Inspector sync transparency error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

registerInspectorReadRoutes(router);

export default router;
