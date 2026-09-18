import { nanoid } from 'nanoid';
import type { PoolClient } from 'pg';
import type {
  CircleOwnerChangeMethod,
  CircleOwnerRecoveryAcceptance,
  CircleMembershipStateRecord,
  DeviceRecord,
  IdentityRecord,
  PublicKey,
  RegisterDevicePayload,
  SignedRequest,
  SystemEventCircleOwnerChangedPayload
} from '@shared/types';
import { deriveIdentityIdFromPublicKey } from '../../../shared/identityId';
import { transaction } from '../db';
import { verifySignedRequest } from '../utils/crypto';
import { sendCircleOwnerChangedPush } from '../utils/push';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';
import { appendCircleMembershipState } from './circleMembershipStateService';

export const OWNER_ROLE_DOCUMENT_VERSION = '2026-08-16';

export class CircleOwnershipError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

type OwnershipChangeResult = {
  changeId: string;
  familyId: string;
  circleName: string;
  previousOwnerIdentityId: string;
  newOwnerIdentityId: string;
  recipients: string[];
  method: CircleOwnerChangeMethod;
  changedAt: string;
};

type NewOwnerMaterial = {
  identityId: string;
  identityPublicKey: PublicKey;
  identityName: string | null;
  publishIdentity: boolean;
  encryptedIdentityPrivateKey: unknown | null;
  deviceRegistration: SignedRequest<RegisterDevicePayload, string>;
  devicePayload: RegisterDevicePayload;
};

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 160) : null;
}

async function validateNewOwnerAcceptance(params: {
  acceptance: CircleOwnerRecoveryAcceptance;
  familyId: string;
  expectedOwnerIdentityId: string;
  recoveryClaimId?: string;
  expectedCircleId: string;
  expectedVpsId: string;
}): Promise<NewOwnerMaterial> {
  const { acceptance } = params;
  const payload = acceptance?.payload;
  if (
    !acceptance?.signature
    || acceptance.type !== 'circle-owner:recovery:accept'
    || payload?.version !== 1
    || payload?.purpose !== 'circle-owner-recovery-v1'
    || payload.familyId !== params.familyId
    || acceptance.circleId !== params.expectedCircleId
    || acceptance.vpsId !== params.expectedVpsId
    || payload.expectedOwnerIdentityId !== params.expectedOwnerIdentityId
    || (params.recoveryClaimId && payload.recoveryClaimId !== params.recoveryClaimId)
    || (!params.recoveryClaimId && payload.recoveryClaimId)
  ) {
    throw new CircleOwnershipError(400, 'INVALID_REQUEST', 'Invalid owner recovery acceptance');
  }
  if (payload.identityPublicKey?.algorithm !== 'ed25519') {
    throw new CircleOwnershipError(400, 'INVALID_REQUEST', 'Owner identity must use Ed25519');
  }
  const identityId = await deriveIdentityIdFromPublicKey(payload.identityPublicKey);
  if (acceptance.signerId !== identityId || !verifySignedRequest(acceptance, payload.identityPublicKey)) {
    throw new CircleOwnershipError(401, 'INVALID_SIGNATURE', 'Invalid new owner identity signature');
  }

  const registration = payload.deviceRegistration;
  const device = registration?.payload;
  if (
    !registration?.signature
    || registration.type !== 'auth:register-device'
    || registration.signerId !== identityId
    || registration.circleId !== params.expectedCircleId
    || registration.vpsId !== params.expectedVpsId
    || !verifySignedRequest(registration, payload.identityPublicKey)
    || !device?.deviceId
    || !/^device-[A-Za-z0-9_-]{8,80}$/.test(device.deviceId)
    || device.devicePublicKey?.algorithm !== 'ed25519'
    || (device.deviceEncryptionPublicKey && device.deviceEncryptionPublicKey.algorithm !== 'x25519')
  ) {
    throw new CircleOwnershipError(401, 'INVALID_SIGNATURE', 'Invalid new owner device registration');
  }

  if (device.deviceEncryptionPublicKey) {
    const binding = device.deviceKeyBinding;
    const bindingPayload = binding?.payload;
    const matches = binding?.type === 'device:key-binding'
      && bindingPayload?.version === 1
      && bindingPayload?.purpose === 'device-key-binding-v1'
      && bindingPayload.identityId === identityId
      && bindingPayload.devicePublicKey?.algorithm === device.devicePublicKey.algorithm
      && bindingPayload.devicePublicKey?.value === device.devicePublicKey.value
      && bindingPayload.deviceEncryptionPublicKey?.algorithm === device.deviceEncryptionPublicKey.algorithm
      && bindingPayload.deviceEncryptionPublicKey?.value === device.deviceEncryptionPublicKey.value;
    if (!matches || !binding || !verifySignedRequest(binding, device.devicePublicKey)) {
      throw new CircleOwnershipError(401, 'INVALID_SIGNATURE', 'Invalid new owner device key binding');
    }
  }

  return {
    identityId,
    identityPublicKey: payload.identityPublicKey,
    identityName: null,
    publishIdentity: false,
    encryptedIdentityPrivateKey: payload.encryptedIdentityPrivateKey || null,
    deviceRegistration: registration,
    devicePayload: device
  };
}

