import type { WebSocket } from 'ws';
import type {
  DeviceId,
  DirectFileTransferSessionId,
  IdentityId,
  WebSocketMessage,
  WSDirectFileTransferAcceptData,
  WSDirectFileTransferBootstrapData,
  WSDirectFileTransferEndedData,
  WSDirectFileTransferIceCandidateData,
  WSDirectFileTransferCompletedData,
  WSDirectFileTransferIncomingData,
  WSDirectFileTransferOfferData,
  WSDirectFileTransferRejectData
} from '@shared/types';
import {
  deviceRepository,
  directGuestRegistrationRepository,
  identityRepository
} from '../db/repositories';
import { sendPushToDevice, sendPushToIdentity } from '../utils/push';
import { configService } from './configService';
import { resolveDirectCommunicationAccess } from './directGuestAccessService';
import { validateQuickReceiveGrant } from './quickReceiveGrantPolicy';
import {
  DirectFileTransferSessionRegistry,
  type DirectFileTransferSession
} from './directFileTransferSessionRegistry';
import { serverLogger } from '../utils/logger';

const logger = serverLogger.child({ subsystem: 'direct_file_transfer' });

export type DirectFileTransferConnectionInfo = {
  actorType: 'local' | 'external';
  identityId: IdentityId;
  deviceId: DeviceId;
  familyId: string;
  isTemporaryDevice?: boolean;
  runtimeMode?: 'default' | 'video-native' | 'direct-file-native';
  scopedDirectFileTransferSessionId?: DirectFileTransferSessionId;
  scopedRemoteIdentityId?: IdentityId;
  directFileTransferRole?: 'sender' | 'receiver';
};

export type DirectFileTransferSignalingDependencies = {
  getConnectionInfo: (ws: WebSocket) => DirectFileTransferConnectionInfo | undefined;
  getIdentitySockets: (familyId: string, identityId: IdentityId) => Set<WebSocket> | undefined;
  getDeviceSockets: (deviceId: DeviceId) => Set<WebSocket> | undefined;
  sendMessage: (ws: WebSocket, message: WebSocketMessage) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
  resolvePublishedIdentityName: (
    familyId: string,
    identity: Awaited<ReturnType<typeof identityRepository.findByIdentityId>>
  ) => Promise<string | undefined>;
  resolveAccess?: typeof resolveDirectCommunicationAccess;
  touchDirectGuest?: (familyId: string, guestIdentityId: IdentityId) => Promise<void>;
  findIdentity?: typeof identityRepository.findByIdentityId;
  findDevice?: typeof deviceRepository.findByDeviceId;
  validateGrant?: typeof validateQuickReceiveGrant;
  wakeTargetDevice?: (params: {
    info: DirectFileTransferConnectionInfo;
    targetDeviceId: DeviceId;
    targetIdentityId: IdentityId;
    sessionId: DirectFileTransferSessionId;
    fromIdentityName?: string;
  }) => Promise<void>;
  wakeTargetIdentity?: (params: {
    info: DirectFileTransferConnectionInfo;
    targetIdentityId: IdentityId;
    sessionId: DirectFileTransferSessionId;
    fromIdentityName?: string;
  }) => Promise<void>;
  notifyTargetIdentityResolution?: (params: {
    familyId: string;
    targetIdentityId: IdentityId;
    sessionId: DirectFileTransferSessionId;
    status: 'accepted' | 'rejected' | 'cancelled' | 'expired';
  }) => Promise<void>;
  now?: () => number;
  sessionTtlMs?: number;
  registry?: DirectFileTransferSessionRegistry;
};

export class DirectFileTransferSignalingService {
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  hasIdentity(familyId: string, identityId: string): boolean { return this.registry.hasIdentity(familyId, identityId); }

  hasSocket(ws: WebSocket): boolean { return this.registry.hasSocket(ws); }

  private readonly registry: DirectFileTransferSessionRegistry;

