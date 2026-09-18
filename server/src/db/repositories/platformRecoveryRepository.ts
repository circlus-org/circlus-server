import { pool, transaction } from '../index';
import { OperationConflict } from '../../services/reliableOperation';
import type {
  PlatformRecoveryBinding,
  PlatformRecoveryProofBundle,
  BeginPlatformRecoveryEnrollmentResponse
} from '../../../../shared/platformRecovery';

export type DBPlatformRecoveryBinding = {
  family_id: string;
  identity_id: string;
  binding_id: string;
  recovery_slot: string;
  binding: PlatformRecoveryBinding;
  status: 'active' | 'revoked';
  created_at: Date;
  revoked_at: Date | null;
};

export class PlatformRecoveryRepository {
  async replaceActiveBinding(params: {
    familyId: string;
    identityId: string;
    binding: PlatformRecoveryBinding;
  }): Promise<void> {
    await transaction(async client => {
      const old = await client.query(`SELECT status,identity_id FROM platform_recovery_bindings WHERE family_id=$1 AND binding_id=$2 FOR UPDATE`,[params.familyId,params.binding.payload.bindingId]);
      if (old.rows[0]?.status === 'revoked') throw new OperationConflict('Revoked binding IDs cannot be reactivated');
      if (old.rows[0] && old.rows[0].identity_id !== params.identityId) throw new OperationConflict('Binding ID is already in use');
      await client.query(
        `UPDATE platform_recovery_bindings
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
         WHERE family_id = $1 AND identity_id = $2 AND recovery_slot = $3
           AND status = 'active' AND binding_id <> $4`,
        [params.familyId, params.identityId, params.binding.payload.recoverySlot,
          params.binding.payload.bindingId]
      );
      const inserted = await client.query(
        `INSERT INTO platform_recovery_bindings (
           family_id, identity_id, binding_id, recovery_slot, binding, status
         ) VALUES ($1, $2, $3, $4, $5, 'active')
         ON CONFLICT (family_id, binding_id) DO UPDATE
           SET recovery_slot = EXCLUDED.recovery_slot, binding = EXCLUDED.binding,
               status = 'active', revoked_at = NULL
           WHERE platform_recovery_bindings.identity_id = EXCLUDED.identity_id
             AND platform_recovery_bindings.status = 'active'
             AND platform_recovery_bindings.binding = EXCLUDED.binding
           RETURNING binding_id`,
        [params.familyId, params.identityId, params.binding.payload.bindingId,
          params.binding.payload.recoverySlot, JSON.stringify(params.binding)]
      );
      if (!inserted.rows.length) throw new OperationConflict('Binding ID is immutable; create a new binding');
    });
  }

  async findActiveBinding(
    familyId: string,
    identityId: string,
    bindingId: string
  ): Promise<DBPlatformRecoveryBinding | null> {
    const result = await pool.query<DBPlatformRecoveryBinding>(
      `SELECT * FROM platform_recovery_bindings
       WHERE family_id = $1 AND identity_id = $2 AND binding_id = $3 AND status = 'active'
       LIMIT 1`,
      [familyId, identityId, bindingId]
    );
    return result.rows[0] || null;
  }

  async revokeActiveBinding(
    familyId: string,
    identityId: string,
    bindingId: string,
    recoverySlot: string
  ): Promise<boolean> {
    const result = await pool.query(
      `UPDATE platform_recovery_bindings
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
       WHERE family_id = $1 AND identity_id = $2 AND binding_id = $3
         AND recovery_slot = $4 AND status = 'active'`,
      [familyId, identityId, bindingId, recoverySlot]
    );
    return (result.rowCount || 0) > 0;
  }

  async reserveEnrollment(params: {
    familyId: string;
    identityId: string;
    enrollmentId: string;
    bindingId: string;
    expiresAt: Date;
    request: BeginPlatformRecoveryEnrollmentResponse;
  }): Promise<boolean> {
    const result = await pool.query(
      `INSERT INTO device_enrollments (
         family_id, enrollment_id, state, expires_at, enrollment_expires_at,
         requested_identity_id, enrollment_kind, platform_recovery_binding_id,
         platform_recovery_request
       ) VALUES ($1, $2, 'reserved', $3, $3, $4, 'platform_recovery', $5, $6)
       ON CONFLICT (enrollment_id) DO NOTHING`,
      [params.familyId, params.enrollmentId, params.expiresAt, params.identityId,
        params.bindingId, JSON.stringify(params.request)]
    );
    return (result.rowCount || 0) === 1;
  }

  async submitProof(params: {
    familyId: string;
    enrollmentId: string;
    proof: PlatformRecoveryProofBundle;
    origin: string | null;
    requestIp: string | null;
    requestUserAgent: string | null;
  }): Promise<boolean> {
    const result = await pool.query(
      `UPDATE device_enrollments
       SET platform_recovery_proof = $3, state = 'pending_trusted_read',
           origin = $4, origin_verified = TRUE, request_ip = $5, request_user_agent = $6
       WHERE family_id = $1 AND enrollment_id = $2
         AND enrollment_kind = 'platform_recovery' AND state = 'reserved'
         AND COALESCE(enrollment_expires_at, expires_at) > NOW()`,
      [params.familyId, params.enrollmentId, JSON.stringify(params.proof), params.origin,
        params.requestIp, params.requestUserAgent]
    );
    return (result.rowCount || 0) === 1;
  }

  async acceptVerifiedEnrollment(params: {
    familyId: string;
    enrollmentId: string;
    identityId: string;
    trustedDeviceId: string;
    bindingId: string;
  }): Promise<boolean> {
    const result = await pool.query(
      `UPDATE device_enrollments
       SET requested_trusted_device_id = $4, state = 'pending_trusted_approval',
           trusted_read_at = COALESCE(trusted_read_at, NOW())
       WHERE family_id = $1 AND enrollment_id = $2 AND requested_identity_id = $3
         AND enrollment_kind = 'platform_recovery'
         AND platform_recovery_binding_id = $5
         AND state IN ('pending_trusted_read', 'pending_trusted_approval')
         AND (requested_trusted_device_id IS NULL OR requested_trusted_device_id = $4)
         AND COALESCE(enrollment_expires_at, expires_at) > NOW()`,
      [params.familyId, params.enrollmentId, params.identityId, params.trustedDeviceId, params.bindingId]
    );
    return (result.rowCount || 0) === 1;
  }
}

export const platformRecoveryRepository = new PlatformRecoveryRepository();
