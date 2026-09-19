import type { PoolClient } from 'pg';
import { nanoid } from 'nanoid';
import { query, transaction } from '../index';

export type ManagedPushConfigurationRecord = {
  singleton_id: number;
  state: 'configured' | 'disabled';
  service_url: string | null;
  client_id: string | null;
  key_id: string | null;
  encrypted_shared_secret: Record<string, unknown> | null;
  config_fingerprint: string | null;
  provision_request_id: string | null;
  installed_at: Date | null;
  disabled_at: Date | null;
  updated_at: Date;
};

export type ManagedPushInstallClaimRecord = {
  claim_id: string;
  token_hash: string;
  status: 'pending' | 'consumed' | 'expired' | 'revoked';
  server_url: string;
  created_by_server_admin_id: string | null;
  expires_at: Date;
  created_at: Date;
  consumed_at: Date | null;
  provision_request_id: string | null;
  install_fingerprint: string | null;
};

export class ManagedPushConfigurationRepository {
  async getConfiguration(): Promise<ManagedPushConfigurationRecord | null> {
    const result = await query<ManagedPushConfigurationRecord>(
      'SELECT * FROM managed_push_configuration WHERE singleton_id = 1'
    );
    return result.rows[0] || null;
  }

  async createClaim(params: {
    tokenHash: string;
    serverUrl: string;
    createdByServerAdminId: string | null;
    expiresAt: Date;
  }): Promise<ManagedPushInstallClaimRecord> {
    await query(
      `UPDATE managed_push_install_claims SET status = 'expired'
       WHERE status = 'pending' AND expires_at <= NOW()`
    );
    const claimId = `mpc_${nanoid(18)}`;
    const result = await query<ManagedPushInstallClaimRecord>(
      `INSERT INTO managed_push_install_claims
       (claim_id, token_hash, server_url, created_by_server_admin_id, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [claimId, params.tokenHash, params.serverUrl, params.createdByServerAdminId, params.expiresAt]
    );
    return result.rows[0];
  }

  async findClaimByTokenHash(tokenHash: string): Promise<ManagedPushInstallClaimRecord | null> {
    const result = await query<ManagedPushInstallClaimRecord>(
      'SELECT * FROM managed_push_install_claims WHERE token_hash = $1',
      [tokenHash]
    );
    return result.rows[0] || null;
  }

  async install(params: {
    tokenHash: string;
    provisionRequestId: string;
    fingerprint: string;
    serviceUrl: string;
    clientId: string;
    keyId: string;
    encryptedSharedSecret: Record<string, unknown>;
  }): Promise<{ configuration: ManagedPushConfigurationRecord; repeated: boolean }> {
    return transaction(async (client) => this.installInTransaction(client, params));
  }

  private async installInTransaction(client: PoolClient, params: {
    tokenHash: string;
    provisionRequestId: string;
    fingerprint: string;
    serviceUrl: string;
    clientId: string;
    keyId: string;
    encryptedSharedSecret: Record<string, unknown>;
  }): Promise<{ configuration: ManagedPushConfigurationRecord; repeated: boolean }> {
    const claimResult = await client.query<ManagedPushInstallClaimRecord>(
      'SELECT * FROM managed_push_install_claims WHERE token_hash = $1 FOR UPDATE',
      [params.tokenHash]
    );
    const claim = claimResult.rows[0];
    if (!claim) throw new Error('INSTALL_CLAIM_INVALID');
    if (claim.status === 'consumed') {
      if (claim.provision_request_id !== params.provisionRequestId || claim.install_fingerprint !== params.fingerprint) {
        throw new Error('INSTALL_CLAIM_ALREADY_USED');
      }
      const existing = await client.query<ManagedPushConfigurationRecord>(
        'SELECT * FROM managed_push_configuration WHERE singleton_id = 1'
      );
      if (!existing.rows[0] || existing.rows[0].config_fingerprint !== params.fingerprint) {
        throw new Error('INSTALLED_CONFIGURATION_CHANGED');
      }
      return { configuration: existing.rows[0], repeated: true };
    }
    if (claim.status !== 'pending') throw new Error('INSTALL_CLAIM_INVALID');
    if (claim.expires_at.getTime() <= Date.now()) {
      await client.query(
        `UPDATE managed_push_install_claims SET status = 'expired' WHERE claim_id = $1`,
        [claim.claim_id]
      );
      throw new Error('INSTALL_CLAIM_EXPIRED');
    }

    const configResult = await client.query<ManagedPushConfigurationRecord>(
      `INSERT INTO managed_push_configuration (
         singleton_id, state, service_url, client_id, key_id, encrypted_shared_secret,
         config_fingerprint, provision_request_id, installed_at, disabled_at, updated_at
       ) VALUES (1, 'configured', $1, $2, $3, $4::jsonb, $5, $6, NOW(), NULL, NOW())
       ON CONFLICT (singleton_id) DO UPDATE SET
         state = 'configured', service_url = EXCLUDED.service_url,
         client_id = EXCLUDED.client_id, key_id = EXCLUDED.key_id,
         encrypted_shared_secret = EXCLUDED.encrypted_shared_secret,
         config_fingerprint = EXCLUDED.config_fingerprint,
         provision_request_id = EXCLUDED.provision_request_id,
         installed_at = NOW(), disabled_at = NULL, updated_at = NOW()
       RETURNING *`,
      [params.serviceUrl, params.clientId, params.keyId, JSON.stringify(params.encryptedSharedSecret),
        params.fingerprint, params.provisionRequestId]
    );
    await client.query(
      `UPDATE managed_push_install_claims
       SET status = 'consumed', consumed_at = NOW(), provision_request_id = $2, install_fingerprint = $3
       WHERE claim_id = $1`,
      [claim.claim_id, params.provisionRequestId, params.fingerprint]
    );
    return { configuration: configResult.rows[0], repeated: false };
  }

  async disable(params: { tokenHash: string; provisionRequestId: string; fingerprint: string }): Promise<ManagedPushConfigurationRecord> {
    return transaction(async (client) => {
      const claimResult = await client.query<ManagedPushInstallClaimRecord>(
        'SELECT * FROM managed_push_install_claims WHERE token_hash = $1 FOR UPDATE',
        [params.tokenHash]
      );
      const claim = claimResult.rows[0];
      if (!claim || claim.status !== 'consumed' || claim.provision_request_id !== params.provisionRequestId
        || claim.install_fingerprint !== params.fingerprint) throw new Error('INSTALL_AUTH_INVALID');
      const result = await client.query<ManagedPushConfigurationRecord>(
        `UPDATE managed_push_configuration SET
           state = 'disabled', service_url = NULL, client_id = NULL, key_id = NULL,
           encrypted_shared_secret = NULL, config_fingerprint = NULL,
           disabled_at = NOW(), updated_at = NOW()
         WHERE singleton_id = 1 AND provision_request_id = $1
         RETURNING *`,
        [params.provisionRequestId]
      );
      if (!result.rows[0]) throw new Error('INSTALLED_CONFIGURATION_CHANGED');
      return result.rows[0];
    });
  }
}

export const managedPushConfigurationRepository = new ManagedPushConfigurationRepository();
