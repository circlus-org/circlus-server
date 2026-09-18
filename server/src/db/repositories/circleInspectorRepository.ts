import { nanoid } from 'nanoid';
import { pool, query } from '../index';

export type InspectorRequestRecord = {
  request_id: string;
  family_id: string | null;
  request_token_hash: string;
  viewer_label: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approved_by_identity_id: string | null;
  approved_by_device_id: string | null;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
};

export type InspectorSessionRecord = {
  session_id: string;
  family_id: string;
  request_id: string | null;
  viewer_label: string | null;
  session_token_hash: string;
  approved_by_identity_id: string | null;
  approved_by_device_id: string | null;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  revoked_by_identity_id: string | null;
};

function mapRequest(row: any): InspectorRequestRecord {
  return {
    ...row,
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    approved_at: row.approved_at == null ? null : Number(row.approved_at)
  };
}

function mapSession(row: any): InspectorSessionRecord {
  // The plaintext handoff token never travels inside a session record: it is
  // read only by consumeSessionTokenHandoff, which clears it in the same query.
  const rest = { ...row };
  delete rest.session_token_handoff;
  return {
    ...rest,
    viewer_label: row.viewer_label ?? null,
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    last_used_at: row.last_used_at == null ? null : Number(row.last_used_at),
    revoked_at: row.revoked_at == null ? null : Number(row.revoked_at)
  };
}

export class CircleInspectorRepository {
  async createUnboundRequest(params: {
    requestTokenHash: string;
    viewerLabel: string | null;
    now: number;
    expiresAt: number;
  }): Promise<InspectorRequestRecord> {
    const requestId = `cir_${nanoid(22)}`;
    const result = await query(
      `INSERT INTO circle_inspector_requests (
         request_id, request_token_hash, viewer_label,
         status, created_at, expires_at
       ) VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING *`,
      [
        requestId,
        params.requestTokenHash,
        params.viewerLabel,
        params.now,
        params.expiresAt
      ]
    );
    return mapRequest(result.rows[0]);
  }

  async findRequestById(requestId: string): Promise<InspectorRequestRecord | null> {
    const result = await query(
      `SELECT * FROM circle_inspector_requests WHERE request_id = $1`,
      [requestId]
    );
    return result.rows[0] ? mapRequest(result.rows[0]) : null;
  }

