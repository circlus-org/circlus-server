import { reliableOperation } from '../services/reliableOperation';
import { inTransactionContext, transaction } from '../db';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import type { ApiResponse, ErrorCode, WSTemporaryAccessGrantReadyData } from '../../../shared/types';
import { verifySignature, requireActiveIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import {
  temporaryAccessRequestRepository,
  temporaryDeviceRepository,
  deviceEnrollmentRepository,
  type TemporaryAccessRequestType
} from '../db/repositories';
import { bumpChatEpochsForTemporaryDevice } from '../services/chatEpochRotation';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { sendToDeviceWs, sendToIdentityWs } from '../ws/wsGateway';
import { sendTemporaryTrustedAccessRequestPush } from '../utils/push';
import {
  getFeaturePolicyRuntimeConfig,
  getRateLimitRuntimeConfig
} from '../config/serverRuntimeConfig';
import temporaryAccessChatKeyRoutes from './temporaryAccessChatKeyRoutes';
import {
  forbidGuestIdentity,
  forbiddenError,
  getTrustedDeviceContext,
  invalidRequestError,
  invalidStateError,
  notFoundError,
  requestContextError
} from './temporaryAccessRouteSupport';

const router = Router();

const temporaryAccessRateLimits = getRateLimitRuntimeConfig().temporaryAccess;
const temporaryAccessPolicies = getFeaturePolicyRuntimeConfig().temporaryAccess;
const TRUSTED_ACCESS_REQUEST_TTL_MS = temporaryAccessPolicies.trustedRequestTtlMs;
const TEMPORARY_RENEWAL_REQUEST_TTL_MS = temporaryAccessPolicies.renewalRequestTtlMs;
const TRUSTED_ACCESS_REQUEST_TYPE: TemporaryAccessRequestType = 'trusted_access';
const TEMPORARY_RENEWAL_REQUEST_TYPE: TemporaryAccessRequestType = 'temporary_renewal';

const rlCreateRequest = createRateLimiter({
  name: 'temporary-access:request',
  windowMs: temporaryAccessRateLimits.windowMs,
  max: temporaryAccessRateLimits.contactCreateMax,
  keyFn: ipFamilyKey
});

function toRecordStatus(status: string): 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'consumed') {
    return status;
  }
  return 'pending';
}

function toRequestRecord(row: {
  request_id: string;
  enrollment_id: string;
  temporary_device_id: string;
  identity_id: string;
  created_at: Date;
  expires_at: Date;
  status: string;
}) {
  return {
    requestId: row.request_id,
    enrollmentId: row.enrollment_id,
    temporaryDeviceId: row.temporary_device_id,
    identityId: row.identity_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    status: toRecordStatus(row.status)
  };
}

function notifyTrustedDevicesAboutRequest(familyId: string, request: {
  request_id: string;
  identity_id: string;
  temporary_device_id: string;
  created_at: Date;
}) {
  sendToIdentityWs(familyId, request.identity_id, {
    type: 'temporary-access:trusted-request-created',
    data: {
      requestId: request.request_id,
      identityId: request.identity_id,
      temporaryDeviceId: request.temporary_device_id,
      createdAt: request.created_at.toISOString()
    },
    timestamp: Date.now()
  });

  void sendTemporaryTrustedAccessRequestPush(familyId, request.identity_id, {
    requestId: request.request_id,
    identityId: request.identity_id,
    temporaryDeviceId: request.temporary_device_id
  }).catch((error) => {
    routeLogger.warn('[TemporaryAccess] Failed to deliver trusted-access push', error);
  });
}

function notifyTemporaryDeviceAboutGrant(request: {
  request_id: string;
  enrollment_id: string;
  temporary_device_id: string;
  request_type?: TemporaryAccessRequestType;
}, requestType: 'trusted_access' | 'temporary_renewal'): void {
  const data: WSTemporaryAccessGrantReadyData = {
    requestId: request.request_id,
    enrollmentId: request.enrollment_id,
    requestType,
  };
  sendToDeviceWs(request.temporary_device_id, {
    type: 'temporary-access:grant-ready',
    data,
    timestamp: Date.now(),
  });
}

