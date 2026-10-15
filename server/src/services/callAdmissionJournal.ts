import { pool, transaction, inTransactionContext } from '../db';

export type CallAdmissionScope = {
  familyId: string; callSessionId: string; initiatorIdentityId: string;
  initiatorDeviceId: string; targetIdentityId: string;
};
const values = (s: CallAdmissionScope) => [s.familyId, s.callSessionId, s.initiatorIdentityId, s.initiatorDeviceId, s.targetIdentityId];
const where = 'family_id=$1 AND call_session_id=$2 AND initiator_identity_id=$3 AND initiator_device_id=$4 AND target_identity_id=$5';

async function locked<T>(scope: CallAdmissionScope, operation: () => Promise<T>): Promise<T> {
  if (values(scope).some(value => typeof value !== 'string' || !value.trim() || value.length > 256)) throw new Error('CALL_ADMISSION_SCOPE_REQUIRED');
  return transaction(client => inTransactionContext(client, async () => {
    await pool.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [scope.familyId, scope.callSessionId]);
    return operation();
  }));
}

export const callAdmissionJournal = {
  async create(scope: CallAdmissionScope, createSession: () => Promise<unknown>): Promise<boolean> {
    return locked(scope, async () => {
      const previous = await pool.query(`SELECT phase FROM call_admission_journal WHERE ${where}`, values(scope));
      if (previous.rows.some(row => row.phase === 'cancelled')) return false;
      await pool.query(`INSERT INTO call_admission_journal
        (family_id, call_session_id, initiator_identity_id, initiator_device_id, target_identity_id, phase)
        VALUES ($1,$2,$3,$4,$5,'offered') ON CONFLICT DO NOTHING`, values(scope));
      await createSession(); // Same transaction: no offered record without its call row.
      return true;
    });
  },
  async cancelBeforeOffer(scope: CallAdmissionScope, actionId: string): Promise<boolean> {
    return locked(scope, async () => {
      const existing = await pool.query('SELECT 1 FROM call_sessions WHERE family_id=$1 AND call_session_id=$2', values(scope).slice(0, 2));
      if (existing.rowCount) return false; // Re-read normal termination state; never ACK this race speculatively.
      await pool.query(`INSERT INTO call_admission_journal
        (family_id, call_session_id, initiator_identity_id, initiator_device_id, target_identity_id, phase, terminal_action_id, cancelled_at)
        VALUES ($1,$2,$3,$4,$5,'cancelled',$6,now())
        ON CONFLICT (family_id,call_session_id,initiator_identity_id,initiator_device_id,target_identity_id)
        DO UPDATE SET phase='cancelled', terminal_action_id=EXCLUDED.terminal_action_id, cancelled_at=COALESCE(call_admission_journal.cancelled_at,now())`, [...values(scope), actionId]);
      return true;
    });
  },
  async hasOfferedRoute(scope: CallAdmissionScope): Promise<boolean> {
    const result = await pool.query(`SELECT 1 FROM call_admission_journal WHERE ${where} AND phase='offered'`, values(scope));
    return result.rowCount === 1;
  },
  async end(familyId: string, callSessionId: string): Promise<void> {
    await pool.query(`UPDATE call_admission_journal SET phase='cancelled', cancelled_at=COALESCE(cancelled_at,now())
      WHERE family_id=$1 AND call_session_id=$2 AND phase='offered'`, [familyId, callSessionId]);
  }
};
