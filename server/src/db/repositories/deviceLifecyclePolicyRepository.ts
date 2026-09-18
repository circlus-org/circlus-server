import type { DeviceLifecyclePolicy, InactiveDeviceReviewItem } from '@shared/types';
import { pool, transaction } from '../index';

type PolicyRow = {
  review_after_days: number;
  auto_revoke_enabled: boolean;
  auto_revoke_after_days: number;
  warning_days: number;
  updated_at: Date;
};

function mapPolicy(row: PolicyRow): DeviceLifecyclePolicy {
  return {
    reviewAfterDays: row.review_after_days,
    autoRevokeEnabled: row.auto_revoke_enabled,
    autoRevokeAfterDays: row.auto_revoke_after_days,
    warningDays: row.warning_days,
    updatedAt: row.updated_at.toISOString()
  };
}

export class DeviceLifecyclePolicyRepository {
  async get(): Promise<DeviceLifecyclePolicy> {
    const result = await pool.query<PolicyRow>(
      `INSERT INTO server_device_lifecycle_policy (singleton_key)
       VALUES (TRUE)
       ON CONFLICT (singleton_key) DO UPDATE SET singleton_key = EXCLUDED.singleton_key
       RETURNING review_after_days, auto_revoke_enabled, auto_revoke_after_days, warning_days, updated_at`
    );
    return mapPolicy(result.rows[0]);
  }

  async update(params: {
    reviewAfterDays: number;
    autoRevokeEnabled: boolean;
    autoRevokeAfterDays: number;
    updatedByServerAdminId: string;
  }): Promise<DeviceLifecyclePolicy> {
    const result = await pool.query<PolicyRow>(
      `INSERT INTO server_device_lifecycle_policy (
         singleton_key, review_after_days, auto_revoke_enabled,
         auto_revoke_after_days, updated_by_server_admin_id, updated_at
       ) VALUES (TRUE, $1, $2, $3, $4, NOW())
       ON CONFLICT (singleton_key) DO UPDATE SET
         review_after_days = EXCLUDED.review_after_days,
         auto_revoke_enabled = EXCLUDED.auto_revoke_enabled,
         auto_revoke_after_days = EXCLUDED.auto_revoke_after_days,
         updated_by_server_admin_id = EXCLUDED.updated_by_server_admin_id,
         updated_at = NOW()
       RETURNING review_after_days, auto_revoke_enabled, auto_revoke_after_days, warning_days, updated_at`,
      [params.reviewAfterDays, params.autoRevokeEnabled, params.autoRevokeAfterDays, params.updatedByServerAdminId]
    );
    return mapPolicy(result.rows[0]);
  }

  async listReviewDevices(familyId: string, policy: DeviceLifecyclePolicy): Promise<InactiveDeviceReviewItem[]> {
    const result = await pool.query<{
      device_id: string;
      identity_id: string;
      identity_name: string | null;
      label: string | null;
      web_origin: string | null;
      created_at: Date;
      last_seen_at: Date | null;
      inactivity_warning_sent_at: Date | null;
      inactive_days: number;
      active_device_count: number;
    }>(
      `WITH active_devices AS (
         SELECT d.*,
                COUNT(*) OVER (PARTITION BY d.identity_id) AS active_device_count,
                FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(d.last_seen_at, d.created_at))) / 86400)::int AS inactive_days
           FROM devices d
           JOIN identities i ON i.family_id = d.family_id AND i.identity_id = d.identity_id
          WHERE d.family_id = $1
            AND d.status = 'active'
            AND i.status = 'active'
            AND i.role IN ('owner', 'member')
       )
       SELECT d.device_id, d.identity_id, i.identity_name, d.label, d.web_origin,
              d.created_at, d.last_seen_at, d.inactivity_warning_sent_at,
              d.inactive_days, d.active_device_count
         FROM active_devices d
         JOIN identities i ON i.family_id = d.family_id AND i.identity_id = d.identity_id
        WHERE d.inactive_days >= $2
        ORDER BY d.inactive_days DESC, d.identity_id, d.created_at`,
      [familyId, policy.reviewAfterDays]
    );
    return result.rows.map((row) => ({
      deviceId: row.device_id,
      identityId: row.identity_id,
      identityName: null,
      label: row.label,
      webOrigin: row.web_origin,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at?.toISOString() || null,
      inactiveDays: row.inactive_days,
      reviewRecommended: true,
      autoRevokeAt: policy.autoRevokeEnabled && row.inactivity_warning_sent_at
        ? new Date(row.inactivity_warning_sent_at.getTime() + policy.warningDays * 86400000).toISOString()
        : null,
      protectedAsLastDevice: row.active_device_count <= 1,
      activeDeviceCount: row.active_device_count
    }));
  }