  async approveRequest(params: {
    familyId: string;
    requestId: string;
    requestTokenHash: string;
    approvedByIdentityId: string;
    approvedByDeviceId: string;
    sessionTokenHash: string;
    sessionTokenHandoff: string;
    now: number;
    sessionExpiresAt: number;
  }): Promise<{ request: InspectorRequestRecord; session: InspectorSessionRecord; revokedSessionIds: string[] } | null> {
    const sessionId = `cis_${nanoid(22)}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const requestResult = await client.query(
        `UPDATE circle_inspector_requests
         SET status = 'approved',
             family_id = $1,
             approved_by_identity_id = $4,
             approved_by_device_id = $5,
             approved_at = $6
         WHERE family_id IS NULL
           AND request_id = $2
           AND request_token_hash = $3
           AND status = 'pending'
           AND expires_at > $6
         RETURNING *`,
        [
          params.familyId,
          params.requestId,
          params.requestTokenHash,
          params.approvedByIdentityId,
          params.approvedByDeviceId,
          params.now
        ]
      );
      const request = requestResult.rows[0] ? mapRequest(requestResult.rows[0]) : null;
      if (!request) {
        await client.query('ROLLBACK');
        return null;
      }

      const revokedResult = await client.query<{ session_id: string }>(
        `UPDATE circle_inspector_sessions
         SET revoked_at = $2,
             revoked_by_identity_id = $3
         WHERE family_id = $1
           AND revoked_at IS NULL
           AND expires_at > $2
         RETURNING session_id`,
        [params.familyId, params.now, params.approvedByIdentityId]
      );

      const sessionResult = await client.query(
        `INSERT INTO circle_inspector_sessions (
           session_id, family_id, request_id, session_token_hash,
           session_token_handoff, approved_by_identity_id, approved_by_device_id,
           created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          sessionId,
          params.familyId,
          params.requestId,
          params.sessionTokenHash,
          params.sessionTokenHandoff,
          params.approvedByIdentityId,
          params.approvedByDeviceId,
          params.now,
          params.sessionExpiresAt
        ]
      );
      await client.query('COMMIT');
      return {
        request,
        session: mapSession(sessionResult.rows[0]),
        revokedSessionIds: revokedResult.rows.map((row) => row.session_id)
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Hands the session token to the first caller that proves knowledge of the
   * request token, and clears it in the same statement so the approve link
   * cannot yield the session credential twice.
   */
  async consumeSessionTokenHandoff(requestId: string, now: number): Promise<string | null> {
    const result = await query<{ session_token_handoff: string }>(
      `WITH pickup AS (
         SELECT session_id, session_token_handoff
         FROM circle_inspector_sessions
         WHERE request_id = $1
           AND session_token_handoff IS NOT NULL
           AND revoked_at IS NULL
           AND expires_at > $2
         FOR UPDATE
       )
       UPDATE circle_inspector_sessions AS s
       SET session_token_handoff = NULL
       FROM pickup
       WHERE s.session_id = pickup.session_id
       RETURNING pickup.session_token_handoff`,
      [requestId, now]
    );
    return result.rows[0]?.session_token_handoff || null;
  }

  async findActiveSessionByTokenHash(familyId: string, sessionTokenHash: string, now: number): Promise<InspectorSessionRecord | null> {
    const result = await query(
      `SELECT * FROM circle_inspector_sessions
       WHERE family_id = $1
         AND session_token_hash = $2
         AND revoked_at IS NULL
         AND expires_at > $3`,
      [familyId, sessionTokenHash, now]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async touchSession(familyId: string, sessionId: string, now: number): Promise<void> {
    await query(
      `UPDATE circle_inspector_sessions
       SET last_used_at = $3
       WHERE family_id = $1 AND session_id = $2`,
      [familyId, sessionId, now]
    );
  }

  async findSessionForRequestId(requestId: string): Promise<InspectorSessionRecord | null> {
    const result = await query(
      `SELECT s.*, r.viewer_label
       FROM circle_inspector_sessions s
       LEFT JOIN circle_inspector_requests r ON r.request_id = s.request_id
       WHERE s.request_id = $1 AND s.revoked_at IS NULL
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [requestId]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async listActiveSessions(familyId: string, now: number): Promise<InspectorSessionRecord[]> {
    const result = await query(
      `SELECT s.*, r.viewer_label
       FROM circle_inspector_sessions s
       LEFT JOIN circle_inspector_requests r
         ON r.family_id = s.family_id
        AND r.request_id = s.request_id
       WHERE s.family_id = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > $2
       ORDER BY s.created_at DESC
       LIMIT 100`,
      [familyId, now]
    );
    return result.rows.map(mapSession);
  }

  async cleanupInactiveAccess(now: number): Promise<{ sessions: number; requests: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sessionsResult = await client.query(
        `DELETE FROM circle_inspector_sessions
         WHERE revoked_at IS NOT NULL OR expires_at <= $1`,
        [now]
      );
      const requestsResult = await client.query(
        `DELETE FROM circle_inspector_requests r
         WHERE r.expires_at <= $1
           AND NOT EXISTS (
             SELECT 1 FROM circle_inspector_sessions s
             WHERE s.request_id = r.request_id
           )`,
        [now]
      );
      await client.query('COMMIT');
      return {
        sessions: sessionsResult.rowCount ?? 0,
        requests: requestsResult.rowCount ?? 0
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async countActiveSessions(familyId: string, now: number): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM circle_inspector_sessions
       WHERE family_id = $1
         AND revoked_at IS NULL
         AND expires_at > $2`,
      [familyId, now]
    );
    return Number(result.rows[0]?.count || 0);
  }

  async revokeSession(params: {
    familyId: string;
    sessionId: string;
    revokedByIdentityId: string;
    now: number;
  }): Promise<boolean> {
    const result = await query(
      `UPDATE circle_inspector_sessions
       SET revoked_at = COALESCE(revoked_at, $3),
           revoked_by_identity_id = COALESCE(revoked_by_identity_id, $4)
       WHERE family_id = $1 AND session_id = $2
       RETURNING session_id`,
      [params.familyId, params.sessionId, params.now, params.revokedByIdentityId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export const circleInspectorRepository = new CircleInspectorRepository();
