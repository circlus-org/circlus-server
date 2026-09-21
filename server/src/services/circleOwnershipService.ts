import { nanoid } from 'nanoid';
import type { PoolClient } from 'pg';
import type {
  CircleOwnerChangeMethod,
  CircleMembershipStateRecord,
  SystemEventCircleOwnerChangedPayload
} from '@shared/types';
import { transaction } from '../db';
import { sendCircleOwnerChangedPush } from '../utils/push';
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
    throw new CircleOwnershipError(409, 'OWNER_CHANGED', 'Circle owner changed during the ownership transfer');
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
      null,
      null,
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
  signedAuthorization: unknown;
  membershipState: CircleMembershipStateRecord;
}): Promise<OwnershipChangeResult> {
  if (!params.newOwnerIdentityId || params.newOwnerIdentityId === params.expectedOwnerIdentityId) {
    throw new CircleOwnershipError(400, 'INVALID_REQUEST', 'Select another active Circle member');
  }
  if (params.membershipState.claim?.payload?.action !== 'transfer_owner'
      || params.membershipState.claim.signerId !== params.expectedOwnerIdentityId
      || params.membershipState.claim.payload.subjectIdentityId !== params.newOwnerIdentityId
      || params.membershipState.claim.payload.ownerIdentityId !== params.newOwnerIdentityId) {
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
    await appendCircleMembershipState({ familyId: params.familyId, record: params.membershipState, client });
    await client.query(`UPDATE identities SET role = 'member' WHERE family_id = $1 AND identity_id = $2`, [params.familyId, previous.identity_id]);
    await client.query(`UPDATE identities SET role = 'owner' WHERE family_id = $1 AND identity_id = $2`, [params.familyId, target.identity_id]);
    await client.query(`UPDATE family_config SET owner_identity_id = $2, updated_at = NOW() WHERE family_id = $1`, [params.familyId, target.identity_id]);
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