type TemporaryAccessFlowConfig = {
  routePrefix: 'trusted' | 'renewal';
  requestType: 'trusted_access' | 'temporary_renewal';
  requestIdPrefix: string;
  ttlMs: number;
  createForbiddenMessage: string;
  listForbiddenMessage: string;
  approveForbiddenMessage: string;
  rejectForbiddenMessage: string;
  payloadForbiddenMessage: string;
  notFoundMessage: string;
  belongsToDifferentIdentityMessage: string;
  notPendingMessage: string;
  payloadNotReadyMessage: string;
  createErrorLog: string;
  createErrorMessage: string;
  listErrorLog: string;
  listErrorMessage: string;
  approveErrorLog: string;
  approveErrorMessage: string;
  rejectErrorLog: string;
  rejectErrorMessage: string;
  payloadErrorLog: string;
  payloadErrorMessage: string;
  approvalPayloadField: 'encryptedTrustedAccessPayload' | 'encryptedTemporaryRenewalPayload';
  payloadResponseField: 'encryptedTrustedAccessPayload' | 'encryptedTemporaryRenewalPayload';
  accessExpiresAtField?: 'temporaryAccessExpiresAt';
};

function toTemporaryDeviceRecord(device: {
  device_id: string;
  identity_id: string;
  public_key_algorithm: 'ed25519' | 'x25519';
  public_key_value: string;
  encryption_public_key_algorithm?: 'x25519' | null;
  encryption_public_key_value?: string | null;
  approved_by_device_id: string;
  created_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
  status: string;
  can_call?: boolean;
}) {
  return {
    deviceId: device.device_id,
    identityId: device.identity_id,
    publicKey: {
      algorithm: device.public_key_algorithm,
      value: device.public_key_value
    },
    encryptionPublicKey: device.encryption_public_key_value
      ? {
          algorithm: device.encryption_public_key_algorithm || 'x25519',
          value: device.encryption_public_key_value
        }
      : null,
    approvedByDeviceId: device.approved_by_device_id,
    createdAt: device.created_at.toISOString(),
    lastSeenAt: device.last_seen_at?.toISOString() || null,
    expiresAt: device.expires_at.toISOString(),
    status: device.status,
    canCall: device.can_call === true
  };
}

async function listEnrichedRequests(familyId: string, identityId: string, requestType: TemporaryAccessRequestType) {
  await temporaryAccessRequestRepository.expireStale(requestType);
  const requests = await temporaryAccessRequestRepository.listPendingByIdentity(familyId, identityId, requestType);
  const enrollmentIds = [...new Set(requests.map((request) => request.enrollment_id))];
  const temporaryDeviceIds = [...new Set(requests.map((request) => request.temporary_device_id))];
  const [enrollments, temporaryDevices, allChatAccess] = await Promise.all([
    deviceEnrollmentRepository.findByEnrollmentIds(familyId, enrollmentIds),
    temporaryDeviceRepository.findByDeviceIds(familyId, temporaryDeviceIds),
    temporaryDeviceRepository.getChatAccessForDevices(familyId, temporaryDeviceIds)
  ]);
  const enrollmentsById = new Map(enrollments.map((enrollment) => [enrollment.enrollment_id, enrollment]));
  const temporaryDevicesById = new Map(temporaryDevices.map((device) => [device.device_id, device]));
  const chatAccessByDeviceId = new Map<string, typeof allChatAccess>();
  for (const access of allChatAccess) {
    const entries = chatAccessByDeviceId.get(access.temporary_device_id) || [];
    entries.push(access);
    chatAccessByDeviceId.set(access.temporary_device_id, entries);
  }

  return requests.map((item) => {
    const enrollment = enrollmentsById.get(item.enrollment_id);
    const temporaryDevice = temporaryDevicesById.get(item.temporary_device_id);
    const chatAccess = chatAccessByDeviceId.get(item.temporary_device_id) || [];
    return {
      ...toRequestRecord(item),
      requestIp: enrollment?.request_ip || null,
      requestUserAgent: enrollment?.request_user_agent || null,
      origin: enrollment?.origin || null,
      temporaryDevicePublicKey: {
        algorithm: item.temporary_device_public_key_algorithm,
        value: item.temporary_device_public_key_value
      },
      temporaryDeviceEncryptionPublicKey: enrollment?.new_device_encryption_public_key_value
        ? {
            algorithm: enrollment.new_device_encryption_public_key_algorithm || 'x25519',
            value: enrollment.new_device_encryption_public_key_value
          }
        : null,
      currentTemporaryAccessExpiresAt: temporaryDevice?.expires_at?.toISOString() || null,
      accessibleGroupChatIds: chatAccess.filter((access) => access.chat_type === 'group').map((access) => access.chat_id),
      accessibleDirectChatIds: chatAccess.filter((access) => access.chat_type === 'direct').map((access) => access.chat_id),
      canCall: temporaryDevice?.can_call === true
    };
  });
}

