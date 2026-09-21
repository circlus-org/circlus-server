import { markWebSocketRegistered } from './wsResourceGuard';
import type { WebSocket } from 'ws';
import type {
  CallSessionId,
  DeviceId,
  IdentityId,
  PublicKey,
  SignedRequest,
  WebSocketMessage,
  WSRegisterCallRuntimeData,
  WSRegisterDirectFileTransferRuntimeData
} from '@shared/types';
import { query } from '../db';
import {
  callSessionRepository,
  identityRepository,
  temporaryDeviceRepository
} from '../db/repositories';
import {
  createNonceStore,
  consumeSignedRequestEnvelope,
  validateSignedRequestEnvelope
} from '../middleware/auth';
import { verifyExternalAdmission } from '../services/callAdmissionService';
import type { CallSessionRoutingRegistry } from '../services/callSessionRoutingRegistry';
import { verifySignature, verifySignedRequest } from '../utils/crypto';
import { serverLogger, type Logger } from '../utils/logger';
import { deriveIdentityIdFromPublicKey } from '../../../shared/identityId';
import type { ConnectionInfo, LocalConnectionInfo } from './wsConnectionContext';
import type { LinkCapabilityProof } from '../../../shared/linkCapability';
import type { CallLinkGrantResult } from '../services/callAdmissionService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

export type ExternalRegisterPayload = {
  externalIdentityId: string;
  externalPublicKey: {
    algorithm: 'ed25519' | 'x25519';
    value: string;
  };
  displayName?: string;
  admission?:
    | {
        kind: 'call_link';
        callLinkId: string;
        capabilityId: string;
        capabilityProof: LinkCapabilityProof;
        targetIdentityId: string;
      }
    | {
        kind: 'whitelist_key';
        targetIdentityId: string;
      };
};

export type WsRegistrationHandlerDependencies = {
  getSocketFamilyId: (ws: WebSocket) => string | undefined;
  getSocketCircleId?: (ws: WebSocket) => string | undefined;
  registerConnection: (
    ws: WebSocket,
    info: ConnectionInfo,
    options?: { trackDevice?: boolean }
  ) => void;
  sendMessage: (ws: WebSocket, message: WebSocketMessage) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
  touchConnectionLastSeen: (ws: WebSocket, force?: boolean) => Promise<void>;
  isTemporaryCallTargetAllowed: (
    info: LocalConnectionInfo,
    peerIdentityId: string
  ) => Promise<boolean>;
  resolvePublishedIdentityName: (
    familyId: string,
    identity: any | null
  ) => Promise<string | undefined>;
  replayStoredIceCandidates: (params: {
    ws: WebSocket;
    callSessionId: CallSessionId;
    callSession: { ice_candidates?: any } | null | undefined;
    fromIdentityId: IdentityId;
  }) => void;
  callSessionRouting: Pick<
    CallSessionRoutingRegistry,
    'get' | 'bindInitiatorRuntime' | 'bindTargetRuntime'
  >;
  describeSocket: (ws: WebSocket) => Record<string, string | undefined>;
  logCallDiag: (event: string, details: Record<string, unknown>) => void;
  validateDirectFileRuntimeRegistration: (
    scope: DirectFileRuntimeRegistrationScope
  ) => boolean | Promise<boolean>;
  logger?: Logger;
  now?: () => number;
};

type CallRuntimeRegistrationActor =
  | { ok: true; familyId: string; identityId: string; device: any }
  | { ok: false; code: string; message: string };

export type DirectFileRuntimeRegistrationScope = {
  familyId: string;
  identityId: IdentityId;
  deviceId: DeviceId;
  sessionId: string;
  remoteIdentityId: IdentityId;
  role: 'sender' | 'receiver';
};

