import type { PoolClient } from 'pg';
import { pool } from '../index';
import type { DBDeviceEnrollment } from '../types';
import type {
  FindDeviceEnrollmentByEnrollmentIdResult,
} from './deviceEnrollmentRepository.queries';
import type { DeviceEnrollmentBootstrapPayload } from '../../../../shared/deviceEnrollmentLink';
import {
  findDeviceEnrollmentByEnrollmentId,
} from './deviceEnrollmentRepository.queries';

type DbExecutor = Pick<PoolClient, 'query'>;

function mapEnrollment(row: FindDeviceEnrollmentByEnrollmentIdResult): DBDeviceEnrollment {
  const lifecycle = row as FindDeviceEnrollmentByEnrollmentIdResult & Partial<DBDeviceEnrollment>;
  return {
    id: row.id,
    family_id: row.family_id,
    enrollment_id: row.enrollment_id,
    requested_trusted_device_id: lifecycle.requested_trusted_device_id ?? null,
    requested_identity_id: lifecycle.requested_identity_id ?? null,
    new_device_ciphertext: row.new_device_ciphertext,
    new_device_cipher: row.new_device_cipher,
    new_device_id: row.new_device_id,
    new_device_public_key_algorithm: row.new_device_public_key_algorithm as DBDeviceEnrollment['new_device_public_key_algorithm'],
    new_device_public_key_value: row.new_device_public_key_value,
    new_device_encryption_public_key_algorithm: (row as any).new_device_encryption_public_key_algorithm ?? null,
    new_device_encryption_public_key_value: (row as any).new_device_encryption_public_key_value ?? null,
    origin: row.origin,
    origin_verified: row.origin_verified,
    request_ip: row.request_ip,
    request_user_agent: row.request_user_agent,
    trusted_read_at: row.trusted_read_at,
    state: row.state as DBDeviceEnrollment['state'],
    access_mode: lifecycle.access_mode || 'temporary',
    encrypted_temporary_membership: row.encrypted_temporary_membership,
    cipher: row.cipher,
    approved_by_device_id: row.approved_by_device_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    enrollment_expires_at: lifecycle.enrollment_expires_at ?? row.expires_at,
    payload_expires_at: lifecycle.payload_expires_at ?? null,
    temporary_access_expires_at: lifecycle.temporary_access_expires_at ?? null,
    approved_at: row.approved_at,
    consumed_at: row.consumed_at,
    delivered_at: lifecycle.delivered_at ?? row.consumed_at,
    activated_at: lifecycle.activated_at ?? null,
    bootstrap_commitment: lifecycle.bootstrap_commitment ?? null,
    bootstrap_payload: lifecycle.bootstrap_payload ?? null,
    enrollment_kind: lifecycle.enrollment_kind ?? 'qr',
    platform_recovery_binding_id: lifecycle.platform_recovery_binding_id ?? null,
    platform_recovery_request: lifecycle.platform_recovery_request ?? null,
    platform_recovery_proof: lifecycle.platform_recovery_proof ?? null,
    approval_sender_public_key_algorithm: lifecycle.approval_sender_public_key_algorithm ?? null,
    approval_sender_public_key_value: lifecycle.approval_sender_public_key_value ?? null,
  };
}

