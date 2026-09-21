import { pool } from '../index';
import type { PoolClient } from 'pg';
import type { DeviceId, IdentityId } from '@shared/types';

import type { FindByDeviceIdResult } from './deviceRepository.queries';

import {
  findByDeviceId,
  findByPublicKey,
  findByIdentityId,
  findActiveByIdentityId,
  updateStatus,
  countByIdentityId,
  countDevices,
  countActiveSince,
} from './deviceRepository.queries';

export class DeviceRepository {
  /**
   * Find device by device_id
   */
  async findByDeviceId(familyId: string, deviceId: DeviceId): Promise<FindByDeviceIdResult | null> {
    const results = await findByDeviceId.run({ familyId, deviceId }, pool);
    return results[0] || null;
  }

  /**
   * Find device by public key value
   */
  async findByPublicKey(familyId: string, publicKeyValue: string): Promise<FindByDeviceIdResult | null> {
    const results = await findByPublicKey.run({ familyId, publicKeyValue }, pool);
    return results[0] || null;
  }

  /**
   * Find all devices for an identity
   */
  async findByIdentityId(familyId: string, identityId: IdentityId): Promise<FindByDeviceIdResult[]> {
    return await findByIdentityId.run({ familyId, identityId }, pool);
  }

  /**
   * Find active devices for an identity
   */
  async findActiveByIdentityId(familyId: string, identityId: IdentityId): Promise<FindByDeviceIdResult[]> {
    return await findActiveByIdentityId.run({ familyId, identityId }, pool);
  }

  /**
   * Find active devices for several identities without issuing one query per participant.
   */
  async findActiveByIdentityIds(familyId: string, identityIds: IdentityId[]): Promise<FindByDeviceIdResult[]> {
    if (identityIds.length === 0) return [];

    const result = await pool.query<FindByDeviceIdResult>(
      `SELECT *
       FROM devices
       WHERE family_id = $1
         AND identity_id = ANY($2::text[])
         AND status = 'active'
       ORDER BY created_at DESC`,
      [familyId, identityIds]
    );
    return result.rows;
  }

  /**
   * Create new device
   */
  async create(data: {
    familyId: string;
    deviceId: DeviceId;
    identityId: IdentityId;
    publicKeyAlgorithm: 'ed25519' | 'x25519';
    publicKeyValue: string;
    encryptionPublicKeyAlgorithm?: 'x25519' | null;
    encryptionPublicKeyValue?: string | null;
    registrationAttestation?: unknown | null;
    webOrigin?: string | null;
    encryptedPhysicalDeviceId?: unknown | null;
  }, client?: PoolClient): Promise<FindByDeviceIdResult> {
    const result = await (client || pool).query<FindByDeviceIdResult>(
      `INSERT INTO devices (
         device_id, identity_id, family_id, public_key_algorithm, public_key_value,
         encryption_public_key_algorithm, encryption_public_key_value,
         registration_attestation, web_origin, encrypted_physical_device_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb)
       RETURNING *`,
      [data.deviceId, data.identityId, data.familyId, data.publicKeyAlgorithm, data.publicKeyValue,
        data.encryptionPublicKeyAlgorithm ?? null, data.encryptionPublicKeyValue ?? null,
        data.registrationAttestation ? JSON.stringify(data.registrationAttestation) : null,
        data.webOrigin ?? null,
        data.encryptedPhysicalDeviceId ? JSON.stringify(data.encryptedPhysicalDeviceId) : null]
    );
    return result.rows[0];
  }

  /**
   * Update device status
   */
  async updateStatus(
    familyId: string,
    deviceId: DeviceId,
    status: 'active' | 'revoked',
    client?: PoolClient
  ): Promise<FindByDeviceIdResult | null> {
    const results = await updateStatus.run({ familyId, deviceId, status }, client || pool);
    return results[0] || null;
  }

  /**
   * Update last_seen_at timestamp
   */
  async updateLastSeen(familyId: string, deviceId: DeviceId, webOrigin?: string | null): Promise<void> {
    await pool.query(
      `WITH touched AS (
         UPDATE devices
            SET last_seen_at = NOW(),
                web_origin = COALESCE($3, web_origin),
                inactivity_warning_sent_at = NULL
          WHERE device_id = $1
            AND family_id = $2
            AND status = 'active'
        RETURNING identity_id
       )
       DELETE FROM system_events event
        USING touched
        WHERE event.family_id = $2
          AND event.recipient_identity_id = touched.identity_id
          AND event.type = 'device:inactivity-warning'
          AND event.payload->>'deviceId' = $1`,
      [deviceId, familyId, webOrigin ?? null]
    );
  }

  /**
   * Backfill the opaque, per-Circle encrypted installation link for devices
   * created before physical-device grouping was introduced.
   */
  async updateEncryptedPhysicalDeviceId(
    familyId: string,
    deviceId: DeviceId,
    encryptedPhysicalDeviceId: unknown
  ): Promise<FindByDeviceIdResult | null> {
    const result = await pool.query<FindByDeviceIdResult>(
      `UPDATE devices
       SET encrypted_physical_device_id = $3
       WHERE family_id = $1 AND device_id = $2
       RETURNING *`,
      [familyId, deviceId, JSON.stringify(encryptedPhysicalDeviceId)]
    );
    return result.rows[0] || null;
  }

  /**
   * Revoke device
   */
  async revoke(familyId: string, deviceId: DeviceId, client?: PoolClient): Promise<boolean> {
    const executor = client || pool;
    const result = await executor.query(
      `UPDATE devices
          SET status = 'revoked',
              revoked_at = NOW(),
              revoked_reason = 'manual',
              inactivity_warning_sent_at = NULL
        WHERE family_id = $1
          AND device_id = $2
          AND status = 'active'
      RETURNING device_id`,
      [familyId, deviceId]
    );
    return (result.rowCount || 0) > 0;
  }

  async revokeForInactivity(
    familyId: string,
    deviceId: DeviceId,
    inactiveBefore: Date,
    warningBefore: Date,
    client: PoolClient
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE devices AS target
          SET status = 'revoked',
              revoked_at = NOW(),
              revoked_reason = 'inactivity'
        WHERE target.family_id = $1
          AND target.device_id = $2
          AND target.status = 'active'
          AND COALESCE(target.last_seen_at, target.created_at) <= $3
          AND target.inactivity_warning_sent_at IS NOT NULL
          AND target.inactivity_warning_sent_at <= $4
          AND 1 < (
            SELECT COUNT(*)
              FROM devices sibling
             WHERE sibling.family_id = target.family_id
               AND sibling.identity_id = target.identity_id
               AND sibling.status = 'active'
          )
      RETURNING target.device_id`,
      [familyId, deviceId, inactiveBefore, warningBefore]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Count devices for an identity
   */
  async countByIdentityId(familyId: string, identityId: IdentityId): Promise<number> {
    const results = await countByIdentityId.run({ familyId, identityId }, pool);
    return parseInt(results[0].count ?? '0', 10);
  }

  /**
   * Count all devices
   */
  async count(familyId: string): Promise<number> {
    const results = await countDevices.run({ familyId }, pool);
    return parseInt(results[0].count ?? '0', 10);
  }

  /**
   * Count devices active since a given date
   */
  async countActiveSince(familyId: string, since: Date): Promise<number> {
    const results = await countActiveSince.run({ familyId, since: since.toISOString() }, pool);
    return parseInt(results[0].count ?? '0', 10);
  }
}

export const deviceRepository = new DeviceRepository();