async function lockCircle(client: PoolClient, familyId: string, expectedOwnerIdentityId: string) {
  const configResult = await client.query<{
    owner_identity_id: string | null;
    circle_id: string;
    server_name: string;
    public_base_url: string;
    status: string;
    no_names_on_server: boolean;
    max_member_identities: number | null;
    max_total_identities: number | null;
  }>(
    `SELECT owner_identity_id, circle_id, server_name, public_base_url, status,
            no_names_on_server, max_member_identities, max_total_identities
       FROM family_config
      WHERE family_id = $1
      FOR UPDATE`,
    [familyId]
  );
  const config = configResult.rows[0];
  if (!config) throw new CircleOwnershipError(404, 'NOT_FOUND', 'Circle not found');
  if (config.status !== 'active') throw new CircleOwnershipError(409, 'INVALID_STATE', 'Circle is not active');
  if (config.owner_identity_id !== expectedOwnerIdentityId) {
    throw new CircleOwnershipError(409, 'OWNER_CHANGED', 'Circle owner changed after recovery was started');
  }
  return config;
}

async function recordChangeAndEvents(client: PoolClient, params: {
  familyId: string;
  circleName: string;
  publicBaseUrl: string;
  previousOwnerIdentityId: string;
  previousOwnerIdentityName: string | null;
  newOwnerIdentityId: string;
  newOwnerIdentityName: string | null;
  method: CircleOwnerChangeMethod;
  initiatedByIdentityId: string;
  initiatedByDeviceId: string;
  initiatedByServerAdminId?: string | null;
  recoveryClaimId?: string | null;
  signedAuthorization: unknown;
}): Promise<OwnershipChangeResult> {
  const changeId = `ownchg_${nanoid(18)}`;
  const changedAt = new Date();
  await client.query(
    `INSERT INTO circle_owner_changes (
       change_id, family_id, previous_owner_identity_id, new_owner_identity_id,
       method, initiated_by_identity_id, initiated_by_device_id,
       initiated_by_server_admin_id, recovery_claim_id, signed_authorization,
       owner_role_document_version, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
    [
      changeId,
      params.familyId,
      params.previousOwnerIdentityId,
      params.newOwnerIdentityId,
      params.method,
      params.initiatedByIdentityId,
      params.initiatedByDeviceId,
      params.initiatedByServerAdminId || null,
      params.recoveryClaimId || null,
      JSON.stringify(params.signedAuthorization),
      OWNER_ROLE_DOCUMENT_VERSION,
      changedAt.toISOString()
    ]
  );

  const recipientsResult = await client.query<{ identity_id: string }>(
    `SELECT identity_id
       FROM identities
      WHERE family_id = $1
        AND status = 'active'
        AND role IN ('owner', 'member')`,
    [params.familyId]
  );
  const recipients = recipientsResult.rows.map((row) => row.identity_id);
  const payload: SystemEventCircleOwnerChangedPayload = {
    ownershipChangeId: changeId,
    circleName: params.circleName,
    previousOwnerIdentityId: params.previousOwnerIdentityId,
    previousOwnerIdentityName: params.previousOwnerIdentityName || undefined,
    newOwnerIdentityId: params.newOwnerIdentityId,
    newOwnerIdentityName: params.newOwnerIdentityName || undefined,
    method: params.method,
    initiatedByIdentityId: params.initiatedByIdentityId,
    changedAt: changedAt.toISOString(),
    ownerRoleDocumentVersion: OWNER_ROLE_DOCUMENT_VERSION
  };
  const circleConfig = await client.query<{ circle_id: string }>(
    'SELECT circle_id FROM family_config WHERE family_id = $1',
    [params.familyId]
  );
  const circleId = circleConfig.rows[0]?.circle_id;
  if (!circleId) throw new Error('Circle identity is not configured');
  const createdAt = changedAt.getTime();
  for (const recipientIdentityId of recipients) {
    await client.query(
      `INSERT INTO system_events (
         event_id, family_id, recipient_identity_id, circle_id, type, payload, created_at
       ) VALUES ($1, $2, $3, $4, 'circle:owner-changed', $5::jsonb, $6)`,
      [`sev_owner_${nanoid(18)}`, params.familyId, recipientIdentityId, circleId, JSON.stringify(payload), createdAt]
    );
  }

  return {
    changeId,
    familyId: params.familyId,
    circleName: params.circleName,
    previousOwnerIdentityId: params.previousOwnerIdentityId,
    newOwnerIdentityId: params.newOwnerIdentityId,
    recipients,
    method: params.method,
    changedAt: changedAt.toISOString()
  };
}

export async function changeCircleOwnerToExistingIdentity(params: {
  familyId: string;
  expectedOwnerIdentityId: string;
  newOwnerIdentityId: string;
  method: CircleOwnerChangeMethod;
  initiatedByIdentityId: string;
  initiatedByDeviceId: string;
  initiatedByServerAdminId?: string | null;
  signedAuthorization: unknown;
  membershipState?: CircleMembershipStateRecord;
}): Promise<OwnershipChangeResult> {
  if (!params.newOwnerIdentityId || params.newOwnerIdentityId === params.expectedOwnerIdentityId) {
    throw new CircleOwnershipError(400, 'INVALID_REQUEST', 'Select another active Circle member');
  }
  if (params.method === 'voluntary_transfer'
    && (!params.membershipState
      || params.membershipState.claim?.payload?.action !== 'transfer_owner'
      || params.membershipState.claim.signerId !== params.expectedOwnerIdentityId
      || params.membershipState.claim.payload.subjectIdentityId !== params.newOwnerIdentityId
      || params.membershipState.claim.payload.ownerIdentityId !== params.newOwnerIdentityId)) {
    throw new CircleOwnershipError(400, 'INVALID_REQUEST', 'Signed ownership transition does not match the transfer');
  }
  return transaction(async (client) => {
    const config = await lockCircle(client, params.familyId, params.expectedOwnerIdentityId);
    const identities = await client.query<{ identity_id: string; identity_name: string | null; role: string; status: string }>(
      `SELECT identity_id, identity_name, role, status
         FROM identities
        WHERE family_id = $1 AND identity_id = ANY($2::text[])
        FOR UPDATE`,
      [params.familyId, [params.expectedOwnerIdentityId, params.newOwnerIdentityId]]
    );
    const previous = identities.rows.find((row) => row.identity_id === params.expectedOwnerIdentityId);
    const target = identities.rows.find((row) => row.identity_id === params.newOwnerIdentityId);
    if (!previous || previous.role !== 'owner') {
      throw new CircleOwnershipError(409, 'INVALID_STATE', 'Recorded owner identity is inconsistent');
    }
    if (!target || target.status !== 'active' || target.role !== 'member') {
      throw new CircleOwnershipError(409, 'INVALID_STATE', 'New owner must be an active Circle member');
    }
    if (params.membershipState) {
      await appendCircleMembershipState({ familyId: params.familyId, record: params.membershipState, client });
    }
    await client.query(`UPDATE identities SET role = 'member' WHERE family_id = $1 AND identity_id = $2`, [params.familyId, previous.identity_id]);
    await client.query(`UPDATE identities SET role = 'owner' WHERE family_id = $1 AND identity_id = $2`, [params.familyId, target.identity_id]);
    await client.query(`UPDATE family_config SET owner_identity_id = $2, updated_at = NOW() WHERE family_id = $1`, [params.familyId, target.identity_id]);
    await client.query(
      `UPDATE circle_owner_recovery_claims SET status = 'revoked'
        WHERE family_id = $1 AND status = 'pending'`,
      [params.familyId]
    );
    return recordChangeAndEvents(client, {
      ...params,
      previousOwnerIdentityId: params.expectedOwnerIdentityId,
      circleName: config.server_name,
      publicBaseUrl: config.public_base_url,
      previousOwnerIdentityName: null,
      newOwnerIdentityName: null
    });
  });
}

export async function recoverCircleOwnerWithNewIdentity(params: {
  familyId: string;
  expectedOwnerIdentityId: string;
  acceptance: CircleOwnerRecoveryAcceptance;
  initiatedByIdentityId: string;
  initiatedByDeviceId: string;
  initiatedByServerAdminId: string;
  signedAuthorization: unknown;
  recoveryClaim?: { claimId: string; tokenHash: string };
}): Promise<OwnershipChangeResult & { identity: IdentityRecord; device: DeviceRecord }> {
  return transaction(async (client) => {
    const config = await lockCircle(client, params.familyId, params.expectedOwnerIdentityId);
    const material = await validateNewOwnerAcceptance({
      acceptance: params.acceptance,
      familyId: params.familyId,
      expectedOwnerIdentityId: params.expectedOwnerIdentityId,
      recoveryClaimId: params.recoveryClaim?.claimId,
      expectedCircleId: config.circle_id,
      expectedVpsId: getServerIdentityRuntimeConfig().vpsId
    });
    let claimAuthorization: unknown = null;
    if (params.recoveryClaim) {
      const claimResult = await client.query<{
        claim_id: string;
        family_id: string;
        expected_owner_identity_id: string;
        created_by_server_admin_id: string;
        created_authorization: unknown;
        status: string;
        expires_at: Date;
      }>(
        `SELECT claim_id, family_id, expected_owner_identity_id, created_by_server_admin_id,
                created_authorization, status, expires_at
           FROM circle_owner_recovery_claims
          WHERE token_hash = $1
          FOR UPDATE`,
        [params.recoveryClaim.tokenHash]
      );
      const claim = claimResult.rows[0];
      if (!claim || claim.claim_id !== params.recoveryClaim.claimId || claim.family_id !== params.familyId) {
        throw new CircleOwnershipError(404, 'NOT_FOUND', 'Owner recovery claim not found');
      }
      if (claim.status !== 'pending') throw new CircleOwnershipError(409, 'INVALID_STATE', `Owner recovery claim is ${claim.status}`);
      if (claim.expires_at.getTime() <= Date.now()) throw new CircleOwnershipError(410, 'INVALID_STATE', 'Owner recovery claim expired');
      if (claim.expected_owner_identity_id !== params.expectedOwnerIdentityId) {
        throw new CircleOwnershipError(409, 'OWNER_CHANGED', 'Owner recovery claim is stale');
      }
      claimAuthorization = claim.created_authorization;
    }

    const previousResult = await client.query<{ identity_id: string; identity_name: string | null; role: string }>(
      `SELECT identity_id, identity_name, role FROM identities
        WHERE family_id = $1 AND identity_id = $2 FOR UPDATE`,
      [params.familyId, params.expectedOwnerIdentityId]
    );
    const previous = previousResult.rows[0];
    if (!previous || previous.role !== 'owner') {
      throw new CircleOwnershipError(409, 'INVALID_STATE', 'Recorded owner identity is inconsistent');
    }

    const duplicate = await client.query(
      `SELECT 1 FROM identities
        WHERE family_id = $1 AND (identity_id = $2 OR public_key_value = $3)
       UNION ALL
       SELECT 1 FROM devices
        WHERE family_id = $1 AND (device_id = $4 OR public_key_value = $5)
       LIMIT 1`,
      [params.familyId, material.identityId, material.identityPublicKey.value, material.devicePayload.deviceId, material.devicePayload.devicePublicKey.value]
    );
    if ((duplicate.rowCount || 0) > 0) throw new CircleOwnershipError(409, 'ALREADY_EXISTS', 'New owner identity or device already exists');

    const quota = await client.query<{ member_count: string; total_count: string }>(
      `SELECT COUNT(*) FILTER (WHERE role IN ('owner', 'member'))::text AS member_count,
              COUNT(*)::text AS total_count
         FROM identities WHERE family_id = $1 AND status = 'active'`,
      [params.familyId]
    );
    const memberCount = Number(quota.rows[0]?.member_count || 0);
    const totalCount = Number(quota.rows[0]?.total_count || 0);
    if (config.max_member_identities !== null && memberCount >= Number(config.max_member_identities)) {
      throw new CircleOwnershipError(409, 'MEMBER_LIMIT_EXCEEDED', 'Circle member limit has been reached');
    }
    if (config.max_total_identities !== null && totalCount >= Number(config.max_total_identities)) {
      throw new CircleOwnershipError(409, 'TOTAL_USER_LIMIT_EXCEEDED', 'Circle user limit has been reached');
    }
    await client.query(`UPDATE identities SET role = 'member' WHERE family_id = $1 AND identity_id = $2`, [params.familyId, previous.identity_id]);
    const identityResult = await client.query<any>(
      `INSERT INTO identities (
         identity_id, family_id, public_key_algorithm, public_key_value,
         encrypted_private_key, role, publish_identity, identity_name
       ) VALUES ($1, $2, $3, $4, $5::jsonb, 'owner', $6, $7)
       RETURNING *`,
      [
        material.identityId,
        params.familyId,
        material.identityPublicKey.algorithm,
        material.identityPublicKey.value,
        material.encryptedIdentityPrivateKey ? JSON.stringify(material.encryptedIdentityPrivateKey) : null,
        false,
        null
      ]
    );
    const deviceLabel = normalizeName(material.devicePayload.deviceLabel)?.slice(0, 80) || null;
    const deviceResult = await client.query<any>(
      `INSERT INTO devices (
         device_id, identity_id, family_id, public_key_algorithm, public_key_value,
         encryption_public_key_algorithm, encryption_public_key_value,
         registration_attestation, label, encrypted_physical_device_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb)
       RETURNING *`,
      [
        material.devicePayload.deviceId,
        material.identityId,
        params.familyId,
        material.devicePayload.devicePublicKey.algorithm,
        material.devicePayload.devicePublicKey.value,
        material.devicePayload.deviceEncryptionPublicKey?.algorithm || null,
        material.devicePayload.deviceEncryptionPublicKey?.value || null,
        JSON.stringify({
          version: 1,
          identitySignedRequest: material.deviceRegistration,
          deviceKeyBinding: material.devicePayload.deviceKeyBinding
        }),
        deviceLabel,
        material.devicePayload.encryptedPhysicalDeviceId
          ? JSON.stringify(material.devicePayload.encryptedPhysicalDeviceId)
          : null
      ]
    );
    await client.query(`UPDATE family_config SET owner_identity_id = $2, updated_at = NOW() WHERE family_id = $1`, [params.familyId, material.identityId]);
    if (params.recoveryClaim) {
      await client.query(
        `UPDATE circle_owner_recovery_claims
            SET status = 'used', used_at = NOW(), used_by_identity_id = $2
          WHERE token_hash = $1`,
        [params.recoveryClaim.tokenHash, material.identityId]
      );
    }
    await client.query(
      `UPDATE circle_owner_recovery_claims SET status = 'revoked'
        WHERE family_id = $1 AND status = 'pending' AND token_hash <> COALESCE($2, '')`,
      [params.familyId, params.recoveryClaim?.tokenHash || null]
    );

    const change = await recordChangeAndEvents(client, {
      familyId: params.familyId,
      circleName: config.server_name,
      publicBaseUrl: config.public_base_url,
      previousOwnerIdentityId: previous.identity_id,
      previousOwnerIdentityName: null,
      newOwnerIdentityId: material.identityId,
      newOwnerIdentityName: null,
      method: 'server_admin_recovery',
      initiatedByIdentityId: params.initiatedByIdentityId,
      initiatedByDeviceId: params.initiatedByDeviceId,
      initiatedByServerAdminId: params.initiatedByServerAdminId,
      recoveryClaimId: params.recoveryClaim?.claimId || null,
      signedAuthorization: params.recoveryClaim
        ? { administrator: claimAuthorization, newIdentityAcceptance: params.acceptance }
        : params.signedAuthorization
    });

    const identityRow = identityResult.rows[0];
    const deviceRow = deviceResult.rows[0];
    return {
      ...change,
      identity: {
        identityId: identityRow.identity_id,
        publicKey: { algorithm: identityRow.public_key_algorithm, value: identityRow.public_key_value },
        encryptedPrivateKey: identityRow.encrypted_private_key,
        createdAt: identityRow.created_at.toISOString(),
        status: identityRow.status,
        role: 'owner'
      },
      device: {
        deviceId: deviceRow.device_id,
        identityId: deviceRow.identity_id,
        publicKey: { algorithm: deviceRow.public_key_algorithm, value: deviceRow.public_key_value },
        encryptionPublicKey: deviceRow.encryption_public_key_value
          ? { algorithm: deviceRow.encryption_public_key_algorithm, value: deviceRow.encryption_public_key_value }
          : null,
        registrationAttestation: deviceRow.registration_attestation,
        label: deviceRow.label,
        encryptedPhysicalDeviceId: deviceRow.encrypted_physical_device_id,
        createdAt: deviceRow.created_at.toISOString(),
        status: deviceRow.status
      }
    };
  });
}

export async function deliverCircleOwnerChangedPush(result: OwnershipChangeResult): Promise<void> {
  await Promise.allSettled(result.recipients.map((identityId) => sendCircleOwnerChangedPush(
    result.familyId,
    identityId,
    {
      ownershipChangeId: result.changeId,
      circleName: result.circleName,
      method: result.method
    }
  )));
}