export class DeviceEnrollmentRepository {
  async reserve(data: {
    familyId: string;
    enrollmentId: string;
    expiresAt: Date;
    requestedTrustedDeviceId: string;
    requestedIdentityId: string;
    bootstrapCommitment?: string | null;
    bootstrapPayload?: DeviceEnrollmentBootstrapPayload | null;
  }): Promise<DBDeviceEnrollment | null> {
    const result = await pool.query(
      `INSERT INTO device_enrollments (
         family_id, enrollment_id, state, expires_at, enrollment_expires_at,
         requested_trusted_device_id, requested_identity_id,
         bootstrap_commitment, bootstrap_payload
       ) VALUES ($1, $2, 'reserved', $3, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id) DO UPDATE
         SET expires_at = GREATEST(device_enrollments.expires_at, EXCLUDED.expires_at),
             enrollment_expires_at = GREATEST(device_enrollments.enrollment_expires_at, EXCLUDED.enrollment_expires_at)
       WHERE device_enrollments.family_id = EXCLUDED.family_id
         AND device_enrollments.requested_trusted_device_id = EXCLUDED.requested_trusted_device_id
         AND device_enrollments.bootstrap_commitment IS NOT DISTINCT FROM EXCLUDED.bootstrap_commitment
         AND device_enrollments.bootstrap_payload IS NOT DISTINCT FROM EXCLUDED.bootstrap_payload
         AND device_enrollments.state = 'reserved'
       RETURNING *`,
      [
        data.familyId,
        data.enrollmentId,
        data.expiresAt,
        data.requestedTrustedDeviceId,
        data.requestedIdentityId,
        data.bootstrapCommitment || null,
        data.bootstrapPayload ? JSON.stringify(data.bootstrapPayload) : null
      ]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : null;
  }

  async attachRequestToReservation(data: {
    familyId: string;
    enrollmentId: string;
    requestedTrustedDeviceId: string;
    newDeviceCiphertext: string;
    newDeviceCipher: string;
    origin: string;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<DBDeviceEnrollment | null> {
    const result = await pool.query(
      `UPDATE device_enrollments
       SET new_device_ciphertext = $4, new_device_cipher = $5,
           origin = $6, origin_verified = TRUE, request_ip = $7,
           request_user_agent = $8, state = 'pending_trusted_read'
       WHERE family_id = $1 AND enrollment_id = $2
         AND requested_trusted_device_id = $3 AND state = 'reserved'
         AND COALESCE(enrollment_expires_at, expires_at) > NOW()
       RETURNING *`,
      [data.familyId, data.enrollmentId, data.requestedTrustedDeviceId,
        data.newDeviceCiphertext, data.newDeviceCipher, data.origin,
        data.requestIp || null, data.requestUserAgent || null]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : null;
  }

  async findByEnrollmentId(familyId: string, enrollmentId: string): Promise<DBDeviceEnrollment | null> {
    const results = await findDeviceEnrollmentByEnrollmentId.run({ familyId, enrollmentId }, pool);
    return results[0] ? mapEnrollment(results[0]) : null;
  }

  async findByEnrollmentIds(familyId: string, enrollmentIds: string[]): Promise<DBDeviceEnrollment[]> {
    if (enrollmentIds.length === 0) return [];

    const result = await pool.query<FindDeviceEnrollmentByEnrollmentIdResult>(
      `SELECT *
       FROM device_enrollments
       WHERE family_id = $1
         AND enrollment_id = ANY($2::text[])`,
      [familyId, enrollmentIds]
    );
    return result.rows.map(mapEnrollment);
  }

  async findByTemporaryDeviceId(familyId: string, temporaryDeviceId: string): Promise<DBDeviceEnrollment | null> {
    const result = await pool.query(
      `SELECT *
       FROM device_enrollments
       WHERE family_id = $1 AND new_device_id = $2
       ORDER BY approved_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [familyId, temporaryDeviceId]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : null;
  }

  async markTrustedRead(data: {
    familyId: string;
    enrollmentId: string;
  }): Promise<DBDeviceEnrollment | null> {
    const result = await pool.query(
      `UPDATE device_enrollments
       SET state = 'pending_trusted_approval', trusted_read_at = COALESCE(trusted_read_at, NOW())
       WHERE family_id = $1 AND enrollment_id = $2
         AND state IN ('pending_trusted_read', 'pending_trusted_approval')
       RETURNING *`,
      [data.familyId, data.enrollmentId]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : null;
  }

  async markApproved(data: {
    familyId: string;
    enrollmentId: string;
    approvedByDeviceId: string;
    temporaryDeviceId: string;
    temporaryDevicePublicKeyAlgorithm: 'ed25519' | 'x25519';
    temporaryDevicePublicKeyValue: string;
    temporaryDeviceEncryptionPublicKeyAlgorithm?: 'x25519' | null;
    temporaryDeviceEncryptionPublicKeyValue?: string | null;
    encryptedTemporaryMembership: string;
    cipher: string;
    expiresAt: string;
    accessMode: 'temporary' | 'full_circle';
    payloadExpiresAt: Date;
    approvalSenderPublicKeyAlgorithm?: 'ed25519' | null;
    approvalSenderPublicKeyValue?: string | null;
  }, db: DbExecutor = pool): Promise<DBDeviceEnrollment | null> {
    const result = await db.query(
      `UPDATE device_enrollments
       SET state = 'approved', approved_by_device_id = $3, new_device_id = $4,
           new_device_public_key_algorithm = $5, new_device_public_key_value = $6,
           new_device_encryption_public_key_algorithm = $7, new_device_encryption_public_key_value = $8,
           encrypted_temporary_membership = $9, cipher = $10, approved_at = NOW(),
           access_mode = $11, payload_expires_at = $12,
           temporary_access_expires_at = CASE
             WHEN $11 = 'temporary' THEN $13::timestamptz
             ELSE NULL::timestamptz
           END,
           approval_sender_public_key_algorithm = $14,
           approval_sender_public_key_value = $15
       WHERE family_id = $1 AND enrollment_id = $2 AND state = 'pending_trusted_approval'
       RETURNING *`,
      [data.familyId, data.enrollmentId, data.approvedByDeviceId, data.temporaryDeviceId,
        data.temporaryDevicePublicKeyAlgorithm, data.temporaryDevicePublicKeyValue,
        data.temporaryDeviceEncryptionPublicKeyAlgorithm ?? null, data.temporaryDeviceEncryptionPublicKeyValue ?? null,
        data.encryptedTemporaryMembership, data.cipher, data.accessMode, data.payloadExpiresAt, data.expiresAt,
        data.approvalSenderPublicKeyAlgorithm ?? null, data.approvalSenderPublicKeyValue ?? null]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : null;
  }

  async markRejected(familyId: string, enrollmentId: string): Promise<DBDeviceEnrollment | null> {
    const result = await pool.query(
      `UPDATE device_enrollments SET state = 'rejected'
       WHERE family_id = $1 AND enrollment_id = $2
         AND state IN ('reserved', 'pending_trusted_read', 'pending_trusted_approval')
       RETURNING *`,
      [familyId, enrollmentId]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : null;
  }

  async markConsumed(familyId: string, enrollmentId: string): Promise<DBDeviceEnrollment | null> {
    const result = await pool.query(
      `UPDATE device_enrollments
       SET state = 'consumed', consumed_at = COALESCE(consumed_at, NOW()), delivered_at = COALESCE(delivered_at, NOW())
       WHERE family_id = $1 AND enrollment_id = $2 AND state = 'approved'
       RETURNING *`,
      [familyId, enrollmentId]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : null;
  }

  async markActivated(familyId: string, enrollmentId: string): Promise<DBDeviceEnrollment | null> {
    const result = await pool.query(
      `UPDATE device_enrollments
       SET state = 'activated', activated_at = COALESCE(activated_at, NOW())
       WHERE family_id = $1 AND enrollment_id = $2 AND state = 'consumed'
       RETURNING *`,
      [familyId, enrollmentId]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : null;
  }

  async markRecovered(data: {
    familyId: string;
    enrollmentId: string;
    deviceId: string;
    devicePublicKeyAlgorithm: 'ed25519';
    devicePublicKeyValue: string;
  }): Promise<DBDeviceEnrollment | null> {
    const result = await pool.query(
      `UPDATE device_enrollments
       SET state = 'activated', access_mode = 'full_circle',
           new_device_id = $3, new_device_public_key_algorithm = $4,
           new_device_public_key_value = $5,
           approved_at = COALESCE(approved_at, NOW()),
           consumed_at = COALESCE(consumed_at, NOW()),
           delivered_at = COALESCE(delivered_at, NOW()),
           activated_at = COALESCE(activated_at, NOW())
       WHERE family_id = $1 AND enrollment_id = $2 AND state = 'reserved'
       RETURNING *`,
      [data.familyId, data.enrollmentId, data.deviceId,
        data.devicePublicKeyAlgorithm, data.devicePublicKeyValue]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : null;
  }

  async expireStaleEnrollments(): Promise<number> {
    const result = await pool.query(
      `UPDATE device_enrollments SET state = 'expired'
       WHERE (
         state IN ('reserved', 'pending_origin_check', 'pending_trusted_read', 'pending_trusted_approval')
         AND COALESCE(enrollment_expires_at, expires_at) < NOW()
       ) OR (
         state IN ('approved', 'consumed')
         AND payload_expires_at IS NOT NULL
         AND payload_expires_at < NOW()
       )`
    );
    return result.rowCount || 0;
  }
}

export const deviceEnrollmentRepository = new DeviceEnrollmentRepository();
