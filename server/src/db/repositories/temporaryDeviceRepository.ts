import { pool, transaction } from '../index';
import type { PoolClient } from 'pg';
import type { DBTemporaryDevice } from '../types';

export type TempDeviceChatAccess = {
  temporary_device_id: string;
  family_id: string;
  chat_id: string;
  chat_type: 'group' | 'direct';
  created_at: number;
};

export type TempDeviceGroupChatKeyEnvelope = {
  temporary_device_id: string;
  family_id: string;
  chat_id: string;
  epoch: number;
  envelope_ciphertext: string;
  publisher_identity_id: string;
  publisher_enc_public_key_algo: string;
  publisher_enc_public_key_value: string;
  created_at: number;
};

export type TempDeviceDirectChatKeyEnvelope = {
  temporary_device_id: string;
  family_id: string;
  direct_chat_id: string;
  epoch: number;
  envelope_ciphertext: string;
  publisher_identity_id: string;
  publisher_enc_public_key_algo: string;
  publisher_enc_public_key_value: string;
  created_at: number;
};
import type { FindTemporaryDeviceByDeviceIdResult } from './temporaryDeviceRepository.queries';
import {
  findTemporaryDeviceByDeviceId,
  findTemporaryDeviceByDeviceIdAnyFamily,
  findTemporaryDeviceByPublicKey,
  findTemporaryDevicesByIdentityId,
  createOrRefreshTemporaryDevice,
  updateTemporaryDeviceLastSeen,
  updateTemporaryDeviceStatus,
  expireStaleTemporaryDevices,
} from './temporaryDeviceRepository.queries';

type DbExecutor = Pick<PoolClient, 'query'>;

function mapTemporaryDevice(row: FindTemporaryDeviceByDeviceIdResult): DBTemporaryDevice {
  return {
    id: row.id,
    device_id: row.device_id,
    identity_id: row.identity_id,
    family_id: row.family_id,
    public_key_algorithm: row.public_key_algorithm as 'ed25519' | 'x25519',
    public_key_value: row.public_key_value,
    encryption_public_key_algorithm: (row as any).encryption_public_key_algorithm ?? null,
    encryption_public_key_value: (row as any).encryption_public_key_value ?? null,
    approved_by_device_id: row.approved_by_device_id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    status: row.status as DBTemporaryDevice['status'],
    can_call: (row as any).can_call === true
  };
}

export class TemporaryDeviceRepository {
  async findByDeviceId(familyId: string, deviceId: string): Promise<DBTemporaryDevice | null> {
    const results = await findTemporaryDeviceByDeviceId.run({ familyId, deviceId }, pool);
    return results[0] ? mapTemporaryDevice(results[0]) : null;
  }

  async findByDeviceIds(familyId: string, deviceIds: string[]): Promise<DBTemporaryDevice[]> {
    if (deviceIds.length === 0) return [];

    const result = await pool.query<FindTemporaryDeviceByDeviceIdResult>(
      `SELECT *
       FROM temporary_devices
       WHERE family_id = $1
         AND device_id = ANY($2::text[])`,
      [familyId, deviceIds]
    );
    return result.rows.map(mapTemporaryDevice);
  }

  async findByDeviceIdAnyFamily(deviceId: string): Promise<DBTemporaryDevice | null> {
    const results = await findTemporaryDeviceByDeviceIdAnyFamily.run({ deviceId }, pool);
    return results[0] ? mapTemporaryDevice(results[0]) : null;
  }

  async findByPublicKey(familyId: string, publicKeyValue: string): Promise<DBTemporaryDevice | null> {
    const results = await findTemporaryDeviceByPublicKey.run({ familyId, publicKeyValue }, pool);
    return results[0] ? mapTemporaryDevice(results[0]) : null;
  }

  async findByIdentityId(familyId: string, identityId: string): Promise<DBTemporaryDevice[]> {
    const results = await findTemporaryDevicesByIdentityId.run({ familyId, identityId }, pool);
    return results.map(mapTemporaryDevice);
  }

  async createOrRefresh(data: {
    familyId: string;
    deviceId: string;
    identityId: string;
    publicKeyAlgorithm: 'ed25519' | 'x25519';
    publicKeyValue: string;
    encryptionPublicKeyAlgorithm?: 'x25519' | null;
    encryptionPublicKeyValue?: string | null;
    approvedByDeviceId: string;
    expiresAt: Date;
  }, db: DbExecutor = pool): Promise<DBTemporaryDevice> {
    const results = await createOrRefreshTemporaryDevice.run({
      deviceId: data.deviceId,
      identityId: data.identityId,
      familyId: data.familyId,
      publicKeyAlgorithm: data.publicKeyAlgorithm,
      publicKeyValue: data.publicKeyValue,
      encryptionPublicKeyAlgorithm: data.encryptionPublicKeyAlgorithm ?? null,
      encryptionPublicKeyValue: data.encryptionPublicKeyValue ?? null,
      approvedByDeviceId: data.approvedByDeviceId,
      expiresAt: data.expiresAt,
    } as any, db as any);
    return mapTemporaryDevice(results[0]);
  }