function registerTemporaryAccessRoutes(config: TemporaryAccessFlowConfig) {
  router.post(`/${config.routePrefix}/request`, rlCreateRequest, verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest<{
    enrollmentId?: string;
  }> & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId || !req.device) {
        return requestContextError(res);
      }

      if (forbidGuestIdentity(req, res)) {
        return;
      }

      if (req.device.accessLevel !== 'temporary') {
        return forbiddenError(res, config.createForbiddenMessage);
      }

      const { enrollmentId } = getSignedPayload<{ enrollmentId?: string }>(req);
      if (!enrollmentId) {
        return invalidRequestError(res, 'enrollmentId is required');
      }

      const temporaryDevice = await temporaryDeviceRepository.findByDeviceId(familyId, req.device.deviceId);
      if (!temporaryDevice || temporaryDevice.identity_id !== req.device.identityId) {
        return notFoundError(res, 'Temporary device not found');
      }

      const existing = await temporaryAccessRequestRepository.listActiveByTemporaryDevice(
        familyId,
        req.device.deviceId,
        config.requestType
      );
      const sameEnrollment = existing.find((item) => item.enrollment_id === enrollmentId);
      if (sameEnrollment) {
        if (sameEnrollment.status === 'pending') {
          notifyTrustedDevicesAboutRequest(familyId, sameEnrollment);
        }
        return res.json({
          status: 'ok',
          result: { request: toRequestRecord(sameEnrollment) }
        } as ApiResponse);
      }

      const requestId = `${config.requestIdPrefix}_${crypto.randomUUID().replace(/-/g, '')}`;
      const created = await temporaryAccessRequestRepository.create({
        requestId,
        requestType: config.requestType,
        familyId,
        identityId: req.device.identityId,
        enrollmentId,
        temporaryDeviceId: req.device.deviceId,
        temporaryDevicePublicKeyAlgorithm: temporaryDevice.public_key_algorithm,
        temporaryDevicePublicKeyValue: temporaryDevice.public_key_value,
        expiresAt: new Date(Date.now() + Math.max(60000, config.ttlMs))
      });

      if (config.requestType === TRUSTED_ACCESS_REQUEST_TYPE || config.requestType === TEMPORARY_RENEWAL_REQUEST_TYPE) {
        notifyTrustedDevicesAboutRequest(familyId, created);
      }

      return res.json({
        status: 'ok',
        result: { request: toRequestRecord(created) }
      } as ApiResponse);
    } catch (error) {
      routeLogger.error(config.createErrorLog, error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: config.createErrorMessage }
      } as ApiResponse);
    }
  }));

  router.post(`/${config.routePrefix}/requests`, verifySignature, requireActiveIdentity, async (req: AuthRequest<Record<string, never>> & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId || !req.device) {
        return requestContextError(res);
      }

      if (forbidGuestIdentity(req, res)) {
        return;
      }

      if (req.device.accessLevel !== 'trusted') {
        return forbiddenError(res, config.listForbiddenMessage);
      }

      const requests = await listEnrichedRequests(familyId, req.device.identityId, config.requestType);
      return res.json({
        status: 'ok',
        result: { requests }
      } as ApiResponse);
    } catch (error) {
      routeLogger.error(config.listErrorLog, error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: config.listErrorMessage }
      } as ApiResponse);
    }
  });

  router.post(`/${config.routePrefix}/approve`, verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest<{
    requestId?: string;
    encryptedContactsPayload?: string;
    encryptedTrustedAccessPayload?: string;
    encryptedTemporaryRenewalPayload?: string;
    temporaryAccessExpiresAt?: string;
    cipher?: string;
  }> & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId || !req.device) {
        return requestContextError(res);
      }

      if (forbidGuestIdentity(req, res)) {
        return;
      }

      if (req.device.accessLevel !== 'trusted') {
        return forbiddenError(res, config.approveForbiddenMessage);
      }

      const payload = getSignedPayload<{
        requestId?: string;
        encryptedContactsPayload?: string;
        encryptedTrustedAccessPayload?: string;
        encryptedTemporaryRenewalPayload?: string;
        temporaryAccessExpiresAt?: string;
        cipher?: string;
      }>(req);
      const requestId = payload.requestId;
      const encryptedPayload = payload[config.approvalPayloadField];
      const { cipher } = payload;

      if (!requestId || !encryptedPayload || !cipher) {
        return invalidRequestError(
          res,
          `requestId, ${config.approvalPayloadField} and cipher are required`
        );
      }
      const renewalExpiresAt = config.accessExpiresAtField
        ? new Date(String(payload[config.accessExpiresAtField] || ''))
        : null;
      if (config.accessExpiresAtField && (!renewalExpiresAt || !Number.isFinite(renewalExpiresAt.getTime()) || renewalExpiresAt.getTime() <= Date.now())) {
        return invalidRequestError(res, `${config.accessExpiresAtField} must be a future ISO date`);
      }

      const existing = await temporaryAccessRequestRepository.findByRequestId(familyId, requestId, config.requestType);
      if (!existing) {
        return notFoundError(res, config.notFoundMessage);
      }

      if (existing.identity_id !== req.device.identityId) {
        return forbiddenError(res, config.belongsToDifferentIdentityMessage);
      }

      const approved = await transaction(client => inTransactionContext(client, async () => {
      const approved = await temporaryAccessRequestRepository.markApproved({
        familyId,
        requestId,
        requestType: config.requestType,
        approvedByDeviceId: req.device!.deviceId,
        encryptedPayload,
        cipher
      });
      if (!approved) {
        throw new Error(config.notPendingMessage);
      }


      if (config.requestType === TEMPORARY_RENEWAL_REQUEST_TYPE && renewalExpiresAt) {
        const temporaryDevice = await temporaryDeviceRepository.findByDeviceId(familyId, existing.temporary_device_id);
        if (!temporaryDevice || temporaryDevice.identity_id !== existing.identity_id) {
          throw new Error('Temporary device not found');
        }
        await temporaryDeviceRepository.createOrRefresh({
          familyId,
          deviceId: temporaryDevice.device_id,
          identityId: temporaryDevice.identity_id,
          publicKeyAlgorithm: temporaryDevice.public_key_algorithm,
          publicKeyValue: temporaryDevice.public_key_value,
          encryptionPublicKeyAlgorithm: temporaryDevice.encryption_public_key_algorithm || 'x25519',
          encryptionPublicKeyValue: temporaryDevice.encryption_public_key_value,
          approvedByDeviceId: req.device!.deviceId,
          expiresAt: renewalExpiresAt
        });
      }

      return approved;
      }));
      notifyTemporaryDeviceAboutGrant(approved, config.requestType);

      return res.json({
        status: 'ok',
        result: { request: toRequestRecord(approved) }
      } as ApiResponse);
    } catch (error) {
      routeLogger.error(config.approveErrorLog, error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: config.approveErrorMessage }
      } as ApiResponse);
    }
  }));

  router.post(`/${config.routePrefix}/reject`, verifySignature, requireActiveIdentity, async (req: AuthRequest<{
    requestId?: string;
  }> & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId || !req.device) {
        return requestContextError(res);
      }

      if (forbidGuestIdentity(req, res)) {
        return;
      }

      if (req.device.accessLevel !== 'trusted') {
        return forbiddenError(res, config.rejectForbiddenMessage);
      }

      const { requestId } = getSignedPayload<{ requestId?: string }>(req);
      if (!requestId) {
        return invalidRequestError(res, 'requestId is required');
      }

      const existing = await temporaryAccessRequestRepository.findByRequestId(familyId, requestId, config.requestType);
      if (!existing) {
        return notFoundError(res, config.notFoundMessage);
      }

      if (existing.identity_id !== req.device.identityId) {
        return forbiddenError(res, config.belongsToDifferentIdentityMessage);
      }

      const rejected = await temporaryAccessRequestRepository.markRejected(familyId, requestId, config.requestType);
      if (!rejected) {
        return invalidStateError(res, config.notPendingMessage);
      }

      return res.json({
        status: 'ok',
        result: { request: toRequestRecord(rejected) }
      } as ApiResponse);
    } catch (error) {
      routeLogger.error(config.rejectErrorLog, error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: config.rejectErrorMessage }
      } as ApiResponse);
    }
  });

  router.post(`/${config.routePrefix}/payload`, verifySignature, requireActiveIdentity, async (req: AuthRequest<{
    requestId?: string;
  }> & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId || !req.device) {
        return requestContextError(res);
      }

      if (forbidGuestIdentity(req, res)) {
        return;
      }

      if (req.device.accessLevel !== 'temporary') {
        return forbiddenError(res, config.payloadForbiddenMessage);
      }

      const { requestId } = getSignedPayload<{ requestId?: string }>(req);
      if (!requestId) {
        return invalidRequestError(res, 'requestId is required');
      }

      await temporaryAccessRequestRepository.expireStale(config.requestType);
      const existing = await temporaryAccessRequestRepository.findByRequestId(familyId, requestId, config.requestType);
      if (!existing || existing.temporary_device_id !== req.device.deviceId) {
        return notFoundError(res, config.notFoundMessage);
      }

      if (!['approved', 'consumed'].includes(existing.status) || existing.expires_at.getTime() <= Date.now()) {
        return invalidStateError(res, config.payloadNotReadyMessage);
      }

      const record = existing;
      return res.json({
        status: 'ok',
        result: {
          request: toRequestRecord(record),
          [config.payloadResponseField]: existing.encrypted_payload,
          temporaryAccessExpiresAt: config.accessExpiresAtField
            ? (await temporaryDeviceRepository.findByDeviceId(familyId, existing.temporary_device_id))?.expires_at?.toISOString() || null
            : undefined,
          cipher: existing.cipher
        }
      } as ApiResponse);
    } catch (error) {
      routeLogger.error(config.payloadErrorLog, error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: config.payloadErrorMessage }
      } as ApiResponse);
    }
  });
  router.post(`/${config.routePrefix}/ack`, verifySignature, requireActiveIdentity, async (req: AuthRequest<{requestId?:string}>, res) => {
    const requestId = req.signedRequest?.payload?.requestId;
    if (!requestId || !req.familyId || !req.device) return invalidRequestError(res,'requestId required');
    try {
      await transaction(client => inTransactionContext(client, async () => {
        const locked = await client.query(`SELECT * FROM temporary_access_requests WHERE family_id=$1 AND request_id=$2 AND request_type=$3 FOR UPDATE`,[req.familyId,requestId,config.requestType]);
        const request = locked.rows[0];
        if (!request || request.identity_id !== req.device!.identityId) throw new Error('Request identity mismatch');
        if (config.requestType === TRUSTED_ACCESS_REQUEST_TYPE && req.device!.accessLevel !== 'trusted') throw new Error('ACK requires the installed trusted device');
        if (config.requestType === TEMPORARY_RENEWAL_REQUEST_TYPE && request.temporary_device_id !== req.device!.deviceId) throw new Error('ACK device mismatch');
        if (request.status === 'consumed') return;
        if (request.status !== 'approved' || new Date(request.expires_at).getTime() <= Date.now()) throw new Error('Request is no longer available');
        await temporaryAccessRequestRepository.markConsumed(req.familyId!,requestId,config.requestType);
        if (config.requestType === TRUSTED_ACCESS_REQUEST_TYPE) await bumpChatEpochsForTemporaryDevice({familyId:req.familyId!,temporaryDeviceId:request.temporary_device_id,reason:'device_revoked'});
      }));
      return res.json({status:'ok',result:{acknowledged:true}});
    } catch (error) {
      return res.status(409).json({status:'error',error:{code:'INVALID_STATE',message:error instanceof Error?error.message:'ACK failed'}});
    }
  });

}

