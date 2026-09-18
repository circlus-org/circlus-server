import type { WebSocket } from 'ws';
import type { CallSessionId, IdentityId } from '@shared/types';
import type {
  LinkCapabilityDescriptor,
  LinkCapabilityProof
} from '@shared/linkCapability';
import {
  callHistoryRepository,
  callSessionRepository,
  directGuestRegistrationRepository,
  identityRepository
} from '../db/repositories';
import { resolveDirectCommunicationAccess } from '../services/directGuestAccessService';
import { verifyCapabilityProof } from '../services/linkCapabilityService';
import { ensureCallIceStats } from './callIceDiagnostics';
import type { ConnectionInfo } from './wsConnectionContext';
import type {
  CallSignalingWsHandlerDependencies,
  CallSignalingWsHandlerRuntime
} from './callSignalingWsHandlerDependencies';

export class CallOfferWsHandler {
  private readonly now: () => number;
  private readonly createCallSessionId: () => CallSessionId;
  private readonly logger: CallSignalingWsHandlerRuntime['logger'];

  constructor(
    private readonly dependencies: CallSignalingWsHandlerDependencies,
    runtime: CallSignalingWsHandlerRuntime
  ) {
    this.now = runtime.now;
    this.createCallSessionId = runtime.createCallSessionId;
    this.logger = runtime.logger;
  }
  async handleOffer(ws: WebSocket, data: any): Promise<void> {
    try {
      const info = this.dependencies.getConnectionInfo(ws);
      if (!info) {
        this.dependencies.sendError(ws, 'UNAUTHORIZED', 'Not authenticated');
        return;
      }

      const { familyId } = info;
      const {
        targetIdentityId,
        offer,
        callSessionId: clientCallSessionId,
        supersedesCallSessionId: rawSupersedesCallSessionId
      } = data;
      this.logger.info('call_offer_received', {
        familyId,
        fromIdentityId: info.identityId,
        deviceId: info.deviceId,
        targetIdentityId,
        clientCallSessionId,
        offerBytes: offer ? Buffer.byteLength(JSON.stringify(offer), 'utf8') : 0
      });

      if (!targetIdentityId || !offer) {
        this.logger.warn('call_offer_validation_failed', {
          familyId,
          fromIdentityId: info.identityId,
          targetIdentityId,
          hasOffer: !!offer
        });
        this.dependencies.sendError(
          ws,
          'VALIDATION_ERROR',
          'Missing targetIdentityId or offer'
        );
        return;
      }

      const rawTargetIdentityId = String(targetIdentityId || '').trim();
      if (!looksLikeDerivedIdentityId(rawTargetIdentityId)) {
        this.logger.warn('call_offer_invalid_target_identity', {
          familyId,
          fromIdentityId: info.identityId,
          targetIdentityId: rawTargetIdentityId
        });
        this.dependencies.sendError(ws, 'VALIDATION_ERROR', 'Invalid targetIdentityId format');
        return;
      }
      const resolvedTargetIdentityId = rawTargetIdentityId as IdentityId;

      const targetIdentity = await identityRepository.findByIdentityId(
        familyId,
        resolvedTargetIdentityId
      );
      if (!targetIdentity) {
        this.logger.warn('call_offer_target_not_found', {
          familyId,
          fromIdentityId: info.identityId,
          targetIdentityId: resolvedTargetIdentityId
        });
        this.sendAccessDenied(ws, String(clientCallSessionId || ''), 'identity_not_active');
        return;
      }

      if (
        info.actorType === 'local'
        && !await this.dependencies.validateTemporaryCallDelegation({
          info,
          peerIdentityId: resolvedTargetIdentityId,
          callKeyDelegation: offer.callKeyDelegation
        })
      ) {
        this.dependencies.sendError(
          ws,
          'FORBIDDEN',
          'Temporary device is not allowed to call this contact'
        );
        return;
      }

      if (!await this.assertCallAccess(ws, info, resolvedTargetIdentityId, String(clientCallSessionId || ''))) return;

      const callSessionId = (clientCallSessionId || this.createCallSessionId()) as CallSessionId;
      const supersedesCallSessionId = String(rawSupersedesCallSessionId || '').trim();
      let callCapabilityGrant: {
        descriptor: LinkCapabilityDescriptor;
        proof: LinkCapabilityProof;
      } | undefined;
      const callCapabilityProof = offer.callCapabilityProof as LinkCapabilityProof | undefined;
      if (info.actorType === 'external' && info.callGrant?.kind === 'call_link') {
        callCapabilityGrant = info.callGrant.capabilityGrant;
        const expiresAt = Date.parse(callCapabilityGrant?.descriptor.payload.expiresAt || '');
        if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
          this.dependencies.sendError(ws, 'FORBIDDEN', 'Call link has expired');
          return;
        }
        const proofIsFresh = Boolean(
          callCapabilityGrant
          && callCapabilityProof
          && Number.isFinite(callCapabilityProof.timestamp)
          && Math.abs(this.now() - callCapabilityProof.timestamp) <= 120_000
        );
        const proofIsBoundToCall = proofIsFresh
          && callCapabilityGrant
          && callCapabilityProof?.payload?.context?.callSessionId === callSessionId
          && String(callCapabilityProof?.payload?.context?.supersedesCallSessionId || '') === supersedesCallSessionId
          && verifyCapabilityProof({
            proof: callCapabilityProof,
            descriptor: callCapabilityGrant.descriptor,
            expectedAction: 'call-link:call',
            expectedSubjectIdentityId: info.identityId,
            expectedSubjectPublicKey: info.externalPublicKey
          });
        if (!proofIsBoundToCall) {
          this.dependencies.sendError(ws, 'FORBIDDEN', 'Call capability proof is invalid');
          return;
        }
      }
      if (supersedesCallSessionId) {
        const superseded = await this.dependencies.supersedeDisconnectedCall({
          ws,
          info,
          previousCallSessionId: supersedesCallSessionId,
          nextCallSessionId: callSessionId,
          targetIdentityId: resolvedTargetIdentityId
        });
        this.dependencies.logCallDiag('call_redial_supersede_result', {
          callSessionId,
          supersedesCallSessionId,
          familyId,
          initiatorIdentityId: info.identityId,
          targetIdentityId: resolvedTargetIdentityId,
          superseded
        });
      }
      if (this.dependencies.consumeEarlyEndedCallSession({
        familyId,
        callSessionId,
        initiatorIdentityId: info.identityId
      })) {
        this.dependencies.logCallDiag('offer_rejected_after_early_end', {
          callSessionId,
          familyId,
          initiatorIdentityId: info.identityId,
          targetIdentityId: resolvedTargetIdentityId,
          socket: this.dependencies.describeSocket(ws)
        });
        this.dependencies.sendMessage(ws, {
          type: 'call:ended',
          data: { callSessionId, reason: 'cancelled' },
          timestamp: this.now()
        });
        return;
      }

      await callSessionRepository.create({
        familyId,
        callSessionId,
        participants: [info.identityId, resolvedTargetIdentityId],
        initiator: info.identityId,
        state: 'new'
      });
      const isTemporaryLinkCall = info.actorType === 'external'
        && info.callGrant?.kind === 'call_link';
      const callLinkTitle = isTemporaryLinkCall
        ? info.callGrant?.callLinkTitle || undefined
        : undefined;
      try {
        await callHistoryRepository.ensureCreated({
          familyId,
          callSessionId,
          initiatorIdentityId: info.identityId,
          targetIdentityId: resolvedTargetIdentityId,
          isTemporaryLinkCall,
          externalInitiatorPublicKey: info.actorType === 'external'
            ? info.externalPublicKey
            : undefined,
          callLinkTitle,
          createdAt: this.now()
        });
      } catch (error) {
        this.logger.warn('call_history_create_failed_non_fatal', {
          familyId,
          callSessionId,
          initiatorIdentityId: info.identityId,
          targetIdentityId: resolvedTargetIdentityId,
          isTemporaryLinkCall,
          error
        });
      }

      const offerForStorage = info.actorType === 'external'
        ? {
            ...offer,
            __externalCaller: {
              publicKey: info.externalPublicKey,
              displayName: info.externalDisplayName || null,
              admissionKind: info.callGrant?.kind === 'call_link'
                ? 'call_link'
                : 'whitelist_key',
              callLinkTitle: callLinkTitle || null,
              capabilityGrant: callCapabilityGrant
                ? {
                    descriptor: callCapabilityGrant.descriptor,
                    proof: callCapabilityProof!
                  }
                : undefined
            }
          }
        : offer;
      await callSessionRepository.updateSdpOffer(
        familyId,
        callSessionId,
        JSON.stringify(offerForStorage)
      );

      this.dependencies.callSessionRouting.registerInitiator({
        callSessionId,
        familyId,
        initiatorIdentityId: info.identityId,
        initiatorWs: ws,
        initiatorDeviceId: info.actorType === 'local' ? info.deviceId : undefined,
        targetIdentityId: resolvedTargetIdentityId
      });
      ensureCallIceStats(callSessionId);
      this.dependencies.callRingingService.scheduleExpiry({
        callSessionId,
        familyId,
        initiatorIdentityId: info.identityId,
        targetIdentityId: resolvedTargetIdentityId,
        isTemporaryLinkCall,
        callLinkTitle
      });

      const targetSockets = await this.resolveEligibleTargetSockets(
        familyId,
        resolvedTargetIdentityId,
        info.identityId
      );
      this.logger.debug('call_offer_target_sockets_resolved', {
        familyId,
        targetIdentityId: resolvedTargetIdentityId,
        socketCount: targetSockets?.size || 0
      });
      if (targetSockets && targetSockets.size > 0) {
        await this.deliverIncomingCall({
          targetSockets,
          callSessionId,
          targetIdentityId: resolvedTargetIdentityId,
          info,
          offer,
          isTemporaryLinkCall
        });
      }

      await this.deliverIncomingCallPush({
        targetSockets,
        callSessionId,
        targetIdentityId: resolvedTargetIdentityId,
        info,
        isTemporaryLinkCall
      });
    } catch (error) {
      this.logger.error('call_offer_failed', { error });
      this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Failed to initiate call');
    }
  }

  private sendAccessDenied(ws: WebSocket, callSessionId: string, reason: string): void {
    this.dependencies.sendMessage(ws, {
      type: 'error',
      data: { code: 'CALL_ACCESS_DENIED', message: 'Direct call is not allowed', reason, callSessionId },
      timestamp: this.now(),
    });
  }

  private async assertCallAccess(
    ws: WebSocket,
    info: ConnectionInfo,
    targetIdentityId: IdentityId,
    callSessionId: string
  ): Promise<boolean> {
    if (info.actorType === 'external') {
      if (!info.callGrant) {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'External caller is not admitted');
        return false;
      }
      if (info.callGrant.targetIdentityId !== targetIdentityId) {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'External caller target mismatch');
        return false;
      }
      return true;
    }

    const access = await resolveDirectCommunicationAccess(
      info.familyId,
      info.identityId,
      targetIdentityId,
      'calls'
    );
    if (!access.allowed) {
      this.logger.warn('call_offer_access_forbidden', {
        familyId: info.familyId,
        fromIdentityId: info.identityId,
        targetIdentityId,
        reason: access.reason
      });
      this.sendAccessDenied(ws, callSessionId, access.reason);
      return false;
    }
    if (access.relation === 'direct_guest') {
      await directGuestRegistrationRepository.touchLastSeen(
        info.familyId,
        access.guestIdentityId
      );
    }
    return true;
  }

  private async resolveEligibleTargetSockets(
    familyId: string,
    targetIdentityId: IdentityId,
    callerIdentityId: IdentityId
  ): Promise<Set<WebSocket> | undefined> {
    const rawSockets = this.dependencies.getWebIncomingCallSockets(familyId, targetIdentityId);
    if (!rawSockets) return undefined;
    const eligible = await Promise.all(Array.from(rawSockets).map(async (targetWs) => {
      const targetInfo = this.dependencies.getConnectionInfo(targetWs);
      if (targetInfo?.actorType !== 'local') return targetWs;
      return await this.dependencies.isTemporaryCallTargetAllowed(targetInfo, callerIdentityId)
        ? targetWs
        : null;
    }));
    return new Set(eligible.filter((targetWs): targetWs is WebSocket => targetWs !== null));
  }

  private async deliverIncomingCall(params: {
    targetSockets: Set<WebSocket>;
    callSessionId: CallSessionId;
    targetIdentityId: IdentityId;
    info: ConnectionInfo;
    offer: any;
    isTemporaryLinkCall: boolean;
  }): Promise<void> {
    const { info } = params;
    await callSessionRepository.updateState(info.familyId, params.callSessionId, 'ringing');
    const fromIdentity = info.actorType === 'local'
      ? await identityRepository.findByIdentityId(info.familyId, info.identityId)
      : null;
    const fromIdentityPublicKey = info.actorType === 'external'
      ? info.externalPublicKey
      : (fromIdentity
          ? {
              algorithm: fromIdentity.public_key_algorithm,
              value: fromIdentity.public_key_value
            }
          : undefined);
    const fromIdentityName = info.actorType === 'external'
      ? info.externalDisplayName
      : await this.dependencies.resolvePublishedIdentityName(info.familyId, fromIdentity);
    const callLinkTitle = info.actorType === 'external' && info.callGrant?.kind === 'call_link'
      ? info.callGrant.callLinkTitle || undefined
      : undefined;

    this.dependencies.sendToConnectionSet(params.targetSockets, {
      type: 'call:incoming',
      data: {
        callSessionId: params.callSessionId,
        fromIdentityId: info.identityId,
        fromIdentityPublicKey,
        fromIdentityName,
        isTemporaryLinkCall: params.isTemporaryLinkCall,
        callLinkTitle,
        capabilityGrant: info.actorType === 'external' && info.callGrant?.kind === 'call_link'
          ? {
              descriptor: info.callGrant.capabilityGrant!.descriptor,
              proof: params.offer.callCapabilityProof
            }
          : undefined,
        offer: params.offer
      },
      timestamp: this.now()
    });
    this.logger.info('call_incoming_delivered_via_ws', {
      familyId: info.familyId,
      callSessionId: params.callSessionId,
      fromIdentityId: info.identityId,
      targetIdentityId: params.targetIdentityId,
      socketCount: params.targetSockets.size
    });
  }

  private async deliverIncomingCallPush(params: {
    targetSockets: Set<WebSocket> | undefined;
    callSessionId: CallSessionId;
    targetIdentityId: IdentityId;
    info: ConnectionInfo;
    isTemporaryLinkCall: boolean;
  }): Promise<void> {
    const { info, targetSockets } = params;
    try {
      this.logger.info('call_incoming_push_started', {
        familyId: info.familyId,
        callSessionId: params.callSessionId,
        fromIdentityId: info.identityId,
        targetIdentityId: params.targetIdentityId,
        targetHasActiveSockets: !!targetSockets && targetSockets.size > 0,
        socketCount: targetSockets?.size || 0
      });

      const pushResult = await this.dependencies.callRingingService.deliverInitialPush({
        familyId: info.familyId,
        callSessionId: params.callSessionId,
        targetIdentityId: params.targetIdentityId,
        initiatorIdentityId: info.identityId,
        isTemporaryLinkCall: params.isTemporaryLinkCall,
        callLinkTitle: info.actorType === 'external' && info.callGrant?.kind === 'call_link'
          ? info.callGrant.callLinkTitle || undefined
          : undefined,
        targetHasActiveSockets: !!targetSockets && targetSockets.size > 0,
        resolveFromIdentityName: async () => {
          if (info.actorType === 'external') return info.externalDisplayName;
          const fromIdentity = await identityRepository.findByIdentityId(
            info.familyId,
            info.identityId
          );
          return this.dependencies.resolvePublishedIdentityName(info.familyId, fromIdentity);
        }
      });
      if (pushResult.status === 'stale') {
        this.logger.info('call_incoming_push_stale', {
          familyId: info.familyId,
          callSessionId: params.callSessionId,
          state: pushResult.callState
        });
        return;
      }

      const pushSummary = pushResult.summary;
      if (pushResult.couldNotReachReason) {
        this.dependencies.sendCallDeliveryStatus({
          familyId: info.familyId,
          callerIdentityId: info.identityId,
          callSessionId: params.callSessionId,
          status: 'could_not_reach_device',
          reason: pushResult.couldNotReachReason,
          occurredAt: this.now()
        });
      }
      this.logger.info('call_incoming_push_completed', {
        familyId: info.familyId,
        callSessionId: params.callSessionId,
        fromIdentityId: info.identityId,
        targetIdentityId: params.targetIdentityId,
        devicesTotal: pushSummary.devicesTotal,
        subscriptionsTotal: pushSummary.totals.subscriptionsTotal,
        sent: pushSummary.totals.sent,
        invalidated: pushSummary.totals.invalidated,
        skipped: pushSummary.totals.skipped,
        failed: pushSummary.totals.failed
      });
      const failures = pushSummary.deviceResults.flatMap((item) => item.failures);
      if (failures.length > 0) {
        this.logger.warn('call_incoming_push_partial_failure', {
          familyId: info.familyId,
          callSessionId: params.callSessionId,
          failureCount: failures.length,
          failures: failures.slice(0, 3).map((failure) => ({
            delivery: failure.delivery,
            statusCode: failure.statusCode,
            serviceError: failure.serviceError,
            message: failure.message
          }))
        });
      }
      if (pushResult.trailingStatusSent) {
        this.logger.info('call_incoming_push_trailing_status_sent', {
          familyId: info.familyId,
          callSessionId: params.callSessionId
        });
      }
    } catch (error) {
      this.logger.error('call_incoming_push_failed', {
        familyId: info.familyId,
        callSessionId: params.callSessionId,
        error
      });
    }
  }

}
function looksLikeDerivedIdentityId(value: string): boolean {
  return /^[A-Z2-7]{26}$/.test((value || '').trim());
}