  async updateLastSeen(familyId: string, deviceId: string): Promise<void> {
    await updateTemporaryDeviceLastSeen.run({ familyId, deviceId }, pool);
  }

  async setCallCapability(familyId: string, deviceId: string, canCall: boolean, db: DbExecutor = pool): Promise<void> {
    await db.query(
      `UPDATE temporary_devices SET can_call = $3 WHERE family_id = $1 AND device_id = $2`,
      [familyId, deviceId, canCall]
    );
  }

  async updateStatus(familyId: string, deviceId: string, status: 'active' | 'revoked' | 'expired'): Promise<DBTemporaryDevice | null> {
    const results = await updateTemporaryDeviceStatus.run({ familyId, deviceId, status }, pool);
    return results[0] ? mapTemporaryDevice(results[0]) : null;
  }

  async expireStale(): Promise<number> {
    const results = await expireStaleTemporaryDevices.run(undefined as never, pool);
    return results.length;
  }

  async storeChatAccess(familyId: string, temporaryDeviceId: string, items: { chatId: string; chatType: 'group' | 'direct' }[], db: DbExecutor = pool): Promise<void> {
    if (items.length === 0) return;
    const now = Date.now();
    for (const item of items) {
      await db.query(
        `INSERT INTO temporary_device_chat_access (temporary_device_id, family_id, chat_id, chat_type, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (temporary_device_id, chat_id) DO NOTHING`,
        [temporaryDeviceId, familyId, item.chatId, item.chatType, now]
      );
    }
  }

  async getChatAccess(familyId: string, temporaryDeviceId: string): Promise<TempDeviceChatAccess[]> {
    const result = await pool.query<TempDeviceChatAccess>(
      `SELECT temporary_device_id, family_id, chat_id, chat_type, created_at
       FROM temporary_device_chat_access
       WHERE family_id = $1 AND temporary_device_id = $2`,
      [familyId, temporaryDeviceId]
    );
    return result.rows;
  }

  async getChatAccessForDevices(familyId: string, temporaryDeviceIds: string[]): Promise<TempDeviceChatAccess[]> {
    if (temporaryDeviceIds.length === 0) return [];

    const result = await pool.query<TempDeviceChatAccess>(
      `SELECT temporary_device_id, family_id, chat_id, chat_type, created_at
       FROM temporary_device_chat_access
       WHERE family_id = $1
         AND temporary_device_id = ANY($2::text[])`,
      [familyId, temporaryDeviceIds]
    );
    return result.rows;
  }