registerTemporaryAccessRoutes({
  routePrefix: 'trusted',
  requestType: TRUSTED_ACCESS_REQUEST_TYPE,
  requestIdPrefix: 'ttar',
  ttlMs: TRUSTED_ACCESS_REQUEST_TTL_MS,
  createForbiddenMessage: 'Only temporary devices can request trusted access',
  listForbiddenMessage: 'Only trusted devices can review trusted access requests',
  approveForbiddenMessage: 'Only trusted devices can approve trusted access requests',
  rejectForbiddenMessage: 'Only trusted devices can reject trusted access requests',
  payloadForbiddenMessage: 'Only temporary devices can read trusted access payloads',
  notFoundMessage: 'Trusted access request not found',
  belongsToDifferentIdentityMessage: 'Trusted access request belongs to a different identity',
  notPendingMessage: 'Trusted access request is no longer pending',
  payloadNotReadyMessage: 'Trusted access payload is not ready',
  createErrorLog: 'Create trusted access request error:',
  createErrorMessage: 'Failed to create trusted access request',
  listErrorLog: 'List trusted access requests error:',
  listErrorMessage: 'Failed to list trusted access requests',
  approveErrorLog: 'Approve trusted access request error:',
  approveErrorMessage: 'Failed to approve trusted access request',
  rejectErrorLog: 'Reject trusted access request error:',
  rejectErrorMessage: 'Failed to reject trusted access request',
  payloadErrorLog: 'Read trusted access payload error:',
  payloadErrorMessage: 'Failed to read trusted access payload',
  approvalPayloadField: 'encryptedTrustedAccessPayload',
  payloadResponseField: 'encryptedTrustedAccessPayload'
});

