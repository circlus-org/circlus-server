import { pool, query, transaction } from '../index';

import type {
  FindByTokenResult,
  CreateInviteParams,
} from './inviteRepository.queries';
import type { EncryptedBlob } from '../../../../shared/types';
import type {
  LinkCapabilityDescriptor,
  LinkCapabilityMode,
  LinkCapabilityRevocation
} from '../../../../shared/linkCapability';

import {
  findByToken,
  findById,
  createInvite,
  incrementUsedCount,
  updateInviteStatus,
  findActiveInvites,
  findAllInvites,
  findByCreator,
  markExpiredInvites,
  countInvites,
  countActiveInvites,
} from './inviteRepository.queries';

export class InviteRepository {
  /**
   * Find invite by token
   */
  async findByToken(familyId: string, token: string): Promise<FindByTokenResult | null> {
    const results = await findByToken.run({ familyId, token }, pool);
    return results[0] || null;
  }

  async findByTokenAnyFamily(token: string): Promise<FindByTokenResult | null> {
    const result = await query<FindByTokenResult>(
      `SELECT *
       FROM invites
       WHERE token = $1
       LIMIT 1`,
      [token]
    );
    return result.rows[0] || null;
  }

  /**
   * Find invite by invite_id
   */
  async findById(familyId: string, inviteId: string): Promise<FindByTokenResult | null> {
    const results = await findById.run({ familyId, inviteId }, pool);
    return results[0] || null;
  }

  /**
   * Create new invite
   */
  async create(data: {
    familyId: string;
    inviteId: string;
    token: string;
    createdBy: string;
    expiresAt: Date;
    maxUses: number;
    title?: string | null;
    capabilityId?: string;
    capabilityMode?: LinkCapabilityMode;
    capabilityDescriptor?: LinkCapabilityDescriptor;
    encryptedSecret?: EncryptedBlob | null;
    encryptedMembershipCheckpointBundle?: EncryptedBlob | null;
  }): Promise<FindByTokenResult> {
    const params: CreateInviteParams & { familyId: string } = {
      familyId: data.familyId,
      inviteId: data.inviteId,
      token: data.token,
      createdBy: data.createdBy,
      expiresAt: data.expiresAt,
      maxUses: data.maxUses,
    };
    const results = await createInvite.run(params, pool);
    if (data.title) {
      await pool.query(
        `UPDATE invites SET title = $1 WHERE family_id = $2 AND invite_id = $3`,
        [data.title, data.familyId, data.inviteId]
      );
    }
    if (data.capabilityId && data.capabilityMode && data.capabilityDescriptor) {
      await pool.query(
        `UPDATE invites
         SET capability_id = $1,
             capability_public_key = $2,
             capability_mode = $3,
             capability_descriptor = $4::jsonb,
             encrypted_secret = $5::jsonb,
             encrypted_membership_checkpoint_bundle = $6::jsonb
         WHERE family_id = $7 AND invite_id = $8`,
        [
          data.capabilityId,
          data.capabilityDescriptor.payload.capabilityPublicKey.value,
          data.capabilityMode,
          JSON.stringify(data.capabilityDescriptor),
          data.encryptedSecret ? JSON.stringify(data.encryptedSecret) : null,
          data.encryptedMembershipCheckpointBundle ? JSON.stringify(data.encryptedMembershipCheckpointBundle) : null,
          data.familyId,
          data.inviteId
        ]
      );
    }
    const result = await this.findById(data.familyId, data.inviteId);
    return Object.assign(result || results[0], { title: data.title ?? null });
  }

  async createForMemberWithQuota(data: {
    familyId: string;
    inviteId: string;
    token: string;
    createdBy: string;
    expiresAt: Date;
    maxUses: number;
    title?: string | null;
    capabilityId?: string;
    capabilityMode?: LinkCapabilityMode;
    capabilityDescriptor?: LinkCapabilityDescriptor;
    encryptedSecret?: EncryptedBlob | null;
    encryptedMembershipCheckpointBundle?: EncryptedBlob | null;
  }): Promise<
    | { ok: true; invite: FindByTokenResult; remaining: number }
    | { ok: false }
  > {
    return transaction(async (client) => {
      const consume = await client.query<{ invite_quota: number; invite_used: number }>(
        `UPDATE identities
         SET invite_used = invite_used + 1
         WHERE identity_id = $1
           AND family_id = $2
           AND (invite_quota - invite_used) > 0
         RETURNING invite_quota, invite_used`,
        [data.createdBy, data.familyId]
      );

      if ((consume.rowCount || 0) === 0) {
        return { ok: false };
      }

      const created = await createInvite.run({
        inviteId: data.inviteId,
        token: data.token,
        familyId: data.familyId,
        createdBy: data.createdBy,
        expiresAt: data.expiresAt,
        maxUses: data.maxUses,
      }, client);
      if (data.title) {
        await client.query(
          `UPDATE invites SET title = $1 WHERE family_id = $2 AND invite_id = $3`,
          [data.title, data.familyId, data.inviteId]
        );
      }

      const { invite_quota, invite_used } = consume.rows[0];
      return {
        ok: true,
        invite: Object.assign(created[0], { title: data.title ?? null }),
        remaining: Math.max(0, invite_quota - invite_used),
      };
    });
  }

