import { query } from '../db';
import { configService } from './configService';

export type IdentityQuotaRole = 'owner' | 'member' | 'guest';

export type IdentityQuotaCheck =
  | { allowed: true }
  | {
      allowed: false;
      status: number;
      code: 'MEMBER_LIMIT_EXCEEDED' | 'TOTAL_USER_LIMIT_EXCEEDED';
      message: string;
      details: {
        limit: number;
        current: number;
      };
    };

async function countActiveIdentities(familyId: string): Promise<{ memberCount: number; totalCount: number }> {
  const result = await query<{ member_count: string; total_count: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE role IN ('owner', 'member')) AS member_count,
       COUNT(*) AS total_count
     FROM identities
     WHERE family_id = $1
       AND status = 'active'`,
    [familyId]
  );
  return {
    memberCount: Number(result.rows[0]?.member_count || 0),
    totalCount: Number(result.rows[0]?.total_count || 0),
  };
}

class FamilyIdentityQuotaService {
  async checkCanCreateIdentity(familyId: string, role: IdentityQuotaRole): Promise<IdentityQuotaCheck> {
    const config = await configService.getFamilyConfig(familyId);
    if (!config) {
      return { allowed: true };
    }

    const { memberCount, totalCount } = await countActiveIdentities(familyId);
    if ((role === 'owner' || role === 'member') && config.max_member_identities !== null && memberCount >= config.max_member_identities) {
      return {
        allowed: false,
        status: 409,
        code: 'MEMBER_LIMIT_EXCEEDED',
        message: 'Circle member limit has been reached',
        details: { limit: config.max_member_identities, current: memberCount },
      };
    }

    if (config.max_total_identities !== null && totalCount >= config.max_total_identities) {
      return {
        allowed: false,
        status: 409,
        code: 'TOTAL_USER_LIMIT_EXCEEDED',
        message: 'Circle user limit has been reached',
        details: { limit: config.max_total_identities, current: totalCount },
      };
    }

    return { allowed: true };
  }
}

export const familyIdentityQuotaService = new FamilyIdentityQuotaService();