  constructor(private readonly dependencies: DirectFileTransferSignalingDependencies) {
    this.now = dependencies.now || Date.now;
    this.sessionTtlMs = Math.max(1_000, dependencies.sessionTtlMs || 10 * 60 * 1000);
    this.registry = dependencies.registry || new DirectFileTransferSessionRegistry({
      now: this.now,
      onExpire: (session) => {
        this.sendEnded(session.initiatorWs, session.incomingData.sessionId, 'session_expired');
        if (session.targetWs) {
          this.sendEnded(session.targetWs, session.incomingData.sessionId, 'session_expired');
        }
        void this.notifyTargetIdentityResolution(session, 'expired');
      }
    });
  }

  validateRuntimeRegistration(params: {
    familyId: string;
    identityId: IdentityId;
    deviceId: DeviceId;
    sessionId: string;
    remoteIdentityId: IdentityId;
    role: 'sender' | 'receiver';
  }): boolean {
    if (params.role === 'sender') {
      return !this.registry.get(params.sessionId as DirectFileTransferSessionId);
    }
    const session = this.registry.get(params.sessionId as DirectFileTransferSessionId);
    if (!session) return false;
    return session.familyId === params.familyId
      && session.targetIdentityId === params.identityId
      && session.initiatorIdentityId === params.remoteIdentityId
      && (
        session.targetDeviceIds?.includes(params.deviceId)
        || (!session.targetDeviceIds
          && (!session.targetDeviceId || session.targetDeviceId === params.deviceId))
      );
  }

  async handleOffer(ws: WebSocket, data: WSDirectFileTransferOfferData): Promise<void> {
    const info = this.requireConnection(ws);
    if (!info || this.rejectTemporary(ws, info)) return;

    const sessionId = String(data.sessionId || '').trim() as DirectFileTransferSessionId;
    const targetIdentityId = String(data.targetIdentityId || '').trim() as IdentityId;
    const targetDeviceId = String(data.targetDeviceId || '').trim() as DeviceId;
    const rawQuickTargets = Array.isArray(data.quickTargets) ? data.quickTargets : [];
    const quickTargets = rawQuickTargets
      .map((target) => ({
        targetDeviceId: String(target?.targetDeviceId || '').trim() as DeviceId,
        autoReceiveGrant: target?.autoReceiveGrant
      }))
      .filter((target) => target.targetDeviceId && target.autoReceiveGrant);
    const { metadata, offer, autoReceiveGrant } = data;
    if (!sessionId || !targetIdentityId || !metadata?.fileName || !Number.isFinite(metadata.size) || metadata.size <= 0 || !offer) {
      this.dependencies.sendError(ws, 'VALIDATION_ERROR', 'Missing direct file transfer fields');
      return;
    }
    if (!this.assertRuntimeScope(ws, info, sessionId, ['sender'], targetIdentityId)) return;
    if (rawQuickTargets.length > 32 || quickTargets.length !== rawQuickTargets.length) {
      this.dependencies.sendError(ws, 'VALIDATION_ERROR', 'Invalid quick receive targets');
      return;
    }
    if (this.registry.get(sessionId)) {
      this.dependencies.sendError(ws, 'INVALID_STATE', 'Direct file transfer session already exists');
      return;
    }

    if (info.identityId !== targetIdentityId) {
      const access = await (this.dependencies.resolveAccess || resolveDirectCommunicationAccess)(
        info.familyId,
        info.identityId,
        targetIdentityId,
        'direct_files'
      );
      if (!access.allowed) {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'Direct file transfer is not allowed');
        return;
      }
      if (access.relation === 'direct_guest') {
        await (this.dependencies.touchDirectGuest
          || ((familyId, guestIdentityId) => directGuestRegistrationRepository.touchLastSeen(familyId, guestIdentityId)))(
          info.familyId,
          access.guestIdentityId
        );
      }
    }

    if (targetDeviceId && quickTargets.length > 0) {
      this.dependencies.sendError(ws, 'VALIDATION_ERROR', 'Use either one target device or quick receive targets');
      return;
    }