  async revokeOwnedInvite(data: {
    inviteId: string;
    familyId: string;
    identityId: string;
    unlimited: boolean;
    revocation?: LinkCapabilityRevocation;
  }): Promise<
    | { ok: true; invite: FindByTokenResult | null; remaining: number | null; deleted: boolean }
    | { ok: false; status: 404 | 400; code: 'NOT_FOUND' | 'INVALID_STATE'; message: string }
  > {
    return transaction(async (client) => {
      const inviteResult = await client.query<FindByTokenResult>(
        `SELECT *
         FROM invites
         WHERE invite_id = $1
           AND family_id = $2
           AND created_by = $3
         FOR UPDATE`,
        [data.inviteId, data.familyId, data.identityId]
      );

      if ((inviteResult.rowCount || 0) === 0) {
        return { ok: false as const, status: 404 as const, code: 'NOT_FOUND' as const, message: 'Invite not found' };
      }

      const invite = inviteResult.rows[0];
      if (invite.status !== 'active') {
        return { ok: false as const, status: 400 as const, code: 'INVALID_STATE' as const, message: `Invite is ${invite.status}` };
      }

      const revoked = await client.query<FindByTokenResult>(
        `UPDATE invites
         SET status = 'revoked',
             capability_revocation = COALESCE($3::jsonb, capability_revocation)
         WHERE invite_id = $1
           AND family_id = $2
         RETURNING *`,
        [
          data.inviteId,
          data.familyId,
          data.revocation ? JSON.stringify(data.revocation) : null
        ]
      );

      return { ok: true as const, invite: revoked.rows[0], remaining: null, deleted: false };
    });
  }

  /**
   * Increment used_count
   */
  async incrementUsedCount(familyId: string, inviteId: string): Promise<void> {
    await incrementUsedCount.run({ familyId, inviteId }, pool);
  }

  /**
   * Update invite status
   */
  async updateStatus(
    familyId: string,
    inviteId: string,
    status: 'active' | 'expired' | 'exhausted' | 'revoked'
  ): Promise<FindByTokenResult | null> {
    const results = await updateInviteStatus.run({ familyId, inviteId, status }, pool);
    return results[0] || null;
  }

  /**
   * Find active invites
   */
  async findActive(familyId: string): Promise<FindByTokenResult[]> {
    return await findActiveInvites.run({ familyId }, pool);
  }

  /**
   * Find all invites
   */
  async findAll(familyId: string): Promise<FindByTokenResult[]> {
    return await findAllInvites.run({ familyId }, pool);
  }

  /**
   * Find invites created by identity
   */
  async findByCreator(familyId: string, createdBy: string): Promise<FindByTokenResult[]> {
    return await findByCreator.run({ familyId, createdBy }, pool);
  }

  /**
   * Delete invite by invite_id
   */
  async delete(familyId: string, inviteId: string): Promise<void> {
    await pool.query(
      'DELETE FROM invites WHERE family_id = $1 AND invite_id = $2',
      [familyId, inviteId]
    );
  }

  /**
   * Mark expired invites
   */
  async markExpired(familyId: string): Promise<number> {
    const results = await markExpiredInvites.run({ familyId }, pool);
    return results.length;
  }

  /**
   * Count all invites
   */
  async count(familyId: string): Promise<number> {
    const results = await countInvites.run({ familyId }, pool);
    return parseInt(results[0].count ?? '0', 10);
  }

  /**
   * Count active invites
   */
  async countActive(familyId: string): Promise<number> {
    const results = await countActiveInvites.run({ familyId }, pool);
    return parseInt(results[0].count ?? '0', 10);
  }
}

export const inviteRepository = new InviteRepository();
