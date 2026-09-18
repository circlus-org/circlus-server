import { pool } from '../index';
import type { DBTemporaryAccessRequest } from '../types';
import type {
  FindTemporaryAccessRequestByRequestIdResult,
  CreateTemporaryAccessRequestParams,
  ListPendingTemporaryAccessRequestsByIdentityParams,
  ListActiveTemporaryAccessRequestsByTemporaryDeviceParams,
  ApproveTemporaryAccessRequestParams,
  RejectTemporaryAccessRequestParams,
  ConsumeTemporaryAccessRequestParams,
  ExpireTemporaryAccessRequestsByTypeParams,
} from './temporaryAccessRequestRepository.queries';
import {
  findTemporaryAccessRequestByRequestId,
  createTemporaryAccessRequest,
  listPendingTemporaryAccessRequestsByIdentity,
  listActiveTemporaryAccessRequestsByTemporaryDevice,
  approveTemporaryAccessRequest,
  rejectTemporaryAccessRequest,
  consumeTemporaryAccessRequest,
  expireTemporaryAccessRequestsByType,
  expireAllTemporaryAccessRequests,
} from './temporaryAccessRequestRepository.queries';

export type TemporaryAccessRequestType = 'contacts' | 'trusted_access' | 'temporary_renewal';

type TemporaryAccessRequestRow = FindTemporaryAccessRequestByRequestIdResult;

function mapTemporaryAccessRequest(row: TemporaryAccessRequestRow): DBTemporaryAccessRequest {
  return {
    ...row,
    request_type: row.request_type as TemporaryAccessRequestType,
    temporary_device_public_key_algorithm: row.temporary_device_public_key_algorithm as 'ed25519' | 'x25519',
    status: row.status as DBTemporaryAccessRequest['status'],
  };
}

export class TemporaryAccessRequestRepository {
  async findByRequestId(
    familyId: string,
    requestId: string,
    requestType: TemporaryAccessRequestType
  ): Promise<DBTemporaryAccessRequest | null> {
    const results = await findTemporaryAccessRequestByRequestId.run({ familyId, requestId, requestType }, pool);
    return results[0] ? mapTemporaryAccessRequest(results[0]) : null;
  }

  async create(data: {
    requestId: string;
    requestType: TemporaryAccessRequestType;
    familyId: string;
    identityId: string;
    enrollmentId: string;
    temporaryDeviceId: string;
    temporaryDevicePublicKeyAlgorithm: 'ed25519' | 'x25519';
    temporaryDevicePublicKeyValue: string;
    expiresAt: Date;
  }): Promise<DBTemporaryAccessRequest> {
    const params: CreateTemporaryAccessRequestParams = {
      requestId: data.requestId,
      requestType: data.requestType,
      familyId: data.familyId,
      identityId: data.identityId,
      enrollmentId: data.enrollmentId,
      temporaryDeviceId: data.temporaryDeviceId,
      temporaryDevicePublicKeyAlgorithm: data.temporaryDevicePublicKeyAlgorithm,
      temporaryDevicePublicKeyValue: data.temporaryDevicePublicKeyValue,
      expiresAt: data.expiresAt,
    };
    const results = await createTemporaryAccessRequest.run(params, pool);
    return mapTemporaryAccessRequest(results[0]);
  }

  async listPendingByIdentity(
    familyId: string,
    identityId: string,
    requestType: TemporaryAccessRequestType
  ): Promise<DBTemporaryAccessRequest[]> {
    const params: ListPendingTemporaryAccessRequestsByIdentityParams = { familyId, identityId, requestType };
    const results = await listPendingTemporaryAccessRequestsByIdentity.run(params, pool);
    return results.map(mapTemporaryAccessRequest);
  }

  async listActiveByTemporaryDevice(
    familyId: string,
    temporaryDeviceId: string,
    requestType: TemporaryAccessRequestType
  ): Promise<DBTemporaryAccessRequest[]> {
    const params: ListActiveTemporaryAccessRequestsByTemporaryDeviceParams = {
      familyId,
      temporaryDeviceId,
      requestType,
    };
    const results = await listActiveTemporaryAccessRequestsByTemporaryDevice.run(params, pool);
    return results.map(mapTemporaryAccessRequest);
  }

  async listApprovedTemporaryDeviceIds(
    familyId: string,
    temporaryDeviceIds: string[],
    requestType: TemporaryAccessRequestType
  ): Promise<string[]> {
    if (temporaryDeviceIds.length === 0) return [];

    const result = await pool.query<{ temporary_device_id: string }>(
      `SELECT DISTINCT temporary_device_id
       FROM temporary_access_requests
       WHERE family_id = $1
         AND temporary_device_id = ANY($2::text[])
         AND request_type = $3
         AND status = 'approved'
         AND expires_at > NOW()`,
      [familyId, temporaryDeviceIds, requestType]
    );
    return result.rows.map((row) => row.temporary_device_id);
  }

  async markApproved(data: {
    familyId: string;
    requestId: string;
    requestType: TemporaryAccessRequestType;
    approvedByDeviceId: string;
    encryptedPayload: string;
    cipher: string;
  }): Promise<DBTemporaryAccessRequest | null> {
    const params: ApproveTemporaryAccessRequestParams = {
      familyId: data.familyId,
      requestId: data.requestId,
      requestType: data.requestType,
      approvedByDeviceId: data.approvedByDeviceId,
      encryptedPayload: data.encryptedPayload,
      cipher: data.cipher,
    };
    const results = await approveTemporaryAccessRequest.run(params, pool);
    return results[0] ? mapTemporaryAccessRequest(results[0]) : null;
  }

  async markRejected(
    familyId: string,
    requestId: string,
    requestType: TemporaryAccessRequestType
  ): Promise<DBTemporaryAccessRequest | null> {
    const params: RejectTemporaryAccessRequestParams = { familyId, requestId, requestType };
    const results = await rejectTemporaryAccessRequest.run(params, pool);
    return results[0] ? mapTemporaryAccessRequest(results[0]) : null;
  }

  async markConsumed(
    familyId: string,
    requestId: string,
    requestType: TemporaryAccessRequestType
  ): Promise<DBTemporaryAccessRequest | null> {
    const params: ConsumeTemporaryAccessRequestParams = { familyId, requestId, requestType };
    const results = await consumeTemporaryAccessRequest.run(params, pool);
    return results[0] ? mapTemporaryAccessRequest(results[0]) : null;
  }

  async expireStale(requestType?: TemporaryAccessRequestType): Promise<number> {
    if (requestType) {
      const params: ExpireTemporaryAccessRequestsByTypeParams = { requestType };
      const result = await expireTemporaryAccessRequestsByType.run(params, pool);
      return result.length;
    }

    const result = await expireAllTemporaryAccessRequests.run(undefined as never, pool);
    return result.length;
  }
}

export const temporaryAccessRequestRepository = new TemporaryAccessRequestRepository();