registerTemporaryAccessRoutes({
  routePrefix: 'renewal',
  requestType: TEMPORARY_RENEWAL_REQUEST_TYPE,
  requestIdPrefix: 'tren',
  ttlMs: TEMPORARY_RENEWAL_REQUEST_TTL_MS,
  createForbiddenMessage: 'Only temporary devices can request temporary access renewal',
  listForbiddenMessage: 'Only trusted devices can review temporary access renewal requests',
  approveForbiddenMessage: 'Only trusted devices can approve temporary access renewal requests',
  rejectForbiddenMessage: 'Only trusted devices can reject temporary access renewal requests',
  payloadForbiddenMessage: 'Only temporary devices can read temporary renewal payloads',
  notFoundMessage: 'Temporary renewal request not found',
  belongsToDifferentIdentityMessage: 'Temporary renewal request belongs to a different identity',
  notPendingMessage: 'Temporary renewal request is no longer pending',
  payloadNotReadyMessage: 'Temporary renewal payload is not ready',
  createErrorLog: 'Create temporary renewal request error:',
  createErrorMessage: 'Failed to create temporary renewal request',
  listErrorLog: 'List temporary renewal requests error:',
  listErrorMessage: 'Failed to list temporary renewal requests',
  approveErrorLog: 'Approve temporary renewal request error:',
  approveErrorMessage: 'Failed to approve temporary renewal request',
  rejectErrorLog: 'Reject temporary renewal request error:',
  rejectErrorMessage: 'Failed to reject temporary renewal request',
  payloadErrorLog: 'Read temporary renewal payload error:',
  payloadErrorMessage: 'Failed to read temporary renewal payload',
  approvalPayloadField: 'encryptedTemporaryRenewalPayload',
  payloadResponseField: 'encryptedTemporaryRenewalPayload',
  accessExpiresAtField: 'temporaryAccessExpiresAt'
});

