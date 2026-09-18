import type { PushIdentityDeliveryResult } from '../utils/push';
import type { CallSessionId, IdentityId } from '@shared/types';
import { getRequestLogger } from '../middleware/requestContext';
import type { Logger } from '../utils/logger';

export type RingingCallSession = {
  state: string;
  created_at?: Date | null;
};

export type CallRingingParams = {
  familyId: string;
  callSessionId: CallSessionId;
  initiatorIdentityId: IdentityId;
  targetIdentityId: IdentityId;
  fromIdentityName?: string;
  isTemporaryLinkCall?: boolean;
  callLinkTitle?: string;
};

type CallStatusPushParams = {
  familyId: string;
  targetIdentityId: IdentityId;
  callSessionId: CallSessionId;
  callStatus: 'missed' | 'ended';
  callEndReason: 'timeout' | 'cancelled';
  fromIdentityId: IdentityId;
  fromIdentityName?: string;
  isTemporaryLinkCall?: boolean;
  callLinkTitle?: string;
};

export type CallRingingDependencies = {
  findCallSession: (
    familyId: string,
    callSessionId: CallSessionId
  ) => Promise<RingingCallSession | null>;
  isTargetOnline: (familyId: string, targetIdentityId: IdentityId) => boolean;
  issueBootstrapToken: (params: {
    familyId: string;
    callSessionId: CallSessionId;
    targetIdentityId: IdentityId;
    expiresAt: number;
  }) => string;
  sendIncomingPush: (
    params: CallRingingParams & { bootstrapToken: string }
  ) => Promise<PushIdentityDeliveryResult>;
  sendCallStatusPush: (params: CallStatusPushParams) => Promise<unknown>;
  expireCall: (
    params: CallRingingParams & { callSession: RingingCallSession }
  ) => Promise<void>;
  now?: () => number;
  logger?: Logger;
};

export type InitialCallPushResult =
  | { status: 'stale'; callState: string }
  | {
      status: 'sent';
      summary: PushIdentityDeliveryResult;
      couldNotReachReason?: 'no_target_devices' | 'push_not_sent';
      trailingStatusSent: boolean;
    };

type CallRingingServiceConfig = {
  ringTimeoutMs: number;
  pushRepeatIntervalMs: number;
  pushRepeatMaxAttempts: number;
};

function isRingingState(state: string | null | undefined): boolean {
  return state === 'new' || state === 'ringing';
}

export class CallRingingService {
  private readonly expiryTimers = new Map<CallSessionId, NodeJS.Timeout>();
  private readonly expiryRuns = new Map<CallSessionId, symbol>();
  private readonly pushRepeatTimers = new Map<CallSessionId, NodeJS.Timeout>();
  private readonly pushAttempts = new Map<CallSessionId, number>();
  private readonly pushRuns = new Map<CallSessionId, symbol>();
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(
    private readonly dependencies: CallRingingDependencies,
    private readonly config: CallRingingServiceConfig
  ) {
    this.now = dependencies.now || Date.now;
    this.logger = dependencies.logger || getRequestLogger({ subsystem: 'call_ringing' });
  }

  scheduleExpiry(params: CallRingingParams): void {
    this.stopExpiry(params.callSessionId);
    const runId = Symbol(params.callSessionId);
    this.expiryRuns.set(params.callSessionId, runId);
    const timeout = setTimeout(() => {
      void this.expireIfStillRinging(params, runId);
    }, Math.max(1_000, this.config.ringTimeoutMs));
    this.expiryTimers.set(params.callSessionId, timeout);
  }