export class WsRegistrationHandlers {
  private readonly localRegistrationNonces = createNonceStore();
  private readonly externalRegistrationNonces = createNonceStore();
  private readonly callRuntimeRegistrationNonces = createNonceStore();
  private readonly directFileRuntimeRegistrationNonces = createNonceStore();
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly dependencies: WsRegistrationHandlerDependencies) {
    this.now = dependencies.now || Date.now;
    this.logger = dependencies.logger || serverLogger.child({ subsystem: 'ws_registration' });
  }

  private hasMatchingSignedCircle(ws: WebSocket, request: SignedRequest<unknown>): boolean {
    const circleId = this.dependencies.getSocketCircleId?.(ws);
    if (!request.vpsId || !request.circleId) {
      this.dependencies.sendError(ws, 'CLIENT_UPDATE_REQUIRED', 'Signed Circle key is required');
      return false;
    }
    if (
      circleId
      && request.circleId === circleId
      && request.vpsId === getServerIdentityRuntimeConfig().vpsId
    ) return true;
    this.dependencies.sendError(ws, 'INVALID_SIGNATURE', 'Signed request targets a different Circle key');
    return false;
  }

  async handleLocal(
    ws: WebSocket,
    signedRequest: SignedRequest<any, DeviceId>
  ): Promise<void> {
    try {
      if (signedRequest?.type !== 'ws:register') {
        this.dependencies.sendError(ws, 'INVALID_STATE', 'Unexpected signed request type');
        return;
      }
      if (!this.hasMatchingSignedCircle(ws, signedRequest)) return;
      const now = this.now();
      const envelopeCheck = validateSignedRequestEnvelope(
        signedRequest,
        this.localRegistrationNonces,
        now
      );
      if (!envelopeCheck.ok) {
        this.dependencies.sendError(ws, envelopeCheck.code, envelopeCheck.message);
        return;
      }

      const socketFamilyId = this.dependencies.getSocketFamilyId(ws);
      if (!socketFamilyId) {
        this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Family context is missing');
        return;
      }

      const deviceResult = await query(
        'SELECT * FROM devices WHERE family_id = $1 AND device_id = $2 LIMIT 1',
        [socketFamilyId, signedRequest.signerId]
      );
      let device = deviceResult.rows[0] || null;
      let isTemporaryDevice = false;

      if (!device) {
        const temporaryDevice = await temporaryDeviceRepository.findByDeviceId(
          socketFamilyId,
          signedRequest.signerId
        );
        if (temporaryDevice) {
          if (temporaryDevice.status === 'revoked') {
            this.dependencies.sendError(ws, 'DEVICE_REVOKED', 'Temporary device has been revoked');
            return;
          }
          if (temporaryDevice.status === 'expired' || temporaryDevice.expires_at.getTime() <= now) {
            await temporaryDeviceRepository.terminateAccessAndRotateEpochs(
              temporaryDevice.family_id,
              temporaryDevice.device_id,
              'expired'
            );
            this.dependencies.sendError(ws, 'FORBIDDEN', 'Temporary device has expired');
            return;
          }
          device = temporaryDevice;
          isTemporaryDevice = true;
        }
      }

      if (!device) {
        this.dependencies.sendError(ws, 'DEVICE_NOT_FOUND', 'Device not found');
        return;
      }
      if (device.status !== 'active') {
        this.dependencies.sendError(ws, 'DEVICE_REVOKED', 'Device has been revoked');
        return;
      }

      const devicePublicKey = {
        algorithm: device.public_key_algorithm,
        value: device.public_key_value
      };
      if (!verifySignedRequest(signedRequest, devicePublicKey)) {
        this.dependencies.sendError(ws, 'INVALID_SIGNATURE', 'Invalid signature');
        return;
      }

      const finalEnvelope = await consumeSignedRequestEnvelope(signedRequest, this.localRegistrationNonces, this.now());
      if (!finalEnvelope.ok) {
        this.dependencies.sendError(ws, finalEnvelope.code, finalEnvelope.message);
        return;
      }

      const familyId = device.family_id;
      if (!familyId) {
        this.dependencies.sendError(ws, 'INVALID_DEVICE', 'Device has no family_id');
        return;
      }
      if (!this.assertSocketFamily(ws, familyId)) return;

      const identity = await identityRepository.findByIdentityId(familyId, device.identity_id);
      if (!identity) {
        this.dependencies.sendError(ws, 'IDENTITY_NOT_FOUND', 'Identity not found');
        return;
      }
      if (identity.status !== 'active') {
        this.dependencies.sendError(ws, 'IDENTITY_SUSPENDED', 'Identity is suspended');
        return;
      }

      const clientRuntime = signedRequest.payload?.clientRuntime === 'android_webview'
        ? 'android_webview'
        : 'web';
      const info: LocalConnectionInfo = {
        actorType: 'local',
        identityId: device.identity_id,
        deviceId: device.device_id,
        familyId,
        isTemporaryDevice,
        runtimeMode: 'default',
        clientRuntime
      };
      this.dependencies.registerConnection(ws, info, { trackDevice: true });
      await this.dependencies.touchConnectionLastSeen(ws, true);
      this.sendRegistered(ws, {
        identityId: device.identity_id,
        deviceId: device.device_id
      });

      await this.deliverPendingCalls(ws, info, clientRuntime);
      this.logger.info('ws_registration_completed', {
        familyId,
        identityId: device.identity_id,
        deviceId: device.device_id,
        isTemporaryDevice,
        clientRuntime
      });
    } catch (error) {
      this.logger.error('ws_registration_failed', {
        signerId: signedRequest?.signerId,
        error
      });
      this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Registration failed');
    }
  }

  async handleCallRuntime(ws: WebSocket, data: WSRegisterCallRuntimeData): Promise<void> {
    try {
      const signedRequest = data?.signedRequest;
      if (!signedRequest) {
        this.dependencies.sendError(ws, 'UNAUTHORIZED', 'Missing signature');
        return;
      }
      if (signedRequest.type !== 'call:runtime-register') {
        this.dependencies.sendError(ws, 'INVALID_STATE', 'Unexpected signed request type');
        return;
      }
      if (!this.hasMatchingSignedCircle(ws, signedRequest)) return;
      const now = this.now();
      const envelopeCheck = validateSignedRequestEnvelope(
        signedRequest,
        this.callRuntimeRegistrationNonces,
        now
      );
      if (!envelopeCheck.ok) {
        this.dependencies.sendError(ws, envelopeCheck.code, envelopeCheck.message);
        return;
      }

      const payload = signedRequest.payload;
      const callSessionId = String(payload?.callSessionId || '').trim();
      const remoteIdentityId = String(payload?.remoteIdentityId || '').trim();
      const role = payload?.role === 'caller' || payload?.role === 'callee' ? payload.role : null;
      const mode = payload?.mode === 'video-native' ? payload.mode : null;
      if (!callSessionId || !remoteIdentityId || !role || !mode) {
        this.dependencies.sendError(ws, 'INVALID_STATE', 'Invalid call runtime registration');
        return;
      }

      const socketFamilyId = this.dependencies.getSocketFamilyId(ws);
      if (!socketFamilyId) {
        this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Family context is missing');
        return;
      }
      const actor = await this.resolveCallRuntimeRegistrationActor(signedRequest, socketFamilyId);
      if (!actor.ok) {
        this.dependencies.sendError(ws, actor.code, actor.message);
        return;
      }
      const finalEnvelope = await consumeSignedRequestEnvelope(signedRequest, this.callRuntimeRegistrationNonces, this.now());
      if (!finalEnvelope.ok) {
        this.dependencies.sendError(ws, finalEnvelope.code, finalEnvelope.message);
        return;
      }


      const { device, familyId, identityId } = actor;
      if (!familyId || !identityId) {
        this.dependencies.sendError(ws, 'INVALID_DEVICE', 'Device has no family_id');
        return;
      }
      if (!this.assertSocketFamily(ws, familyId)) return;

      const identity = await identityRepository.findByIdentityId(familyId, identityId);
      if (!identity) {
        this.dependencies.sendError(ws, 'IDENTITY_NOT_FOUND', 'Identity not found');
        return;
      }
      if (identity.status !== 'active') {
        this.dependencies.sendError(ws, 'IDENTITY_SUSPENDED', 'Identity is suspended');
        return;
      }

      const callSession = await callSessionRepository.findByCallSessionId(familyId, callSessionId);
      if (
        callSession
        && (!callSession.participants.includes(identityId)
          || !callSession.participants.includes(remoteIdentityId))
      ) {
        this.dependencies.sendError(
          ws,
          'FORBIDDEN',
          'Call runtime registration is not valid for this call'
        );
        return;
      }

      const info: LocalConnectionInfo = {
        actorType: 'local',
        identityId: identityId as IdentityId,
        deviceId: device.device_id as DeviceId,
        familyId,
        runtimeMode: mode,
        scopedCallSessionId: callSessionId as CallSessionId
      };
      this.dependencies.registerConnection(ws, info, { trackDevice: true });
      await this.dependencies.touchConnectionLastSeen(ws, true);

      this.dependencies.logCallDiag('runtime_registered', {
        callSessionId,
        identityId,
        deviceId: device.device_id,
        mode,
        socket: this.dependencies.describeSocket(ws)
      });
      this.bindCallRuntimeSocket(ws, info, callSession);
      this.sendRegistered(ws, {
        identityId,
        deviceId: device.device_id,
        callSessionId,
        runtimeMode: mode
      });
      this.logger.info('ws_call_runtime_registration_completed', {
        familyId,
        identityId,
        deviceId: device.device_id,
        callSessionId,
        runtimeMode: mode
      });
    } catch (error) {
      this.logger.error('ws_call_runtime_registration_failed', {
        signerId: data?.signedRequest?.signerId,
        callSessionId: data?.signedRequest?.payload?.callSessionId,
        error
      });
      this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Call runtime registration failed');
    }
  }

  async handleDirectFileRuntime(
    ws: WebSocket,
    data: WSRegisterDirectFileTransferRuntimeData
  ): Promise<void> {
    try {
      const signedRequest = data?.signedRequest;
      if (!signedRequest) {
        this.dependencies.sendError(ws, 'UNAUTHORIZED', 'Missing signature');
        return;
      }
      if (signedRequest.type !== 'file-transfer:runtime-register') {
        this.dependencies.sendError(ws, 'INVALID_STATE', 'Invalid direct file runtime request type');
        return;
      }
      if (!this.hasMatchingSignedCircle(ws, signedRequest)) return;
      const now = this.now();
      const envelopeCheck = validateSignedRequestEnvelope(
        signedRequest,
        this.directFileRuntimeRegistrationNonces,
        now
      );
      if (!envelopeCheck.ok) {
        this.dependencies.sendError(ws, envelopeCheck.code, envelopeCheck.message);
        return;
      }

      const payload = signedRequest.payload;
      const sessionId = String(payload?.sessionId || '').trim();
      const declaredIdentityId = String(payload?.identityId || '').trim();
      const declaredDeviceId = String(payload?.deviceId || '').trim();
      const remoteIdentityId = String(payload?.remoteIdentityId || '').trim();
      const role = payload?.role === 'sender' || payload?.role === 'receiver'
        ? payload.role
        : null;
      const mode = payload?.mode === 'direct-file-native' ? payload.mode : null;
      if (
        !sessionId
        || !declaredIdentityId
        || !declaredDeviceId
        || !remoteIdentityId
        || !role
        || !mode
      ) {
        this.dependencies.sendError(ws, 'INVALID_STATE', 'Invalid direct file runtime registration');
        return;
      }

      const socketFamilyId = this.dependencies.getSocketFamilyId(ws);
      if (!socketFamilyId) {
        this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Family context is missing');
        return;
      }
      const actor = await this.resolveDirectFileRuntimeRegistrationActor(signedRequest, socketFamilyId);
      if (!actor.ok) {
        this.dependencies.sendError(ws, actor.code, actor.message);
        return;
      }
      const { device, familyId, identityId } = actor;
      if (identityId !== declaredIdentityId || device.device_id !== declaredDeviceId) {
        this.dependencies.sendError(
          ws,
          'FORBIDDEN',
          'Direct file runtime registration identity or device mismatch'
        );
        return;
      }
      if (!this.assertSocketFamily(ws, familyId)) return;

      const scope: DirectFileRuntimeRegistrationScope = {
        familyId,
        identityId: identityId as IdentityId,
        deviceId: device.device_id as DeviceId,
        sessionId,
        remoteIdentityId: remoteIdentityId as IdentityId,
        role
      };
      if (!await this.dependencies.validateDirectFileRuntimeRegistration(scope)) {
        this.dependencies.sendError(
          ws,
          'FORBIDDEN',
          'Direct file runtime registration is not valid for this transfer'
        );
        return;
      }

      const finalEnvelope = await consumeSignedRequestEnvelope(signedRequest, this.directFileRuntimeRegistrationNonces, this.now());
      if (!finalEnvelope.ok) {
        this.dependencies.sendError(ws, finalEnvelope.code, finalEnvelope.message);
        return;
      }

      const info: LocalConnectionInfo = {
        actorType: 'local',
        identityId: identityId as IdentityId,
        deviceId: device.device_id as DeviceId,
        familyId,
        runtimeMode: mode,
        scopedDirectFileTransferSessionId: sessionId,
        scopedRemoteIdentityId: remoteIdentityId as IdentityId,
        directFileTransferRole: role
      };
      this.dependencies.registerConnection(ws, info, { trackDevice: true });
      await this.dependencies.touchConnectionLastSeen(ws, true);
      this.sendRegistered(ws, {
        identityId,
        deviceId: device.device_id,
        directFileTransferSessionId: sessionId,
        runtimeMode: mode,
        role
      });
      this.logger.info('ws_direct_file_runtime_registration_completed', {
        familyId,
        identityId,
        deviceId: device.device_id,
        sessionId,
        remoteIdentityId,
        role,
        runtimeMode: mode
      });
    } catch (error) {
      this.logger.error('ws_direct_file_runtime_registration_failed', {
        signerId: data?.signedRequest?.signerId,
        sessionId: data?.signedRequest?.payload?.sessionId,
        error
      });
      this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Direct file runtime registration failed');
    }
  }

  async handleExternal(
    ws: WebSocket,
    signedRequest: SignedRequest<ExternalRegisterPayload, string>
  ): Promise<void> {
    try {
      const familyId = this.dependencies.getSocketFamilyId(ws);
      if (!familyId) {
        this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Family context is missing');
        return;
      }

      if (signedRequest?.type !== 'ws:register-external') {
        this.dependencies.sendError(ws, 'INVALID_STATE', 'Unexpected signed request type');
        return;
      }
      if (!this.hasMatchingSignedCircle(ws, signedRequest)) return;
      const payload = signedRequest?.payload;
      if (!payload?.externalPublicKey || !payload.externalIdentityId || !payload.admission) {
        this.dependencies.sendError(ws, 'INVALID_STATE', 'Invalid external registration payload');
        return;
      }

      const now = this.now();
      const envelopeCheck = validateSignedRequestEnvelope(
        signedRequest,
        this.externalRegistrationNonces,
        now
      );
      if (!envelopeCheck.ok) {
        this.dependencies.sendError(ws, envelopeCheck.code, envelopeCheck.message);
        return;
      }

      const derivedIdentityId = await deriveIdentityIdFromPublicKey(payload.externalPublicKey);
      const declaredIdentityId = String(payload.externalIdentityId || '').trim();
      if (!declaredIdentityId || declaredIdentityId !== derivedIdentityId) {
        this.dependencies.sendError(ws, 'INVALID_SIGNATURE', 'External identity mismatch');
        return;
      }
      if (String(signedRequest.signerId || '').trim() !== declaredIdentityId) {
        this.dependencies.sendError(ws, 'INVALID_SIGNATURE', 'Signer mismatch');
        return;
      }
      if (!verifySignedRequest(signedRequest, payload.externalPublicKey)) {
        this.dependencies.sendError(ws, 'INVALID_SIGNATURE', 'Invalid signature');
        return;
      }

      const admission = payload.admission;
      if (admission.kind !== 'call_link' && admission.kind !== 'whitelist_key') {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'Unsupported admission kind');
        return;
      }
      const targetIdentityId = String(admission.targetIdentityId || '').trim() as IdentityId;
      const grant = await verifyExternalAdmission(
        admission.kind === 'call_link'
          ? {
              kind: 'call_link',
              familyId,
              targetIdentityId,
              callLinkId: String(admission.callLinkId || '').trim(),
              capabilityId: String(admission.capabilityId || '').trim(),
              capabilityProof: admission.capabilityProof,
              externalIdentityId: declaredIdentityId,
              externalPublicKey: payload.externalPublicKey
            }
          : {
              kind: 'whitelist_key',
              familyId,
              targetIdentityId,
              externalIdentityId: declaredIdentityId,
              externalPublicKey: payload.externalPublicKey
            }
      );
      if (!grant.ok) {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'Call link admission denied');
        return;
      }

      const finalEnvelope = await consumeSignedRequestEnvelope(signedRequest, this.externalRegistrationNonces, this.now());
      if (!finalEnvelope.ok) {
        this.dependencies.sendError(ws, finalEnvelope.code, finalEnvelope.message);
        return;
      }

      const callLinkGrant = admission.kind === 'call_link'
        ? grant as CallLinkGrantResult
        : null;
      const deviceId = `ext:${declaredIdentityId}` as DeviceId;
      this.dependencies.registerConnection(ws, {
        actorType: 'external',
        identityId: declaredIdentityId as IdentityId,
        deviceId,
        familyId,
        externalPublicKey: payload.externalPublicKey,
        externalDisplayName: payload.displayName ? String(payload.displayName).trim() : undefined,
        callGrant: {
          kind: admission.kind,
          admissionId: admission.kind === 'call_link'
            ? String(admission.callLinkId || '').trim()
            : `whitelist:${declaredIdentityId}`,
          targetIdentityId,
          capabilityGrant: callLinkGrant?.descriptor && callLinkGrant.proof
            ? { descriptor: callLinkGrant.descriptor, proof: callLinkGrant.proof }
            : undefined
        }
      });
      this.sendRegistered(ws, {
        identityId: declaredIdentityId,
        deviceId,
        actorType: 'external'
      });
      this.logger.info('ws_external_registration_completed', {
        familyId,
        identityId: declaredIdentityId,
        deviceId,
        admissionKind: admission.kind,
        targetIdentityId
      });
    } catch (error) {
      this.logger.error('ws_external_registration_failed', {
        signerId: signedRequest?.signerId,
        targetIdentityId: signedRequest?.payload?.admission?.targetIdentityId,
        error
      });
      this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'External registration failed');
    }
  }

  private assertSocketFamily(ws: WebSocket, familyId: string): boolean {
    const socketFamilyId = this.dependencies.getSocketFamilyId(ws);
    if (socketFamilyId && socketFamilyId !== familyId) {
      this.dependencies.sendError(ws, 'FORBIDDEN', 'Tenant mismatch');
      return false;
    }
    return true;
  }

  private sendRegistered(ws: WebSocket, data: Record<string, unknown>): void {
    this.dependencies.sendMessage(ws, {
      type: 'registered',
      data,
      timestamp: this.now()
    });
    markWebSocketRegistered(ws);
  }

  private async deliverPendingCalls(
    ws: WebSocket,
    info: LocalConnectionInfo,
    clientRuntime: 'web' | 'android_webview'
  ): Promise<void> {
    try {
      if (clientRuntime === 'android_webview' && !info.isTemporaryDevice) return;

      const pendingCalls = await query(
        `SELECT call_session_id, initiator, sdp_offer, state, created_at
         FROM call_sessions
         WHERE family_id = $1
           AND initiator <> $2
           AND state IN ('new', 'ringing')
           AND participants @> ARRAY[$2]
           AND sdp_offer IS NOT NULL
           AND created_at > NOW() - INTERVAL '2 minutes'
         ORDER BY created_at DESC
         LIMIT 5`,
        [info.familyId, info.identityId]
      );

      for (const row of pendingCalls.rows) {
        if (
          info.isTemporaryDevice
          && !await this.dependencies.isTemporaryCallTargetAllowed(info, row.initiator)
        ) {
          continue;
        }
        let offer: any = null;
        try {
          offer = JSON.parse(row.sdp_offer);
        } catch {
          // Ignore malformed stored offers.
        }
        if (!offer) continue;

        const fromIdentity = await identityRepository.findByIdentityId(
          info.familyId,
          row.initiator
        );
        const externalMeta = offer?.__externalCaller as
          | {
              publicKey?: { algorithm: 'ed25519' | 'x25519'; value: string };
              displayName?: string | null;
              admissionKind?: 'call_link' | 'whitelist_key';
              capabilityGrant?: {
                descriptor: import('@shared/linkCapability').LinkCapabilityDescriptor;
                proof: import('@shared/linkCapability').LinkCapabilityProof;
              };
            }
          | undefined;
        const fromIdentityPublicKey = fromIdentity
          ? {
              algorithm: fromIdentity.public_key_algorithm,
              value: fromIdentity.public_key_value
            }
          : externalMeta?.publicKey;
        const fromIdentityName = fromIdentity
          ? await this.dependencies.resolvePublishedIdentityName(info.familyId, fromIdentity)
          : (externalMeta?.displayName || undefined);

        if (row.state === 'new') {
          await callSessionRepository.updateState(info.familyId, row.call_session_id, 'ringing');
        }
        this.dependencies.sendMessage(ws, {
          type: 'call:incoming',
          data: {
            callSessionId: row.call_session_id,
            fromIdentityId: row.initiator,
            fromIdentityPublicKey,
            fromIdentityName,
            isTemporaryLinkCall: externalMeta?.admissionKind === 'call_link',
            capabilityGrant: externalMeta?.capabilityGrant,
            offer
          },
          timestamp: this.now()
        });
        this.dependencies.replayStoredIceCandidates({
          ws,
          callSessionId: row.call_session_id as CallSessionId,
          callSession: row,
          fromIdentityId: row.initiator as IdentityId
        });
      }
    } catch (error) {
      this.logger.warn('ws_pending_calls_delivery_failed', {
        familyId: info.familyId,
        identityId: info.identityId,
        deviceId: info.deviceId,
        error
      });
    }
  }

  private bindCallRuntimeSocket(
    ws: WebSocket,
    info: LocalConnectionInfo,
    callSession: { initiator: string } | null
  ): void {
    const callSessionId = info.scopedCallSessionId;
    if (!callSessionId || !callSession || info.runtimeMode !== 'video-native') return;
    const route = this.dependencies.callSessionRouting.get(callSessionId);
    if (!route) return;

    if (callSession.initiator === info.identityId) {
      this.dependencies.callSessionRouting.bindInitiatorRuntime({
        callSessionId,
        identityId: info.identityId,
        ws,
        deviceId: info.deviceId
      });
      this.dependencies.logCallDiag('runtime_bound_initiator_socket', {
        callSessionId,
        identityId: info.identityId,
        deviceId: info.deviceId,
        mode: info.runtimeMode,
        socket: this.dependencies.describeSocket(ws)
      });
    } else if (route.targetIdentityId === info.identityId) {
      this.dependencies.callSessionRouting.bindTargetRuntime({
        callSessionId,
        identityId: info.identityId,
        ws,
        deviceId: info.deviceId
      });
      this.dependencies.logCallDiag('runtime_bound_target_socket', {
        callSessionId,
        identityId: info.identityId,
        deviceId: info.deviceId,
        mode: info.runtimeMode,
        socket: this.dependencies.describeSocket(ws)
      });
    }
  }

  private async resolveDirectFileRuntimeRegistrationActor(
    signedRequest: WSRegisterDirectFileTransferRuntimeData['signedRequest'],
    familyId: string
  ): Promise<CallRuntimeRegistrationActor> {
    const delegation = signedRequest.payload?.fileTransferKeyDelegation;
    if (!delegation?.payload || !delegation?.signature) {
      return {
        ok: false,
        code: 'INVALID_SIGNATURE',
        message: 'Missing direct file signing delegation'
      };
    }

    let claims: any;
    try {
      claims = JSON.parse(String(delegation.payload));
    } catch {
      return {
        ok: false,
        code: 'INVALID_SIGNATURE',
        message: 'Invalid direct file signing delegation'
      };
    }

    const identityId = String(claims.identityId || '').trim();
    const deviceId = String(claims.deviceId || '').trim();
    const identityPublicKeyValue = String(claims.identityPublicKey || '').trim();
    const transferSigningPublicKey = String(claims.transferSigningPublicKey || '').trim();
    const capabilities = Array.isArray(claims.capabilities)
      ? claims.capabilities.map((value: unknown) => String(value))
      : [];
    const requiredCapability = signedRequest.payload?.role === 'sender'
      ? 'file-transfer.send'
      : 'file-transfer.receive';
    const nowSeconds = Math.floor(this.now() / 1000);
    if (
      claims.type !== 'circlus.file-transfer-key.delegation.v1'
      || !identityId
      || !deviceId
      || !identityPublicKeyValue
      || !transferSigningPublicKey
      || signedRequest.signerId !== transferSigningPublicKey
      || !capabilities.includes(requiredCapability)
      || Number(claims.notBefore || 0) > nowSeconds
      || Number(claims.expiresAt || 0) <= nowSeconds
    ) {
      return {
        ok: false,
        code: 'INVALID_SIGNATURE',
        message: 'Invalid direct file signing delegation'
      };
    }

    const deviceResult = await query('SELECT * FROM devices WHERE family_id = $1 AND device_id = $2 LIMIT 1', [
      familyId,
      deviceId
    ]);
    const device = deviceResult.rows[0] || null;
    if (!device) return { ok: false, code: 'DEVICE_NOT_FOUND', message: 'Device not found' };
    if (device.status !== 'active') {
      return { ok: false, code: 'DEVICE_REVOKED', message: 'Device has been revoked' };
    }
    if (device.identity_id !== identityId) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'Direct file runtime registration is not valid for this device'
      };
    }

    const identity = await identityRepository.findByIdentityId(
      device.family_id,
      identityId as IdentityId
    );
    if (!identity) {
      return { ok: false, code: 'IDENTITY_NOT_FOUND', message: 'Identity not found' };
    }
    if (identity.status !== 'active') {
      return { ok: false, code: 'IDENTITY_SUSPENDED', message: 'Identity is suspended' };
    }
    if (identity.public_key_value !== identityPublicKeyValue) {
      return {
        ok: false,
        code: 'INVALID_SIGNATURE',
        message: 'Invalid direct file signing delegation'
      };
    }

    const identityPublicKey: PublicKey = {
      algorithm: identity.public_key_algorithm === 'x25519' ? 'x25519' : 'ed25519',
      value: identity.public_key_value
    };
    if (!verifySignature(String(delegation.payload), String(delegation.signature), identityPublicKey)) {
      return {
        ok: false,
        code: 'INVALID_SIGNATURE',
        message: 'Invalid direct file signing delegation'
      };
    }
    if (!verifySignedRequest(signedRequest, {
      algorithm: 'ed25519',
      value: transferSigningPublicKey
    })) {
      return { ok: false, code: 'INVALID_SIGNATURE', message: 'Invalid signature' };
    }

    return { ok: true, familyId: device.family_id, identityId, device };
  }

  private async resolveCallRuntimeRegistrationActor(
    signedRequest: WSRegisterCallRuntimeData['signedRequest'],
    familyId: string
  ): Promise<CallRuntimeRegistrationActor> {
    const delegation = signedRequest.payload?.callKeyDelegation;
    if (delegation?.payload && delegation?.signature) {
      let claims: any;
      try {
        claims = JSON.parse(String(delegation.payload));
      } catch {
        return {
          ok: false,
          code: 'INVALID_SIGNATURE',
          message: 'Invalid call signing delegation'
        };
      }

      const identityId = String(claims.identityId || '').trim();
      const deviceId = String(claims.deviceId || '').trim();
      const identityPublicKeyValue = String(claims.identityPublicKey || '').trim();
      const callSigningPublicKey = String(claims.callSigningPublicKey || '').trim();
      const capabilities = Array.isArray(claims.capabilities)
        ? claims.capabilities.map((value: unknown) => String(value))
        : [];
      const nowSeconds = Math.floor(this.now() / 1000);
      if (
        claims.type !== 'circlus.call-key.delegation.v1'
        || !identityId
        || !deviceId
        || !identityPublicKeyValue
        || !callSigningPublicKey
        || signedRequest.signerId !== callSigningPublicKey
        || (!capabilities.includes('call.offer') && !capabilities.includes('call.answer'))
        || Number(claims.notBefore || 0) > nowSeconds
        || Number(claims.expiresAt || 0) <= nowSeconds
      ) {
        return {
          ok: false,
          code: 'INVALID_SIGNATURE',
          message: 'Invalid call signing delegation'
        };
      }

      const deviceResult = await query('SELECT * FROM devices WHERE family_id = $1 AND device_id = $2 LIMIT 1', [
        familyId,
        deviceId
      ]);
      const device = deviceResult.rows[0] || null;
      if (!device) return { ok: false, code: 'DEVICE_NOT_FOUND', message: 'Device not found' };
      if (device.status !== 'active') {
        return { ok: false, code: 'DEVICE_REVOKED', message: 'Device has been revoked' };
      }
      if (device.identity_id !== identityId) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'Call runtime registration is not valid for this device'
        };
      }

      const identity = await identityRepository.findByIdentityId(device.family_id, identityId as IdentityId);
      if (!identity) {
        return { ok: false, code: 'IDENTITY_NOT_FOUND', message: 'Identity not found' };
      }
      if (identity.status !== 'active') {
        return { ok: false, code: 'IDENTITY_SUSPENDED', message: 'Identity is suspended' };
      }
      if (identity.public_key_value !== identityPublicKeyValue) {
        return {
          ok: false,
          code: 'INVALID_SIGNATURE',
          message: 'Invalid call signing delegation'
        };
      }

      const identityPublicKey: PublicKey = {
        algorithm: identity.public_key_algorithm === 'x25519' ? 'x25519' : 'ed25519',
        value: identity.public_key_value
      };
      if (!verifySignature(String(delegation.payload), String(delegation.signature), identityPublicKey)) {
        return {
          ok: false,
          code: 'INVALID_SIGNATURE',
          message: 'Invalid call signing delegation'
        };
      }
      if (!verifySignedRequest(signedRequest, { algorithm: 'ed25519', value: callSigningPublicKey })) {
        return { ok: false, code: 'INVALID_SIGNATURE', message: 'Invalid signature' };
      }

      return { ok: true, familyId: device.family_id, identityId, device };
    }

    const deviceResult = await query('SELECT * FROM devices WHERE family_id = $1 AND device_id = $2 LIMIT 1', [
      familyId,
      signedRequest.signerId
    ]);
    const device = deviceResult.rows[0] || null;
    if (!device) return { ok: false, code: 'DEVICE_NOT_FOUND', message: 'Device not found' };
    if (device.status !== 'active') {
      return { ok: false, code: 'DEVICE_REVOKED', message: 'Device has been revoked' };
    }

    const devicePublicKey: PublicKey = {
      algorithm: device.public_key_algorithm,
      value: device.public_key_value
    };
    if (!verifySignedRequest(signedRequest, devicePublicKey)) {
      return { ok: false, code: 'INVALID_SIGNATURE', message: 'Invalid signature' };
    }
    return {
      ok: true,
      familyId: device.family_id,
      identityId: device.identity_id,
      device
    };
  }
}
