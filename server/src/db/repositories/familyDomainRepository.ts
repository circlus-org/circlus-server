import { query } from '../index';

export type FamilyDomainRole = 'primary' | 'alias' | 'legacy' | 'pending';
export type FamilyDomainStatus = 'active' | 'pending_verification' | 'suspended' | 'disabled' | 'revoked';

export interface DBFamilyDomain {
  id: string;
  family_id: string;
  host: string;
  public_base_url: string;
  role: FamilyDomainRole;
  status: FamilyDomainStatus;
  is_current: boolean;
  source: string;
  created_at: Date;
  verified_at: Date | null;
  disabled_at: Date | null;
  replaced_at: Date | null;
}

export interface DBDeletedCircleDomain {
  host: string;
  family_id: string;
  public_base_url: string;
  extra_trusted_client_origins: string[];
  deleted_at: Date;
}

export interface DBSuspendedCircleDomain {
  host: string;
  family_id: string;
  circle_id: string;
  public_base_url: string;
  extra_trusted_client_origins: string[];
  suspended_at: Date;
}

export class FamilyDomainRepository {
  async findByHost(host: string): Promise<DBFamilyDomain | null> {
    const result = await query<DBFamilyDomain>(
      `SELECT *
       FROM family_domains
       WHERE host = $1
       LIMIT 1`,
      [host]
    );
    return result.rows[0] || null;
  }

  async listByHost(host: string): Promise<DBFamilyDomain[]> {
    const result = await query<DBFamilyDomain>(
      `SELECT *
       FROM family_domains
       WHERE host = $1
       ORDER BY is_current DESC, created_at ASC, family_id ASC`,
      [host]
    );
    return result.rows;
  }

  async findActiveByHost(host: string, circleId?: string | null): Promise<DBFamilyDomain | null> {
    const result = await query<DBFamilyDomain>(
      `SELECT fd.*
       FROM family_domains fd
       WHERE fd.host = $1
         AND fd.status = 'active'
         AND ($2::text IS NULL OR EXISTS (
           SELECT 1 FROM family_config fc
           WHERE fc.family_id = fd.family_id AND fc.circle_id = $2
         ))
       ORDER BY fd.created_at ASC
       LIMIT 1`,
      [host, circleId || null]
    );
    return result.rows[0] || null;
  }

  async resolveActiveFamily(host: string, circleId?: string | null): Promise<
    | { kind: 'found'; familyId: string; circleId: string }
    | { kind: 'not_found' | 'ambiguous' }
  > {
    const result = await query<{ family_id: string; circle_id: string }>(
      `SELECT fd.family_id, fc.circle_id
       FROM family_domains fd
       JOIN family_config fc ON fc.family_id = fd.family_id
       WHERE fd.host = $1
         AND fd.status = 'active'
         AND ($2::text IS NULL OR fc.circle_id = $2)
       ORDER BY fd.created_at ASC
       LIMIT 2`,
      [host, circleId || null]
    );
    if (result.rows.length === 0) return { kind: 'not_found' };
    if (!circleId && result.rows.length > 1) return { kind: 'ambiguous' };
    return {
      kind: 'found',
      familyId: result.rows[0]!.family_id,
      circleId: result.rows[0]!.circle_id
    };
  }

  async findFamilyIdByActiveHost(host: string, circleId?: string | null): Promise<string | null> {
    const result = await this.resolveActiveFamily(host, circleId);
    return result.kind === 'found' ? result.familyId : null;
  }

  async findDeletedByHost(host: string, circleId?: string | null): Promise<DBDeletedCircleDomain | null> {
    const result = await query<DBDeletedCircleDomain>(
      `SELECT dcd.*
       FROM deleted_circle_domains dcd
       JOIN family_config fc ON fc.family_id = dcd.family_id
       WHERE dcd.host = $1
         AND ($2::text IS NULL OR fc.circle_id = $2)
       LIMIT 1`,
      [host, circleId || null]
    );
    return result.rows[0] || null;
  }

  async findSuspendedByHost(host: string, circleId?: string | null): Promise<DBSuspendedCircleDomain | null> {
    const result = await query<DBSuspendedCircleDomain>(
      `SELECT fd.host,
              fd.family_id,
              fc.circle_id,
              fd.public_base_url,
              fc.extra_trusted_client_origins,
              COALESCE(fc.suspended_at, fc.updated_at) AS suspended_at
       FROM family_domains fd
       JOIN family_config fc ON fc.family_id = fd.family_id
       WHERE fd.host = $1
         AND ($2::text IS NULL OR fc.circle_id = $2)
         AND fd.status = 'suspended'
         AND fc.status = 'suspended'
       LIMIT 1`,
      [host, circleId || null]
    );
    return result.rows[0] || null;
  }

  async findCurrentByFamilyId(familyId: string): Promise<DBFamilyDomain | null> {
    const result = await query<DBFamilyDomain>(
      `SELECT *
       FROM family_domains
       WHERE family_id = $1
         AND status = 'active'
         AND is_current = true
       LIMIT 1`,
      [familyId]
    );
    return result.rows[0] || null;
  }

  async listByFamilyId(familyId: string): Promise<DBFamilyDomain[]> {
    const result = await query<DBFamilyDomain>(
      `SELECT *
       FROM family_domains
       WHERE family_id = $1
       ORDER BY is_current DESC, created_at ASC`,
      [familyId]
    );
    return result.rows;
  }

  async createPrimaryDomain(data: {
    familyId: string;
    host: string;
    publicBaseUrl: string;
    source?: string;
  }): Promise<DBFamilyDomain> {
    await query(
      `UPDATE family_domains
       SET is_current = false,
           role = CASE WHEN role = 'primary' THEN 'legacy' ELSE role END,
           replaced_at = COALESCE(replaced_at, NOW())
       WHERE family_id = $1
         AND is_current = true`,
      [data.familyId]
    );

    const result = await query<DBFamilyDomain>(
      `INSERT INTO family_domains (
         family_id,
         host,
         public_base_url,
         role,
         status,
         is_current,
         source,
         verified_at
       ) VALUES ($1, $2, $3, 'primary', 'active', true, $4, NOW())
       RETURNING *`,
      [data.familyId, data.host, data.publicBaseUrl, data.source || 'provisioning']
    );
    await query(`DELETE FROM deleted_circle_domains WHERE host = $1`, [data.host]);
    return result.rows[0];
  }

}

export const familyDomainRepository = new FamilyDomainRepository();