router.post('/trusted/grant', verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest<{
  temporaryDeviceId?: string;
  encryptedTrustedAccessPayload?: string;
  cipher?: string;
}> & TenancyRequest, res) => {
  try {
    const context = getTrustedDeviceContext(req, res, 'Only trusted devices can grant full Circle access');
    if (!context) return;

    const { temporaryDeviceId, encryptedTrustedAccessPayload, cipher } = getSignedPayload<{
      temporaryDeviceId?: string;
      encryptedTrustedAccessPayload?: string;
      cipher?: string;
    }>(req);
    if (!temporaryDeviceId || !encryptedTrustedAccessPayload || !cipher) {
      return invalidRequestError(res, 'temporaryDeviceId, encryptedTrustedAccessPayload and cipher are required');
    }

    const temporaryDevice = await temporaryDeviceRepository.findByDeviceId(context.familyId, temporaryDeviceId);
    if (!temporaryDevice || temporaryDevice.identity_id !== context.device.identityId) {
      return notFoundError(res, 'Temporary device not found');
    }
    if (temporaryDevice.status !== 'active' || temporaryDevice.expires_at.getTime() <= Date.now()) {
      return invalidStateError(res, 'Temporary device is no longer active');
    }

    await temporaryAccessRequestRepository.expireStale(TRUSTED_ACCESS_REQUEST_TYPE);
    const active = await temporaryAccessRequestRepository.listActiveByTemporaryDevice(
      context.familyId,
      temporaryDeviceId,
      TRUSTED_ACCESS_REQUEST_TYPE
    );
    const alreadyApproved = active.find((item) => item.status === 'approved');
    if (alreadyApproved) {
      return res.json({
        status: 'ok',
        result: { request: toRequestRecord(alreadyApproved) }
      } as ApiResponse);
    }

    let request = active.find((item) => item.status === 'pending') || null;
    if (!request) {
      const enrollment = await deviceEnrollmentRepository.findByTemporaryDeviceId(context.familyId, temporaryDeviceId);
      if (!enrollment || (enrollment.requested_identity_id && enrollment.requested_identity_id !== context.device.identityId)) {
        return notFoundError(res, 'Temporary device enrollment not found');
      }
      request = await temporaryAccessRequestRepository.create({
        requestId: `ttar_${crypto.randomUUID().replace(/-/g, '')}`,
        requestType: TRUSTED_ACCESS_REQUEST_TYPE,
        familyId: context.familyId,
        identityId: context.device.identityId,
        enrollmentId: enrollment.enrollment_id,
        temporaryDeviceId,
        temporaryDevicePublicKeyAlgorithm: temporaryDevice.public_key_algorithm,
        temporaryDevicePublicKeyValue: temporaryDevice.public_key_value,
        expiresAt: temporaryDevice.expires_at
      });
    }

    const approved = await temporaryAccessRequestRepository.markApproved({
      familyId: context.familyId,
      requestId: request.request_id,
      requestType: TRUSTED_ACCESS_REQUEST_TYPE,
      approvedByDeviceId: context.device.deviceId,
      encryptedPayload: encryptedTrustedAccessPayload,
      cipher
    });
    if (!approved) {
      return invalidStateError(res, 'Full access grant is no longer pending');
    }
    notifyTemporaryDeviceAboutGrant(approved, TRUSTED_ACCESS_REQUEST_TYPE);

    return res.json({
      status: 'ok',
      result: { request: toRequestRecord(approved) }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Grant trusted access error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to grant full Circle access' }
    } as ApiResponse);
  }
}));