    const addressedTargets = quickTargets.length > 0
      ? quickTargets
      : targetDeviceId
        ? [{ targetDeviceId, autoReceiveGrant }]
        : [];
    const uniqueTargetIds = [...new Set(addressedTargets.map((target) => target.targetDeviceId))] as DeviceId[];
    if (uniqueTargetIds.length !== addressedTargets.length) {
      this.dependencies.sendError(ws, 'VALIDATION_ERROR', 'Duplicate quick receive target device');
      return;
    }

    if (addressedTargets.length > 0) {
      const targetIdentity = await (
        this.dependencies.findIdentity || identityRepository.findByIdentityId.bind(identityRepository)
      )(info.familyId, targetIdentityId);
      const targetDevices = await Promise.all(addressedTargets.map((target) => (
        this.dependencies.findDevice || deviceRepository.findByDeviceId.bind(deviceRepository)
      )(info.familyId, target.targetDeviceId)));
      for (const [index, target] of addressedTargets.entries()) {
        const targetDevice = targetDevices[index];
        const validTarget = targetIdentity?.status === 'active'
          && targetDevice?.status === 'active'
          && targetDevice.identity_id === targetIdentityId;
        const validGrant = info.identityId === targetIdentityId && !target.autoReceiveGrant
          ? validTarget
          : (this.dependencies.validateGrant || validateQuickReceiveGrant)({
              grant: target.autoReceiveGrant,
              senderIdentityId: info.identityId,
              targetIdentityId,
              targetDeviceId: target.targetDeviceId,
              fileSize: metadata.size,
              targetIdentity: targetIdentity ? {
                status: targetIdentity.status,
                publicKey: {
                  algorithm: targetIdentity.public_key_algorithm === 'ed25519' ? 'ed25519' : 'x25519',
                  value: targetIdentity.public_key_value
                }
              } : null,
              targetDevice: targetDevice ? {
                status: targetDevice.status,
                identityId: targetDevice.identity_id
              } : null
            });
        if (!validGrant) {
          this.dependencies.sendError(ws, 'FORBIDDEN', 'A valid quick receive grant is required for this device');
          return;
        }
      }
    } else if (autoReceiveGrant || info.identityId === targetIdentityId) {
      this.dependencies.sendError(ws, 'FORBIDDEN', 'A target device and valid quick receive grant are required');
      return;
    }

    const targetSockets = addressedTargets.length > 0
      ? new Set(addressedTargets.flatMap((target) => [
          ...(this.dependencies.getDeviceSockets(target.targetDeviceId) || [])
        ]))
      : this.dependencies.getIdentitySockets(info.familyId, targetIdentityId);
    const eligibleTargetSockets = new Set(
      [...(targetSockets || [])].filter((targetWs) => {
        const targetInfo = this.dependencies.getConnectionInfo(targetWs);
        return targetInfo?.familyId === info.familyId
          && targetInfo.identityId === targetIdentityId
          && (targetInfo.actorType !== 'local' || !targetInfo.isTemporaryDevice)
          && (uniqueTargetIds.length === 0 || uniqueTargetIds.includes(targetInfo.deviceId));
      })
    );

    const fromIdentity = await (
      this.dependencies.findIdentity || identityRepository.findByIdentityId.bind(identityRepository)
    )(info.familyId, info.identityId);
    const fromDevice = info.identityId === targetIdentityId
      ? await (this.dependencies.findDevice || deviceRepository.findByDeviceId.bind(deviceRepository))(
          info.familyId,
          info.deviceId
        )
      : null;
    const fromIdentityName = await this.dependencies.resolvePublishedIdentityName(info.familyId, fromIdentity);
    const incomingData: WSDirectFileTransferIncomingData = {
      sessionId,
      fromIdentityId: info.identityId,
      fromIdentityName,
      ...(fromDevice ? {
        fromDeviceId: info.deviceId,
        ...(fromDevice.label ? { fromDeviceLabel: fromDevice.label } : {})
      } : {}),
      metadata,
      offer
    };
    const incomingDataByDevice = Object.fromEntries(addressedTargets.map((target) => [
      target.targetDeviceId,
      {
        ...incomingData,
        targetDeviceId: target.targetDeviceId,
        ...(target.autoReceiveGrant ? { autoReceiveGrant: target.autoReceiveGrant } : {})
      }
    ]));
    const registered = this.registry.register({
      familyId: info.familyId,
      initiatorIdentityId: info.identityId,
      initiatorWs: ws,
      targetIdentityId,
      targetDeviceId: targetDeviceId || undefined,
      targetDeviceIds: quickTargets.length > 0 ? uniqueTargetIds : undefined,
      incomingData,
      incomingDataByDevice: addressedTargets.length > 0 ? incomingDataByDevice : undefined,
      expiresAt: this.now() + this.sessionTtlMs
    });
    if (!registered) {
      this.dependencies.sendError(ws, 'INVALID_STATE', 'Direct file transfer session already exists');
      return;
    }