  async deliverInitialPush(
    params: CallRingingParams & {
      targetHasActiveSockets: boolean;
      resolveFromIdentityName?: () => Promise<string | undefined>;
    }
  ): Promise<InitialCallPushResult> {
    const currentCallSession = await this.dependencies.findCallSession(
      params.familyId,
      params.callSessionId
    );
    if (!currentCallSession || !isRingingState(currentCallSession.state)) {
      return {
        status: 'stale',
        callState: currentCallSession?.state || 'missing'
      };
    }

    const ringingParams: CallRingingParams = {
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      initiatorIdentityId: params.initiatorIdentityId,
      targetIdentityId: params.targetIdentityId,
      fromIdentityName: params.resolveFromIdentityName
        ? await params.resolveFromIdentityName()
        : params.fromIdentityName,
      isTemporaryLinkCall: params.isTemporaryLinkCall,
      callLinkTitle: params.callLinkTitle
    };
    const bootstrapToken = this.dependencies.issueBootstrapToken({
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      targetIdentityId: params.targetIdentityId,
      expiresAt: this.now() + 90_000
    });
    const summary = await this.dependencies.sendIncomingPush({
      ...ringingParams,
      bootstrapToken
    });

    let couldNotReachReason: 'no_target_devices' | 'push_not_sent' | undefined;
    if (!params.targetHasActiveSockets) {
      this.startPushRepeats(ringingParams);
      if (summary.totals.sent <= 0) {
        couldNotReachReason = summary.devicesTotal <= 0 ? 'no_target_devices' : 'push_not_sent';
      }
    }

    const afterPushCallSession = await this.dependencies.findCallSession(
      params.familyId,
      params.callSessionId
    );
    let trailingStatusSent = false;
    if (afterPushCallSession && !isRingingState(afterPushCallSession.state)) {
      await this.dependencies.sendCallStatusPush({
        familyId: params.familyId,
        targetIdentityId: params.targetIdentityId,
        callSessionId: params.callSessionId,
        callStatus: afterPushCallSession.state === 'expired' ? 'missed' : 'ended',
        callEndReason: afterPushCallSession.state === 'expired' ? 'timeout' : 'cancelled',
        fromIdentityId: params.initiatorIdentityId,
        fromIdentityName: ringingParams.fromIdentityName,
        isTemporaryLinkCall: ringingParams.isTemporaryLinkCall,
        callLinkTitle: ringingParams.callLinkTitle
      });
      trailingStatusSent = true;
    }

    return {
      status: 'sent',
      summary,
      couldNotReachReason,
      trailingStatusSent
    };
  }

  stop(callSessionId: CallSessionId): void {
    this.stopExpiry(callSessionId);
    this.stopPushRepeats(callSessionId);
  }

  stopAll(): void {
    const callSessionIds = new Set([
      ...this.expiryTimers.keys(),
      ...this.pushRepeatTimers.keys()
    ]);
    for (const callSessionId of callSessionIds) this.stop(callSessionId);
  }

  private startPushRepeats(params: CallRingingParams): void {
    if (
      !Number.isFinite(this.config.pushRepeatMaxAttempts)
      || this.config.pushRepeatMaxAttempts <= 1
      || this.pushRuns.has(params.callSessionId)
    ) {
      return;
    }

    const runId = Symbol(params.callSessionId);
    this.pushRuns.set(params.callSessionId, runId);
    this.pushAttempts.set(params.callSessionId, 1);
    this.scheduleNextPushRepeat(params, runId);
  }

  private scheduleNextPushRepeat(params: CallRingingParams, runId: symbol): void {
    const timeout = setTimeout(() => {
      void this.repeatPushIfStillRinging(params, runId);
    }, Math.max(1_000, this.config.pushRepeatIntervalMs));
    this.pushRepeatTimers.set(params.callSessionId, timeout);
  }