router.post('/trusted/pending', verifySignature, requireActiveIdentity, async (req: AuthRequest<Record<string, never>> & TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId || !req.device) return requestContextError(res);
    if (forbidGuestIdentity(req, res)) return;
    if (req.device.accessLevel !== 'temporary') {
      return forbiddenError(res, 'Only temporary devices can discover full access grants');
    }

    await temporaryAccessRequestRepository.expireStale(TRUSTED_ACCESS_REQUEST_TYPE);
    const active = await temporaryAccessRequestRepository.listActiveByTemporaryDevice(
      familyId,
      req.device.deviceId,
      TRUSTED_ACCESS_REQUEST_TYPE
    );
    const approved = active.find((item) => item.status === 'approved') || null;
    return res.json({
      status: 'ok',
      result: { request: approved ? toRequestRecord(approved) : null }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Discover trusted access grant error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to discover full access grant' }
    } as ApiResponse);
  }
});

router.post('/devices/list', verifySignature, requireActiveIdentity, async (req: AuthRequest<Record<string, never>> & TenancyRequest, res) => {
  try {
    const context = getTrustedDeviceContext(req, res, 'Only trusted devices can list temporary devices');
    if (!context) return;

    let devices = await temporaryDeviceRepository.findByIdentityId(context.familyId, context.device.identityId);
    for (const device of devices) {
      if (device.status === 'active' && device.expires_at.getTime() <= Date.now()) {
        await bumpChatEpochsForTemporaryDevice({
          familyId: context.familyId,
          temporaryDeviceId: device.device_id,
          reason: 'device_expired'
        });
      }
    }
    devices = await temporaryDeviceRepository.findByIdentityId(context.familyId, context.device.identityId);

    const activeDevices = devices.filter((device) => device.status === 'active');
    const approvedDeviceIds = new Set(await temporaryAccessRequestRepository.listApprovedTemporaryDeviceIds(
      context.familyId,
      activeDevices.map((device) => device.device_id),
      TRUSTED_ACCESS_REQUEST_TYPE
    ));
    const records = activeDevices.map((device) => ({
      ...toTemporaryDeviceRecord(device),
      fullAccessGrantPending: approvedDeviceIds.has(device.device_id)
    }));

    return res.json({
      status: 'ok',
      result: {
        devices: records
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List temporary devices error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to list temporary devices' }
    } as ApiResponse);
  }
});

router.post('/devices/revoke', verifySignature, requireActiveIdentity, async (req: AuthRequest<{
  deviceId?: string;
}> & TenancyRequest, res) => {
  try {
    const context = getTrustedDeviceContext(req, res, 'Only trusted devices can revoke temporary devices');
    if (!context) return;

    const { deviceId } = getSignedPayload<{ deviceId?: string }>(req);
    if (!deviceId) {
      return invalidRequestError(res, 'deviceId is required');
    }

    const temporaryDevice = await temporaryDeviceRepository.findByDeviceId(context.familyId, deviceId);
    if (!temporaryDevice) {
      return notFoundError(res, 'Temporary device not found');
    }

    if (temporaryDevice.identity_id !== context.device.identityId) {
      return forbiddenError(res, 'Temporary device belongs to a different identity');
    }

    if (temporaryDevice.status === 'revoked') {
      return invalidStateError(res, 'Temporary device is already revoked');
    }

    await bumpChatEpochsForTemporaryDevice({
      familyId: context.familyId,
      temporaryDeviceId: deviceId,
      reason: 'device_revoked'
    });
    return res.json({
      status: 'ok',
      result: {
        deviceId,
        status: 'revoked'
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Revoke temporary device error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to revoke temporary device' }
    } as ApiResponse);
  }
});

router.use(temporaryAccessChatKeyRoutes);
export default router;
