import { pool } from '../index';
import type { IdentityId } from '@shared/types';

import type {
  FindByIdentityIdResult,
  CreateVaultParams,
  UpsertVaultParams,
} from './vaultRepository.queries';

import {
  findByIdentityId,
  createVault,
  upsertVault,
  deleteVault,
  updateVaultStatus,
} from './vaultRepository.queries';

export class VaultRepository {
  async compareAndSet(familyId: string, identityId: IdentityId, encryptedVault: unknown, expectedRevision: number): Promise<FindByIdentityIdResult | null> {
    const result = expectedRevision === 0
      ? await pool.query(`INSERT INTO vaults (family_id,identity_id,encrypted_vault,revision) VALUES ($1,$2,$3::jsonb,1) ON CONFLICT DO NOTHING RETURNING *`, [familyId,identityId,JSON.stringify(encryptedVault)])
      : await pool.query(`UPDATE vaults SET encrypted_vault=$3::jsonb,revision=revision+1,updated_at=NOW()
          WHERE family_id=$1 AND identity_id=$2 AND revision=$4 RETURNING *`, [familyId,identityId,JSON.stringify(encryptedVault),expectedRevision]);
    return result.rows[0] || null;
  }

  /**
   * Find vault by identity_id
   */
  async findByIdentityId(familyId: string, identityId: IdentityId): Promise<FindByIdentityIdResult | null> {
    const results = await findByIdentityId.run({ familyId, identityId }, pool);
    return results[0] || null;
  }

  /**
   * Create new vault
   */
  async create(data: {
    familyId: string;
    identityId: IdentityId;
    encryptedVault: any;
    revision?: number;
  }): Promise<FindByIdentityIdResult> {
    const params: CreateVaultParams & { familyId: string } = {
      familyId: data.familyId,
      identityId: data.identityId,
      encryptedVault: JSON.stringify(data.encryptedVault),
      revision: data.revision || 1,
    };
    const results = await createVault.run(params, pool);
    return results[0];
  }

  /**
   * Update vault (upsert)
   */
  async upsert(data: {
    familyId: string;
    identityId: IdentityId;
    encryptedVault: any;
    revision?: number;
  }): Promise<FindByIdentityIdResult> {
    const params: UpsertVaultParams & { familyId: string } = {
      familyId: data.familyId,
      identityId: data.identityId,
      encryptedVault: JSON.stringify(data.encryptedVault),
      revision: data.revision || 1,
    };
    const results = await upsertVault.run(params, pool);
    return results[0];
  }

  /**
   * Delete vault
   */
  async delete(familyId: string, identityId: IdentityId): Promise<void> {
    await deleteVault.run({ familyId, identityId }, pool);
  }

  /**
   * Update status
   */
  async updateStatus(
    familyId: string,
    identityId: IdentityId,
    status: 'present' | 'absent'
  ): Promise<void> {
    await updateVaultStatus.run({ familyId, identityId, status }, pool);
  }
}

export const vaultRepository = new VaultRepository();
