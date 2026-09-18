import { nanoid } from 'nanoid';
import { pool } from '../index';
import type { DBServerAdmin, DBServerAdminClaim } from '../types';
import type {
  IsActiveServerAdminResult,
  FindActiveServerAdminByIdentityIdResult,
  CreateServerAdminClaimParams,
  FindServerAdminClaimByTokenHashResult,
  CreateServerAdminParams,
} from './serverAdminRepository.queries';
import {
  isActiveServerAdmin,
  findActiveServerAdminByIdentityId,
  listActiveServerAdmins,
  createServerAdminClaim,
  findServerAdminClaimByTokenHash,
  markServerAdminClaimUsed,
  createServerAdmin,
} from './serverAdminRepository.queries';

export type ServerAdminRecord = DBServerAdmin;
export type ServerAdminClaimRecord = DBServerAdminClaim;
export type ServerAdminCandidateRecord = {
  family_id: string;
  circle_name: string;
  identity_id: string;
  identity_name: string | null;
  role: 'owner' | 'member';
};

function mapServerAdmin(row: FindActiveServerAdminByIdentityIdResult): ServerAdminRecord {
  return {
    ...row,
    display_name: (row as FindActiveServerAdminByIdentityIdResult & { display_name?: string | null }).display_name ?? null,
    status: row.status as DBServerAdmin['status'],
    granted_via: row.granted_via as DBServerAdmin['granted_via'],
  };
}

function mapServerAdminClaim(row: FindServerAdminClaimByTokenHashResult): ServerAdminClaimRecord {
  return {
    ...row,
    status: row.status as DBServerAdminClaim['status'],
    created_via: row.created_via as DBServerAdminClaim['created_via'],
  };
}

export class ServerAdminRepository {
  async isActiveServerAdmin(identityId: string): Promise<boolean> {
    const results = await isActiveServerAdmin.run({ identityId }, pool);
    return !!(results[0] as IsActiveServerAdminResult | undefined)?.exists;
  }

  async findActiveByIdentityId(identityId: string): Promise<ServerAdminRecord | null> {
    const results = await findActiveServerAdminByIdentityId.run({ identityId }, pool);
    return results[0] ? mapServerAdmin(results[0]) : null;
  }

  async listActive(): Promise<ServerAdminRecord[]> {
    const results = await listActiveServerAdmins.run(undefined as never, pool);
    return results.map(mapServerAdmin);
  }

  async findById(serverAdminId: string): Promise<ServerAdminRecord | null> {
    const result = await pool.query<DBServerAdmin>(
      `SELECT * FROM server_admins WHERE server_admin_id = $1 LIMIT 1`,
      [serverAdminId]
    );
    return result.rows[0] || null;
  }

  async listActiveDetailed(): Promise<Array<ServerAdminRecord & {
    carrier_family_id: string;
    carrier_circle_name: string;
    identity_name: string | null;
    active_device_count: number;
  }>> {
    const results = await pool.query<ServerAdminRecord & {
      carrier_family_id: string;
      carrier_circle_name: string;
      identity_name: string | null;
      active_device_count: number;
    }>(
      `SELECT sa.*,
              i.family_id::text AS carrier_family_id,
              fc.server_name AS carrier_circle_name,
              i.identity_name,
              COUNT(d.device_id) FILTER (WHERE d.status = 'active')::int AS active_device_count
       FROM server_admins sa
       JOIN identities i ON i.identity_id = sa.principal_identity_id
       JOIN family_config fc ON fc.family_id = i.family_id
       LEFT JOIN devices d ON d.identity_id = i.identity_id AND d.family_id = i.family_id
       WHERE sa.status = 'active'
       GROUP BY sa.server_admin_id, i.family_id, fc.server_name, i.identity_name
       ORDER BY sa.granted_at DESC`
    );
    return results.rows;
  }

  async listEligibleCandidatesDetailed(): Promise<ServerAdminCandidateRecord[]> {
    const result = await pool.query<ServerAdminCandidateRecord>(
      `SELECT i.family_id::text AS family_id,
              fc.server_name AS circle_name,
              i.identity_id,
              i.identity_name,
              i.role
       FROM identities i
       JOIN family_config fc ON fc.family_id = i.family_id
       WHERE fc.status = 'active'
         AND i.status = 'active'
         AND i.role IN ('owner', 'member')
       ORDER BY fc.server_name ASC, i.identity_name ASC NULLS LAST, i.identity_id ASC`
    );
    return result.rows;
  }

  async createClaim(params: {
    tokenHash: string;
    expiresAt: Date;
    note?: string | null;
  }): Promise<ServerAdminClaimRecord> {
    const claimId = `sac_${nanoid(18)}`;
    const queryParams: CreateServerAdminClaimParams = {
      claimId,
      tokenHash: params.tokenHash,
      expiresAt: params.expiresAt,
      note: params.note || null,
    };
    const results = await createServerAdminClaim.run(queryParams, pool);
    return mapServerAdminClaim(results[0]);
  }

  async findClaimByTokenHash(tokenHash: string): Promise<ServerAdminClaimRecord | null> {
    const results = await findServerAdminClaimByTokenHash.run({ tokenHash }, pool);
    return results[0] ? mapServerAdminClaim(results[0]) : null;
  }

  async markClaimUsed(tokenHash: string, identityId: string | null): Promise<void> {
    await markServerAdminClaimUsed.run({ tokenHash, identityId }, pool);
  }

  async grantToIdentity(params: {
    identityId: string;
    grantedVia: 'bootstrap' | 'recovery' | 'admin_grant';
    grantedByServerAdminId?: string | null;
    displayName?: string | null;
  }): Promise<ServerAdminRecord> {
    const existing = await this.findActiveByIdentityId(params.identityId);
    if (existing) {
      if (params.displayName) {
        return (await this.updateDisplayName(existing.server_admin_id, params.displayName)) || existing;
      }
      return existing;
    }

    const serverAdminId = `sa_${nanoid(18)}`;
    const queryParams: CreateServerAdminParams = {
      serverAdminId,
      identityId: params.identityId,
      grantedVia: params.grantedVia,
      grantedByServerAdminId: params.grantedByServerAdminId || null,
    };
    const results = await createServerAdmin.run(queryParams, pool);
    const created = mapServerAdmin(results[0]);
    if (params.displayName) {
      return (await this.updateDisplayName(created.server_admin_id, params.displayName)) || created;
    }
    return created;
  }

  async updateDisplayName(serverAdminId: string, displayName: string): Promise<ServerAdminRecord | null> {
    const result = await pool.query<DBServerAdmin>(
      `UPDATE server_admins
       SET display_name = $2
       WHERE server_admin_id = $1 AND status = 'active'
       RETURNING *`,
      [serverAdminId, displayName]
    );
    return result.rows[0] || null;
  }

  async revoke(serverAdminId: string): Promise<ServerAdminRecord | null> {
    const result = await pool.query<DBServerAdmin>(
      `UPDATE server_admins
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
       WHERE server_admin_id = $1 AND status = 'active'
       RETURNING *`,
      [serverAdminId]
    );
    return result.rows[0] || null;
  }
}

export const serverAdminRepository = new ServerAdminRepository();