    if (addressedTargets.length === 0) {
      await (this.dependencies.wakeTargetIdentity || ((params) => this.wakeTargetIdentity(params)))({
        info,
        targetIdentityId,
        sessionId,
        fromIdentityName
      });
      for (const targetWs of eligibleTargetSockets) this.sendIncoming(targetWs, incomingData);
      return;
    }

    const connectedTargetDeviceIds = new Set([...eligibleTargetSockets].map((targetWs) => (
      this.dependencies.getConnectionInfo(targetWs)?.deviceId
    )).filter(Boolean));
    await Promise.all(addressedTargets
      .filter((target) => !connectedTargetDeviceIds.has(target.targetDeviceId))
      .map((target) => (
        this.dependencies.wakeTargetDevice || ((params) => this.wakeTargetDevice(params))
      )({
        info,
        targetDeviceId: target.targetDeviceId,
        targetIdentityId,
        sessionId,
        fromIdentityName
      })));
    for (const targetWs of eligibleTargetSockets) {
      const targetInfo = this.dependencies.getConnectionInfo(targetWs);
      this.sendIncoming(targetWs, targetInfo
        ? incomingDataByDevice[targetInfo.deviceId] || incomingData
        : incomingData);
    }
  }

  handleBootstrap(ws: WebSocket, data: WSDirectFileTransferBootstrapData): void {
    const info = this.requireConnection(ws);
    if (!info || this.rejectTemporary(ws, info)) return;
    const sessionId = String(data.sessionId || '').trim() as DirectFileTransferSessionId;
    if (!this.assertRuntimeScope(ws, info, sessionId, ['receiver'])) return;
    const session = this.registry.get(sessionId);
    if (!session) {
      this.dependencies.sendError(ws, 'NOT_FOUND', 'Direct file transfer session not found');
      return;
    }
    if (!this.isTargetSocket(session, ws, info)) {
      this.dependencies.sendError(ws, 'FORBIDDEN', 'Direct file transfer is addressed to another device');
      return;
    }
    this.sendIncoming(ws, session.incomingDataByDevice?.[info.deviceId] || session.incomingData);
  }

  async handleRenotify(ws: WebSocket, data: WSDirectFileTransferBootstrapData): Promise<void> {
    const info = this.requireConnection(ws);
    if (!info || this.rejectTemporary(ws, info)) return;
    const sessionId = String(data.sessionId || '').trim() as DirectFileTransferSessionId;
    if (!this.assertRuntimeScope(ws, info, sessionId, ['sender'])) return;
    const session = this.registry.get(sessionId);
    if (!session) {
      this.dependencies.sendError(ws, 'NOT_FOUND', 'Direct file transfer session not found');
      return;
    }
    if (this.resolveRole(session, ws, info) !== 'initiator') {
      this.dependencies.sendError(ws, 'FORBIDDEN', 'Only the transfer sender can repeat the request');
      return;
    }
    if (session.targetWs) {
      this.dependencies.sendError(ws, 'INVALID_STATE', 'Direct file transfer was already accepted');
      return;
    }

    const targetDeviceIds = session.targetDeviceIds?.length
      ? session.targetDeviceIds
      : session.targetDeviceId
        ? [session.targetDeviceId]
        : [];
    const targetSockets = targetDeviceIds.length > 0
      ? new Set(targetDeviceIds.flatMap((deviceId) => [
          ...(this.dependencies.getDeviceSockets(deviceId) || [])
        ]))
      : this.dependencies.getIdentitySockets(session.familyId, session.targetIdentityId);
    const eligibleTargetSockets = new Set([...(targetSockets || [])].filter((targetWs) => {
      const targetInfo = this.dependencies.getConnectionInfo(targetWs);
      return targetInfo && this.matchesTargetDevice(session, targetInfo)
        && (targetInfo.actorType !== 'local' || !targetInfo.isTemporaryDevice);
    }));

    for (const targetWs of eligibleTargetSockets) {
      const targetInfo = this.dependencies.getConnectionInfo(targetWs);
      this.sendIncoming(targetWs, targetInfo
        ? session.incomingDataByDevice?.[targetInfo.deviceId] || session.incomingData
        : session.incomingData);
    }

    const connectedTargetDeviceIds = new Set([...eligibleTargetSockets].map((targetWs) => (
      this.dependencies.getConnectionInfo(targetWs)?.deviceId
    )).filter(Boolean));
    const fromIdentityName = session.incomingData.fromIdentityName;
    if (targetDeviceIds.length > 0) {
      await Promise.all(targetDeviceIds
        .filter((deviceId) => !connectedTargetDeviceIds.has(deviceId))
        .map((targetDeviceId) => (
          this.dependencies.wakeTargetDevice || ((params) => this.wakeTargetDevice(params))
        )({
          info,
          targetDeviceId,
          targetIdentityId: session.targetIdentityId,
          sessionId,
          fromIdentityName
        })));
    } else if (eligibleTargetSockets.size === 0) {
      await (this.dependencies.wakeTargetIdentity || ((params) => this.wakeTargetIdentity(params)))({
        info,
        targetIdentityId: session.targetIdentityId,
        sessionId,
        fromIdentityName
      });
    }
  }

  handleAccept(ws: WebSocket, data: WSDirectFileTransferAcceptData): void {
    const info = this.requireConnection(ws);
    if (!info || this.rejectTemporary(ws, info)) return;
    const sessionId = String(data.sessionId || '').trim() as DirectFileTransferSessionId;
    if (!this.assertRuntimeScope(ws, info, sessionId, ['receiver'])) return;
    if (!sessionId || !data.answer) {
      this.dependencies.sendError(ws, 'VALIDATION_ERROR', 'Missing direct file transfer accept payload');
      return;
    }
    const session = this.registry.get(sessionId);
    if (!session || !this.matchesTargetDevice(session, info)) {
      this.dependencies.sendError(ws, 'FORBIDDEN', 'Direct file transfer session not found');
      return;
    }
    if (session.targetWs) {
      if (session.targetWs !== ws) {
        this.sendRejected(ws, sessionId, 'accepted_on_another_tab');
      }
      return;
    }
    this.registry.bindTarget(sessionId, ws);
    this.dependencies.sendMessage(session.initiatorWs, {
      type: 'file-transfer:accepted',
      data: {
        sessionId,
        answer: data.answer,
        ...(Number(data.transferProtocolVersion || 0) > 0
          ? { transferProtocolVersion: Number(data.transferProtocolVersion) }
          : {})
      },
      timestamp: this.now()
    });
    for (const candidate of this.registry.drainTargetCandidates(sessionId, ws)) {
      this.sendIce(session.initiatorWs, candidate);
    }
    for (const candidate of this.registry.drainInitiatorCandidates(sessionId)) {
      this.dependencies.sendMessage(ws, {
        type: 'file-transfer:ice-candidate',
        data: candidate,
        timestamp: this.now()
      });
    }
    this.closeOtherTargetSockets(session, ws, 'accepted_on_another_device');
    void this.notifyTargetIdentityResolution(session, 'accepted');
  }

  handleReject(ws: WebSocket, data: WSDirectFileTransferRejectData): void {
    const info = this.requireConnection(ws);
    if (!info || this.rejectTemporary(ws, info)) return;
    const sessionId = String(data.sessionId || '').trim() as DirectFileTransferSessionId;
    if (!this.assertRuntimeScope(ws, info, sessionId, ['receiver'])) return;
    const session = this.registry.get(sessionId);
    if (!session) return;
    const role = this.resolveRole(session, ws, info);
    if (!role) {
      this.dependencies.sendError(ws, 'FORBIDDEN', 'Not a participant in this transfer');
      return;
    }
    const peerWs = role === 'initiator' ? session.targetWs : session.initiatorWs;
    if (peerWs) this.sendRejected(peerWs, sessionId, data.reason || 'Transfer rejected');
    if (role === 'target') {
      this.closeOtherTargetSockets(session, ws, 'rejected_on_another_device');
      void this.notifyTargetIdentityResolution(session, 'rejected');
    } else {
      void this.notifyTargetIdentityResolution(session, 'cancelled');
    }
    this.registry.remove(sessionId);
  }

  handleIceCandidate(ws: WebSocket, data: WSDirectFileTransferIceCandidateData): void {
    const info = this.requireConnection(ws);
    if (!info || this.rejectTemporary(ws, info)) return;
    const sessionId = String(data.sessionId || '').trim() as DirectFileTransferSessionId;
    if (!this.assertRuntimeScope(ws, info, sessionId, ['sender', 'receiver'])) return;
    const session = this.registry.get(sessionId);
    if (!session || !data.candidate) {
      this.dependencies.sendError(ws, 'NOT_FOUND', 'Direct file transfer session not found');
      return;
    }
    const role = this.resolveRole(session, ws, info);
    if (!role) {
      this.dependencies.sendError(ws, 'FORBIDDEN', 'Not a participant in this transfer');
      return;
    }
    if (role === 'initiator') {
      if (session.targetWs) {
        this.sendIce(session.targetWs, data);
      } else if (!this.registry.bufferInitiatorCandidate(sessionId, data)) {
        this.dependencies.sendError(ws, 'RATE_LIMIT', 'Too many pending ICE candidates');
      }
      return;
    }
    if (session.targetWs === ws) {
      this.sendIce(session.initiatorWs, data);
    } else if (!session.targetWs && !this.registry.bufferTargetCandidate(sessionId, ws, data)) {
      this.dependencies.sendError(ws, 'RATE_LIMIT', 'Too many pending ICE candidates');
    }
  }

  handleComplete(ws: WebSocket, data: WSDirectFileTransferCompletedData): void {
    const info = this.requireConnection(ws);
    if (!info || this.rejectTemporary(ws, info)) return;
    const sessionId = String(data.sessionId || '').trim() as DirectFileTransferSessionId;
    if (!this.assertRuntimeScope(ws, info, sessionId, ['receiver'])) return;
    const session = this.registry.get(sessionId);
    if (!session || session.targetWs !== ws || !this.matchesTargetDevice(session, info)) {
      this.dependencies.sendError(ws, 'FORBIDDEN', 'Direct file transfer session not found');
      return;
    }
    const receivedBytes = Number(data.receivedBytes);
    if (!Number.isFinite(receivedBytes) || receivedBytes !== session.incomingData.metadata.size) {
      this.dependencies.sendError(ws, 'VALIDATION_ERROR', 'Invalid completed byte count');
      return;
    }
    const completedMessage: WebSocketMessage = {
      type: 'file-transfer:completed',
      data: { sessionId, receivedBytes },
      timestamp: this.now()
    };
    // Retire the route before acknowledging the receiver. A push-scoped client
    // closes its socket as soon as this acknowledgement arrives; removing first
    // prevents that normal close from being reported to the sender as
    // peer_disconnected.
    this.registry.remove(sessionId);
    this.dependencies.sendMessage(session.initiatorWs, completedMessage);
    this.dependencies.sendMessage(ws, completedMessage);
  }

  handleCancel(ws: WebSocket, data: WSDirectFileTransferEndedData): void {
    const info = this.requireConnection(ws);
    if (!info || this.rejectTemporary(ws, info)) return;
    const sessionId = String(data.sessionId || '').trim() as DirectFileTransferSessionId;
    if (!this.assertRuntimeScope(ws, info, sessionId, ['sender', 'receiver'])) return;
    const session = this.registry.get(sessionId);
    if (!session) return;
    const role = this.resolveRole(session, ws, info);
    if (!role) {
      this.dependencies.sendError(ws, 'FORBIDDEN', 'Not a participant in this transfer');
      return;
    }
    const peerWs = role === 'initiator' ? session.targetWs : session.initiatorWs;
    if (peerWs) this.sendEnded(peerWs, sessionId, data.reason || 'cancelled');
    this.closeOtherTargetSockets(session, role === 'target' ? ws : (session.targetWs || ws), 'cancelled_on_another_device');
    void this.notifyTargetIdentityResolution(session, 'cancelled');
    this.registry.remove(sessionId);
  }

  handleSocketClosed(ws: WebSocket): void {
    for (const detached of this.registry.detachSocket(ws)) {
      if (detached.role === 'initiator') {
        if (detached.session.targetWs) {
          this.sendEnded(detached.session.targetWs, detached.sessionId, 'peer_disconnected');
        }
        void this.notifyTargetIdentityResolution(detached.session, 'cancelled');
        continue;
      }
      this.registry.remove(detached.sessionId);
      this.sendEnded(detached.session.initiatorWs, detached.sessionId, 'peer_disconnected');
    }
  }

  private requireConnection(ws: WebSocket): DirectFileTransferConnectionInfo | undefined {
    const info = this.dependencies.getConnectionInfo(ws);
    if (!info) this.dependencies.sendError(ws, 'UNAUTHORIZED', 'Not authenticated');
    return info;
  }

  private rejectTemporary(ws: WebSocket, info: DirectFileTransferConnectionInfo): boolean {
    if (info.actorType !== 'local' || !info.isTemporaryDevice) return false;
    this.dependencies.sendError(ws, 'FORBIDDEN', 'Temporary devices cannot access direct file transfers');
    return true;
  }

  private assertRuntimeScope(
    ws: WebSocket,
    info: DirectFileTransferConnectionInfo,
    sessionId: DirectFileTransferSessionId,
    allowedRoles: Array<'sender' | 'receiver'>,
    remoteIdentityId?: IdentityId
  ): boolean {
    if (info.runtimeMode !== 'direct-file-native') return true;
    const valid = !!sessionId
      && info.scopedDirectFileTransferSessionId === sessionId
      && !!info.directFileTransferRole
      && allowedRoles.includes(info.directFileTransferRole)
      && (!remoteIdentityId || info.scopedRemoteIdentityId === remoteIdentityId);
    if (!valid) {
      this.dependencies.sendError(
        ws,
        'FORBIDDEN',
        'Direct file runtime registration is not valid for this transfer'
      );
    }
    return valid;
  }

  private isTargetSocket(
    session: DirectFileTransferSession,
    ws: WebSocket,
    info: DirectFileTransferConnectionInfo
  ): boolean {
    return this.matchesTargetDevice(session, info)
      && (!session.targetWs || session.targetWs === ws);
  }

  private matchesTargetDevice(
    session: DirectFileTransferSession,
    info: DirectFileTransferConnectionInfo
  ): boolean {
    return session.familyId === info.familyId
      && session.targetIdentityId === info.identityId
      && (
        session.targetDeviceIds?.includes(info.deviceId)
        || (!session.targetDeviceIds && (!session.targetDeviceId || session.targetDeviceId === info.deviceId))
      );
  }

  private closeOtherTargetSockets(
    session: DirectFileTransferSession,
    resolvedWs: WebSocket,
    reason: string
  ): void {
    const sockets = this.dependencies.getIdentitySockets(session.familyId, session.targetIdentityId);
    for (const candidateWs of sockets || []) {
      if (candidateWs === resolvedWs) continue;
      const candidateInfo = this.dependencies.getConnectionInfo(candidateWs);
      if (candidateInfo && this.matchesTargetDevice(session, candidateInfo)) {
        this.sendRejected(candidateWs, session.incomingData.sessionId, reason);
      }
    }
  }

  private resolveRole(
    session: DirectFileTransferSession,
    ws: WebSocket,
    info: DirectFileTransferConnectionInfo
  ): 'initiator' | 'target' | null {
    if (
      session.familyId === info.familyId
      && session.initiatorIdentityId === info.identityId
      && session.initiatorWs === ws
    ) return 'initiator';
    return this.isTargetSocket(session, ws, info) ? 'target' : null;
  }

  private sendIncoming(ws: WebSocket, data: DirectFileTransferSession['incomingData']): void {
    this.dependencies.sendMessage(ws, {
      type: 'file-transfer:incoming',
      data,
      timestamp: this.now()
    });
  }

  private sendRejected(ws: WebSocket, sessionId: string, reason: string): void {
    this.dependencies.sendMessage(ws, {
      type: 'file-transfer:rejected',
      data: { sessionId, reason },
      timestamp: this.now()
    });
  }

  private sendIce(ws: WebSocket, data: WSDirectFileTransferIceCandidateData): void {
    this.dependencies.sendMessage(ws, {
      type: 'file-transfer:ice-candidate',
      data,
      timestamp: this.now()
    });
  }

  private sendEnded(ws: WebSocket, sessionId: string, reason: string): void {
    this.dependencies.sendMessage(ws, {
      type: 'file-transfer:ended',
      data: { sessionId, reason },
      timestamp: this.now()
    });
  }

  private async wakeTargetDevice(params: {
    info: DirectFileTransferConnectionInfo;
    targetDeviceId: DeviceId;
    targetIdentityId: IdentityId;
    sessionId: DirectFileTransferSessionId;
    fromIdentityName?: string;
  }): Promise<void> {
    try {
      const familyConfig = await configService.requireFamilyConfig(params.info.familyId);
      const serverOrigin = familyConfig.public_base_url;
      const serverDisplayHint = (familyConfig.server_name || '').trim() || serverOrigin;
      await sendPushToDevice(
        params.info.familyId,
        params.targetDeviceId,
        {
          type: 'direct_file_transfer',
          directFileTransferSessionId: params.sessionId,
          fromIdentityId: params.info.identityId,
          fromIdentityName: params.fromIdentityName,
          targetIdentityId: params.targetIdentityId,
          targetDeviceId: params.targetDeviceId
        },
        params.targetIdentityId,
        familyConfig.public_base_url,
        serverOrigin,
        serverOrigin,
        serverDisplayHint
      );
    } catch (error) {
      logger.warn('direct_file_transfer_device_wake_failed', {
        targetDeviceId: params.targetDeviceId,
        error
      });
    }
  }

  private async wakeTargetIdentity(params: {
    info: DirectFileTransferConnectionInfo;
    targetIdentityId: IdentityId;
    sessionId: DirectFileTransferSessionId;
    fromIdentityName?: string;
  }): Promise<void> {
    try {
      await sendPushToIdentity(params.info.familyId, params.targetIdentityId, {
        type: 'direct_file_transfer',
        directFileTransferSessionId: params.sessionId,
        fromIdentityId: params.info.identityId,
        fromIdentityName: params.fromIdentityName,
        targetIdentityId: params.targetIdentityId
      });
    } catch (error) {
      logger.warn('direct_file_transfer_identity_wake_failed', {
        targetIdentityId: params.targetIdentityId,
        error
      });
    }
  }

  private async notifyTargetIdentityResolution(
    session: DirectFileTransferSession,
    status: 'accepted' | 'rejected' | 'cancelled' | 'expired'
  ): Promise<void> {
    const params = {
      familyId: session.familyId,
      targetIdentityId: session.targetIdentityId,
      sessionId: session.incomingData.sessionId,
      status
    };
    if (this.dependencies.notifyTargetIdentityResolution) {
      await this.dependencies.notifyTargetIdentityResolution(params);
      return;
    }
    try {
      await sendPushToIdentity(params.familyId, params.targetIdentityId, {
        type: 'direct_file_transfer_status',
        directFileTransferSessionId: params.sessionId,
        directFileTransferStatus: status,
        targetIdentityId: params.targetIdentityId
      });
    } catch (error) {
      logger.warn('direct_file_transfer_resolution_push_failed', {
        targetIdentityId: params.targetIdentityId,
        sessionId: params.sessionId,
        status,
        error
      });
    }
  }
}
