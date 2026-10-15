import { pool, transaction, inTransactionContext } from '../db';
import type { CallSessionRoute } from './callSessionRoutingRegistry';

export type DurableCallRoute = Pick<CallSessionRoute, 'familyId' | 'initiatorIdentityId' | 'initiatorDeviceId' | 'targetIdentityId' | 'acceptedTargetDeviceId'>;
export type DurableCallRecord = { route: DurableCallRoute; journal: unknown };
export interface CallRuntimeRecoveryStore {
  locked<T>(familyId: string, callId: string, work: () => Promise<T>): Promise<T>;
  load(familyId: string, callId: string): Promise<DurableCallRecord | undefined>;
  save(familyId: string, callId: string, record: DurableCallRecord): Promise<void>;
  close(familyId: string, callId: string): Promise<void>;
}
export const callRuntimeRecoveryStore: CallRuntimeRecoveryStore = {
  locked: (familyId, callId, work) => transaction(client => inTransactionContext(client, async () => {
    await pool.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [familyId, callId]);
    return work();
  })),
  async load(familyId, callId) {
    const result = await pool.query(`SELECT * FROM call_runtime_recovery WHERE family_id=$1 AND call_session_id=$2`, [familyId, callId]);
    if (result.rowCount !== 1) return;
    const row = result.rows[0];
    return { route: { familyId: row.family_id, initiatorIdentityId: row.initiator_identity_id,
      initiatorDeviceId: row.initiator_device_id, targetIdentityId: row.target_identity_id,
      acceptedTargetDeviceId: row.accepted_target_device_id ?? undefined }, journal: row.journal };
  },
  async save(familyId, callId, record) {
    const r = record.route;
    if (r.familyId !== familyId || !r.initiatorDeviceId || !r.initiatorIdentityId || !r.targetIdentityId
        || r.initiatorIdentityId === r.targetIdentityId) throw new Error('CALL_DURABLE_ROUTE_REQUIRED');
    // Serialize only the bounded journal write, never push/network delivery.
    await pool.query("SELECT pg_advisory_xact_lock(hashtext('call-runtime-recovery-capacity'),0)");
    await pool.query(`DELETE FROM call_runtime_recovery r WHERE updated_at < now()-interval '2 minutes'
      AND NOT EXISTS (SELECT 1 FROM call_sessions c WHERE c.family_id=r.family_id AND c.call_session_id=r.call_session_id
        AND c.state NOT IN ('ended','expired','failed'))`);
    const encoded = JSON.stringify(record.journal);
    const capacity = await pool.query(`SELECT count(*)::int AS count,COALESCE(sum(octet_length(journal::text)),0)::bigint AS bytes,
      octet_length($3::jsonb::text)::bigint AS incoming
      FROM call_runtime_recovery WHERE NOT (family_id=$1 AND call_session_id=$2)`, [familyId,callId,encoded]);
    if (Number(capacity.rows[0].count) >= 512 || Number(capacity.rows[0].bytes) + Number(capacity.rows[0].incoming) > 16*1024*1024) throw new Error('CALL_SDP_DURABLE_CAPACITY');
    const result = await pool.query(`INSERT INTO call_runtime_recovery
      (family_id,call_session_id,initiator_identity_id,initiator_device_id,target_identity_id,accepted_target_device_id,journal)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT (family_id,call_session_id) DO UPDATE SET
      accepted_target_device_id=EXCLUDED.accepted_target_device_id,journal=EXCLUDED.journal,updated_at=now()
      WHERE call_runtime_recovery.initiator_identity_id=EXCLUDED.initiator_identity_id
        AND call_runtime_recovery.initiator_device_id=EXCLUDED.initiator_device_id
        AND call_runtime_recovery.target_identity_id=EXCLUDED.target_identity_id
        AND (call_runtime_recovery.accepted_target_device_id IS NULL
          OR call_runtime_recovery.accepted_target_device_id=EXCLUDED.accepted_target_device_id)`,
    [familyId,callId,r.initiatorIdentityId,r.initiatorDeviceId,r.targetIdentityId,r.acceptedTargetDeviceId ?? null,encoded]);
    if (result.rowCount !== 1) throw new Error('CALL_DURABLE_ROUTE_CONFLICT');
  },
  async close(familyId, callId) {
    // Ended/expired call_sessions is authoritative even if this cleanup is interrupted.
    await pool.query('DELETE FROM call_runtime_recovery WHERE family_id=$1 AND call_session_id=$2', [familyId,callId]);
  }
};