  async hasChatAccess(familyId: string, temporaryDeviceId: string, chatId: string, chatType: 'group' | 'direct'): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1
       FROM temporary_device_chat_access
       WHERE family_id = $1 AND temporary_device_id = $2 AND chat_id = $3 AND chat_type = $4
       LIMIT 1`,
      [familyId, temporaryDeviceId, chatId, chatType]
    );
    return (result.rowCount || 0) > 0;
  }

  async deleteChatAccess(familyId: string, temporaryDeviceId: string): Promise<void> {
    await pool.query(
      `DELETE FROM temporary_device_chat_access WHERE family_id = $1 AND temporary_device_id = $2`,
      [familyId, temporaryDeviceId]
    );
    await pool.query(
      `DELETE FROM temporary_device_group_chat_key_envelopes WHERE family_id = $1 AND temporary_device_id = $2`,
      [familyId, temporaryDeviceId]
    );
    await pool.query(
      `DELETE FROM temporary_device_direct_chat_key_envelopes WHERE family_id = $1 AND temporary_device_id = $2`,
      [familyId, temporaryDeviceId]
    );
  }

  async upsertGroupChatKeyEnvelope(params: {
    temporaryDeviceId: string;
    familyId: string;
    chatId: string;
    epoch: number;
    envelopeCiphertext: string;
    publisherIdentityId: string;
    publisherEncPublicKeyAlgo: string;
    publisherEncPublicKeyValue: string;
  }, db: DbExecutor = pool): Promise<void> {
    await db.query(
      `INSERT INTO temporary_device_group_chat_key_envelopes
         (temporary_device_id, family_id, chat_id, epoch, envelope_ciphertext, publisher_identity_id, publisher_enc_public_key_algo, publisher_enc_public_key_value, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (temporary_device_id, chat_id, epoch) DO UPDATE SET
         envelope_ciphertext = EXCLUDED.envelope_ciphertext,
         publisher_identity_id = EXCLUDED.publisher_identity_id,
         publisher_enc_public_key_algo = EXCLUDED.publisher_enc_public_key_algo,
         publisher_enc_public_key_value = EXCLUDED.publisher_enc_public_key_value`,
      [params.temporaryDeviceId, params.familyId, params.chatId, params.epoch, params.envelopeCiphertext, params.publisherIdentityId, params.publisherEncPublicKeyAlgo, params.publisherEncPublicKeyValue, Date.now()]
    );
  }

  async upsertDirectChatKeyEnvelope(params: {
    temporaryDeviceId: string;
    familyId: string;
    directChatId: string;
    epoch: number;
    envelopeCiphertext: string;
    publisherIdentityId: string;
    publisherEncPublicKeyAlgo: string;
    publisherEncPublicKeyValue: string;
  }, db: DbExecutor = pool): Promise<void> {
    await db.query(
      `INSERT INTO temporary_device_direct_chat_key_envelopes
         (temporary_device_id, family_id, direct_chat_id, epoch, envelope_ciphertext, publisher_identity_id, publisher_enc_public_key_algo, publisher_enc_public_key_value, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (temporary_device_id, direct_chat_id, epoch) DO UPDATE SET
         envelope_ciphertext = EXCLUDED.envelope_ciphertext,
         publisher_identity_id = EXCLUDED.publisher_identity_id,
         publisher_enc_public_key_algo = EXCLUDED.publisher_enc_public_key_algo,
         publisher_enc_public_key_value = EXCLUDED.publisher_enc_public_key_value`,
      [params.temporaryDeviceId, params.familyId, params.directChatId, params.epoch, params.envelopeCiphertext, params.publisherIdentityId, params.publisherEncPublicKeyAlgo, params.publisherEncPublicKeyValue, Date.now()]
    );
  }

  async findGroupChatKeyEnvelopes(familyId: string, temporaryDeviceId: string, chatIds: string[]): Promise<TempDeviceGroupChatKeyEnvelope[]> {
    if (chatIds.length === 0) return [];
    const result = await pool.query<TempDeviceGroupChatKeyEnvelope>(
      `SELECT temporary_device_id, family_id, chat_id, epoch, envelope_ciphertext, publisher_identity_id, publisher_enc_public_key_algo, publisher_enc_public_key_value, created_at
       FROM temporary_device_group_chat_key_envelopes
       WHERE family_id = $1 AND temporary_device_id = $2 AND chat_id = ANY($3)`,
      [familyId, temporaryDeviceId, chatIds]
    );
    return result.rows;
  }

  async findDirectChatKeyEnvelopes(familyId: string, temporaryDeviceId: string, directChatIds: string[]): Promise<TempDeviceDirectChatKeyEnvelope[]> {
    if (directChatIds.length === 0) return [];
    const result = await pool.query<TempDeviceDirectChatKeyEnvelope>(
      `SELECT temporary_device_id, family_id, direct_chat_id, epoch, envelope_ciphertext, publisher_identity_id, publisher_enc_public_key_algo, publisher_enc_public_key_value, created_at
       FROM temporary_device_direct_chat_key_envelopes
       WHERE family_id = $1 AND temporary_device_id = $2 AND direct_chat_id = ANY($3)`,
      [familyId, temporaryDeviceId, directChatIds]
    );
    return result.rows;
  }

  async findDirectChatKeyEnvelope(
    familyId: string,
    temporaryDeviceId: string,
    directChatId: string,
    epoch: number
  ): Promise<TempDeviceDirectChatKeyEnvelope | null> {
    const result = await pool.query<TempDeviceDirectChatKeyEnvelope>(
      `SELECT temporary_device_id, family_id, direct_chat_id, epoch, envelope_ciphertext, publisher_identity_id, publisher_enc_public_key_algo, publisher_enc_public_key_value, created_at
       FROM temporary_device_direct_chat_key_envelopes
       WHERE family_id = $1 AND temporary_device_id = $2 AND direct_chat_id = $3 AND epoch = $4
       LIMIT 1`,
      [familyId, temporaryDeviceId, directChatId, epoch]
    );
    return result.rows[0] || null;
  }

  async storeApprovalAttestation(familyId: string, deviceId: string, attestation: {
    payload: string;
    signature: string;
    approvingDevicePublicKey: string;
  }, db: DbExecutor = pool): Promise<void> {
    await db.query(
      `UPDATE temporary_devices
       SET approval_attestation_payload = $1, approval_attestation_signature = $2, approving_device_public_key = $3
       WHERE family_id = $4 AND device_id = $5`,
      [attestation.payload, attestation.signature, attestation.approvingDevicePublicKey, familyId, deviceId]
    );
  }

  async findApprovedTempDevicesForChat(familyId: string, approvedByDeviceId: string, chatId: string, chatType: 'group' | 'direct'): Promise<{
    device_id: string;
    encryption_public_key_algorithm: string | null;
    encryption_public_key_value: string | null;
    approval_attestation_payload: string | null;
    approval_attestation_signature: string | null;
    approving_device_public_key: string | null;
  }[]> {
    const result = await pool.query<{
      device_id: string;
      encryption_public_key_algorithm: string | null;
      encryption_public_key_value: string | null;
      approval_attestation_payload: string | null;
      approval_attestation_signature: string | null;
      approving_device_public_key: string | null;
    }>(
      `SELECT td.device_id, td.encryption_public_key_algorithm, td.encryption_public_key_value,
              td.approval_attestation_payload, td.approval_attestation_signature, td.approving_device_public_key
       FROM temporary_devices td
       JOIN temporary_device_chat_access tca ON tca.temporary_device_id = td.device_id AND tca.family_id = td.family_id
       WHERE td.family_id = $1
         AND td.approved_by_device_id = $2
         AND tca.chat_id = $3
         AND tca.chat_type = $4
         AND td.status = 'active'
         AND td.expires_at > NOW()
         AND td.encryption_public_key_value IS NOT NULL`,
      [familyId, approvedByDeviceId, chatId, chatType]
    );
    return result.rows;
  }

  async findExpiredActiveTemporaryDevices(): Promise<{ device_id: string; family_id: string }[]> {
    const result = await pool.query<{ device_id: string; family_id: string }>(
      `SELECT device_id, family_id FROM temporary_devices
       WHERE expires_at <= NOW()
         AND (
           status = 'active'
           OR EXISTS (
             SELECT 1 FROM temporary_device_chat_access access
             WHERE access.family_id = temporary_devices.family_id
               AND access.temporary_device_id = temporary_devices.device_id
           )
         )`
    );
    return result.rows;
  }

  async terminateAccessAndRotateEpochs(
    familyId: string,
    temporaryDeviceId: string,
    status: 'revoked' | 'expired'
  ): Promise<Array<{ chat_id: string; key_epoch: number }>> {
    return transaction(async client => {
    const rotatedGroups: Array<{ chat_id: string; key_epoch: number }> = [];

      await client.query(
        `SELECT device_id FROM temporary_devices
         WHERE family_id = $1 AND device_id = $2
         FOR UPDATE`,
        [familyId, temporaryDeviceId]
      );
      const access = await client.query<TempDeviceChatAccess>(
        `SELECT temporary_device_id, family_id, chat_id, chat_type, created_at
         FROM temporary_device_chat_access
         WHERE family_id = $1 AND temporary_device_id = $2
         FOR UPDATE`,
        [familyId, temporaryDeviceId]
      );
      const now = Date.now();
      for (const item of access.rows) {
        if (item.chat_type === 'group') {
          const update = await client.query<{ key_epoch: number }>(
            `UPDATE group_chats
             SET key_epoch = key_epoch + 1, updated_at = $3, key_epoch_updated_at = $3
             WHERE family_id = $1 AND chat_id = $2
             RETURNING key_epoch`,
            [familyId, item.chat_id, now]
          );
          if (update.rows[0]) {
            rotatedGroups.push({ chat_id: item.chat_id, key_epoch: Number(update.rows[0].key_epoch) });
          }
        } else {
          await client.query(
            `INSERT INTO direct_chat_epoch_state (family_id, direct_chat_id, current_epoch, updated_at)
             VALUES ($1, $2, 2, $3)
             ON CONFLICT (family_id, direct_chat_id)
             DO UPDATE SET current_epoch = direct_chat_epoch_state.current_epoch + 1,
                           updated_at = EXCLUDED.updated_at`,
            [familyId, item.chat_id, now]
          );
        }
      }
      await client.query(
        `DELETE FROM temporary_device_group_chat_key_envelopes WHERE family_id = $1 AND temporary_device_id = $2`,
        [familyId, temporaryDeviceId]
      );
      await client.query(
        `DELETE FROM temporary_device_direct_chat_key_envelopes WHERE family_id = $1 AND temporary_device_id = $2`,
        [familyId, temporaryDeviceId]
      );
      await client.query(
        `DELETE FROM temporary_device_chat_access WHERE family_id = $1 AND temporary_device_id = $2`,
        [familyId, temporaryDeviceId]
      );
      await client.query(
        `UPDATE temporary_devices SET status = $3 WHERE family_id = $1 AND device_id = $2`,
        [familyId, temporaryDeviceId, status]
      );
      return rotatedGroups;
    });
  }
}

export const temporaryDeviceRepository = new TemporaryDeviceRepository();