  private async repeatPushIfStillRinging(params: CallRingingParams, runId: symbol): Promise<void> {
    if (this.pushRuns.get(params.callSessionId) !== runId) return;
    this.pushRepeatTimers.delete(params.callSessionId);
    const attempts = this.pushAttempts.get(params.callSessionId) ?? 1;
    if (attempts >= this.config.pushRepeatMaxAttempts) {
      this.stopPushRepeats(params.callSessionId);
      return;
    }

    try {
      const callSession = await this.dependencies.findCallSession(
        params.familyId,
        params.callSessionId
      );
      if (this.pushRuns.get(params.callSessionId) !== runId) return;
      if (!callSession || !isRingingState(callSession.state)) {
        this.stopPushRepeats(params.callSessionId);
        return;
      }
      if (this.dependencies.isTargetOnline(params.familyId, params.targetIdentityId)) {
        this.stopPushRepeats(params.callSessionId);
        return;
      }

      this.logger.info('call_repeat_push_started', {
        familyId: params.familyId,
        callSessionId: params.callSessionId,
        targetIdentityId: params.targetIdentityId,
        attempt: attempts + 1,
        maxAttempts: this.config.pushRepeatMaxAttempts
      });
      const bootstrapToken = this.dependencies.issueBootstrapToken({
        familyId: params.familyId,
        callSessionId: params.callSessionId,
        targetIdentityId: params.targetIdentityId,
        expiresAt: this.now() + 90_000
      });
      try {
        const summary = await this.dependencies.sendIncomingPush({
          ...params,
          bootstrapToken
        });
        if (this.pushRuns.get(params.callSessionId) !== runId) return;
        this.logger.info('call_repeat_push_completed', {
          familyId: params.familyId,
          callSessionId: params.callSessionId,
          targetIdentityId: params.targetIdentityId,
          devicesTotal: summary.devicesTotal,
          subscriptionsTotal: summary.totals.subscriptionsTotal,
          sent: summary.totals.sent,
          invalidated: summary.totals.invalidated,
          skipped: summary.totals.skipped,
          failed: summary.totals.failed
        });
      } catch (error) {
        if (this.pushRuns.get(params.callSessionId) !== runId) return;
        this.logger.warn('call_repeat_push_failed', {
          familyId: params.familyId,
          callSessionId: params.callSessionId,
          targetIdentityId: params.targetIdentityId,
          error
        });
      }

      const nextAttempts = attempts + 1;
      this.pushAttempts.set(params.callSessionId, nextAttempts);
      if (nextAttempts >= this.config.pushRepeatMaxAttempts) {
        this.stopPushRepeats(params.callSessionId);
        return;
      }
      this.scheduleNextPushRepeat(params, runId);
    } catch (error) {
      if (this.pushRuns.get(params.callSessionId) !== runId) return;
      this.logger.warn('call_repeat_push_state_check_failed', {
        familyId: params.familyId,
        callSessionId: params.callSessionId,
        error
      });
      this.stopPushRepeats(params.callSessionId);
    }
  }

  private async expireIfStillRinging(params: CallRingingParams, runId: symbol): Promise<void> {
    try {
      const callSession = await this.dependencies.findCallSession(
        params.familyId,
        params.callSessionId
      );
      if (this.expiryRuns.get(params.callSessionId) !== runId) return;
      if (!callSession || !isRingingState(callSession.state)) return;
      await this.dependencies.expireCall({ ...params, callSession });
    } catch (error) {
      if (this.expiryRuns.get(params.callSessionId) !== runId) return;
      this.logger.warn('call_expiration_failed', {
        familyId: params.familyId,
        callSessionId: params.callSessionId,
        error
      });
    } finally {
      if (this.expiryRuns.get(params.callSessionId) === runId) {
        this.stop(params.callSessionId);
      }
    }
  }

  private stopExpiry(callSessionId: CallSessionId): void {
    const timeout = this.expiryTimers.get(callSessionId);
    if (timeout) clearTimeout(timeout);
    this.expiryTimers.delete(callSessionId);
    this.expiryRuns.delete(callSessionId);
  }

  private stopPushRepeats(callSessionId: CallSessionId): void {
    const timeout = this.pushRepeatTimers.get(callSessionId);
    if (timeout) clearTimeout(timeout);
    this.pushRepeatTimers.delete(callSessionId);
    this.pushAttempts.delete(callSessionId);
    this.pushRuns.delete(callSessionId);
  }
}