  async listAutoRevokeCandidates(inactiveBefore: Date): Promise<Array<{
    familyId: string;
    circleId: string;
    deviceId: string;
    identityId: string;
    label: string | null;
    lastActivityAt: Date;
    warningSentAt: Date | null;
  }>> {
    const result = await pool.query<{
      family_id: string;
      circle_id: string;
      device_id: string;
      identity_id: string;
      label: string | null;
      last_activity_at: Date;
      inactivity_warning_sent_at: Date | null;
    }>(
      `SELECT d.family_id, fc.circle_id, d.device_id, d.identity_id,
              d.label, COALESCE(d.last_seen_at, d.created_at) AS last_activity_at,
              d.inactivity_warning_sent_at
         FROM devices d
         JOIN family_config fc ON fc.family_id = d.family_id
         JOIN identities i ON i.family_id = d.family_id AND i.identity_id = d.identity_id
        WHERE d.status = 'active'
          AND fc.status = 'active'
          AND i.status = 'active'
          AND i.role IN ('owner', 'member')
          AND COALESCE(d.last_seen_at, d.created_at) <= $1
          AND 1 < (
            SELECT COUNT(*) FROM devices sibling
             WHERE sibling.family_id = d.family_id
               AND sibling.identity_id = d.identity_id
               AND sibling.status = 'active'
          )
        ORDER BY COALESCE(d.last_seen_at, d.created_at) ASC`,
      [inactiveBefore]
    );
    return result.rows.map((row) => ({
      familyId: row.family_id,
      circleId: row.circle_id,
      deviceId: row.device_id,
      identityId: row.identity_id,
      label: row.label,
      lastActivityAt: row.last_activity_at,
      warningSentAt: row.inactivity_warning_sent_at
    }));
  }

  async listUnreachableProfiles(familyId: string): Promise<Array<{
    identityId: string;
    identityName: string | null;
    role: 'owner' | 'member';
    lastDeviceActivityAt: string | null;
  }>> {
    const result = await pool.query<{
      identity_id: string;
      identity_name: string | null;
      role: 'owner' | 'member';
      last_device_activity_at: Date | null;
    }>(
      `SELECT i.identity_id, i.identity_name, i.role,
              MAX(COALESCE(d.last_seen_at, d.created_at)) AS last_device_activity_at
         FROM identities i
         LEFT JOIN devices d ON d.family_id = i.family_id AND d.identity_id = i.identity_id
        WHERE i.family_id = $1
          AND i.status = 'active'
          AND i.role IN ('owner', 'member')
        GROUP BY i.identity_id, i.identity_name, i.role
       HAVING COUNT(d.device_id) FILTER (WHERE d.status = 'active') = 0
        ORDER BY last_device_activity_at NULLS FIRST, i.identity_id`,
      [familyId]
    );
    return result.rows.map((row) => ({
      identityId: row.identity_id,
      identityName: null,
      role: row.role,
      lastDeviceActivityAt: row.last_device_activity_at?.toISOString() || null
    }));
  }

  async warnCandidate(params: {
    eventId: string;
    familyId: string;
    circleId: string;
    deviceId: string;
    identityId: string;
    inactiveBefore: Date;
    createdAt: number;
    payload: unknown;
  }): Promise<boolean> {
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE devices AS target
          SET inactivity_warning_sent_at = NOW()
        WHERE target.family_id = $1
          AND target.device_id = $2
          AND target.status = 'active'
          AND target.inactivity_warning_sent_at IS NULL
          AND COALESCE(target.last_seen_at, target.created_at) <= $3
          AND 1 < (
            SELECT COUNT(*) FROM devices sibling
             WHERE sibling.family_id = target.family_id
               AND sibling.identity_id = target.identity_id
               AND sibling.status = 'active'
          )
      RETURNING target.device_id`,
        [params.familyId, params.deviceId, params.inactiveBefore]
      );
      if ((result.rowCount || 0) === 0) return false;
      await client.query(
        `INSERT INTO system_events (
           event_id, family_id, recipient_identity_id, circle_id, type, payload, created_at
         ) VALUES ($1, $2, $3, $4, 'device:inactivity-warning', $5::jsonb, $6)`,
        [params.eventId, params.familyId, params.identityId, params.circleId, JSON.stringify(params.payload), params.createdAt]
      );
      return true;
    });
  }
}

export const deviceLifecyclePolicyRepository = new DeviceLifecyclePolicyRepository();
