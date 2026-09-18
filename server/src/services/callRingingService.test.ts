import type { PushIdentityDeliveryResult } from '../utils/push';
import {
  CallRingingService,
  type CallRingingDependencies,
  type RingingCallSession
} from './callRingingService';

const baseParams = {
  familyId: 'family-1',
  callSessionId: 'call-1',
  initiatorIdentityId: 'caller',
  targetIdentityId: 'recipient',
  fromIdentityName: 'Alice',
  isTemporaryLinkCall: false
};

function pushSummary(overrides?: {
  devicesTotal?: number;
  sent?: number;
}): PushIdentityDeliveryResult {
  return {
    identityId: 'recipient',
    devicesTotal: overrides?.devicesTotal ?? 1,
    totals: {
      subscriptionsTotal: 1,
      attempted: 1,
      sent: overrides?.sent ?? 1,
      invalidated: 0,
      skipped: 0,
      failed: 0
    },
    deviceResults: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(options?: {
  session?: RingingCallSession | null;
  summary?: PushIdentityDeliveryResult;
  targetOnline?: boolean;
}) {
  let session = options?.session === undefined
    ? { state: 'ringing', created_at: new Date(1_000) }
    : options.session;
  let targetOnline = options?.targetOnline ?? false;

  const findCallSession = jest.fn(async () => session);
  const sendIncomingPush = jest.fn(async () => options?.summary || pushSummary());
  const sendCallStatusPush = jest.fn(async () => undefined);
  const expireCall = jest.fn(async () => undefined);
  const issueBootstrapToken = jest.fn(() => 'bootstrap-token');
  const logger = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn()
  };
  const dependencies: CallRingingDependencies = {
    findCallSession,
    isTargetOnline: () => targetOnline,
    issueBootstrapToken,
    sendIncomingPush,
    sendCallStatusPush,
    expireCall,
    now: () => 10_000,
    logger: logger as any
  };
  const service = new CallRingingService(dependencies, {
    ringTimeoutMs: 65_000,
    pushRepeatIntervalMs: 5_000,
    pushRepeatMaxAttempts: 3
  });

  return {
    service,
    findCallSession,
    sendIncomingPush,
    sendCallStatusPush,
    expireCall,
    issueBootstrapToken,
    logger,
    setSession(value: RingingCallSession | null) {
      session = value;
    },
    setTargetOnline(value: boolean) {
      targetOnline = value;
    }
  };
}

describe('CallRingingService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not send an incoming push for a call that already ended', async () => {
    const harness = createHarness({ session: { state: 'ended' } });
    const resolveFromIdentityName = jest.fn(async () => 'Alice');

    const result = await harness.service.deliverInitialPush({
      ...baseParams,
      targetHasActiveSockets: false,
      resolveFromIdentityName
    });

    expect(result).toEqual({ status: 'stale', callState: 'ended' });
    expect(resolveFromIdentityName).not.toHaveBeenCalled();
    expect(harness.sendIncomingPush).not.toHaveBeenCalled();
  });

  it('reports an unreachable offline device and repeats while the call is ringing', async () => {
    const harness = createHarness({
      summary: pushSummary({ devicesTotal: 0, sent: 0 })
    });

    const result = await harness.service.deliverInitialPush({
      ...baseParams,
      targetHasActiveSockets: false
    });

    expect(result).toMatchObject({
      status: 'sent',
      couldNotReachReason: 'no_target_devices'
    });
    expect(harness.sendIncomingPush).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(harness.sendIncomingPush).toHaveBeenCalledTimes(2);

    harness.setTargetOnline(true);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(harness.sendIncomingPush).toHaveBeenCalledTimes(2);
  });

  it('sends a trailing status when the call ends during initial push delivery', async () => {
    const harness = createHarness();
    harness.sendIncomingPush.mockImplementationOnce(async () => {
      harness.setSession({ state: 'ended' });
      return pushSummary();
    });

    const result = await harness.service.deliverInitialPush({
      ...baseParams,
      targetHasActiveSockets: true
    });

    expect(result).toMatchObject({ status: 'sent', trailingStatusSent: true });
    expect(harness.sendCallStatusPush).toHaveBeenCalledWith({
      familyId: 'family-1',
      targetIdentityId: 'recipient',
      callSessionId: 'call-1',
      callStatus: 'ended',
      callEndReason: 'cancelled',
      fromIdentityId: 'caller',
      fromIdentityName: 'Alice',
      callLinkTitle: undefined,
      isTemporaryLinkCall: false
    });
  });

  it('expires only a session that is still ringing', async () => {
    const harness = createHarness();
    harness.service.scheduleExpiry(baseParams);

    await jest.advanceTimersByTimeAsync(65_000);

    expect(harness.expireCall).toHaveBeenCalledWith({
      ...baseParams,
      callSession: expect.objectContaining({ state: 'ringing' })
    });
  });

  it('does not expire a call that was answered before the timeout callback', async () => {
    const harness = createHarness();
    harness.service.scheduleExpiry(baseParams);
    harness.setSession({ state: 'accepted' });

    await jest.advanceTimersByTimeAsync(65_000);

    expect(harness.expireCall).not.toHaveBeenCalled();
  });

  it('clears both expiry and repeat timers when the call stops', async () => {
    const harness = createHarness();
    await harness.service.deliverInitialPush({
      ...baseParams,
      targetHasActiveSockets: false
    });
    harness.service.scheduleExpiry(baseParams);

    harness.service.stop('call-1');
    await jest.advanceTimersByTimeAsync(70_000);

    expect(harness.sendIncomingPush).toHaveBeenCalledTimes(1);
    expect(harness.expireCall).not.toHaveBeenCalled();
  });

  it('clears timers for every call when the process shuts down', async () => {
    const harness = createHarness();
    harness.service.scheduleExpiry(baseParams);
    harness.service.scheduleExpiry({ ...baseParams, callSessionId: 'call-2' });

    harness.service.stopAll();
    await jest.advanceTimersByTimeAsync(70_000);

    expect(harness.expireCall).not.toHaveBeenCalled();
  });

  it('does not restore a repeat timer when an in-flight push finishes after stop', async () => {
    const harness = createHarness();
    await harness.service.deliverInitialPush({
      ...baseParams,
      targetHasActiveSockets: false
    });
    const pendingPush = deferred<PushIdentityDeliveryResult>();
    harness.sendIncomingPush.mockImplementationOnce(() => pendingPush.promise);

    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.sendIncomingPush).toHaveBeenCalledTimes(2);

    harness.service.stop('call-1');
    pendingPush.resolve(pushSummary());
    await pendingPush.promise;
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(harness.sendIncomingPush).toHaveBeenCalledTimes(2);
  });

  it('does not expire a call after stop while the state check is in flight', async () => {
    const harness = createHarness();
    const pendingSession = deferred<RingingCallSession | null>();
    harness.findCallSession.mockImplementationOnce(() => pendingSession.promise);
    harness.service.scheduleExpiry(baseParams);

    jest.advanceTimersByTime(65_000);
    await Promise.resolve();
    harness.service.stop('call-1');
    pendingSession.resolve({ state: 'ringing' });
    await pendingSession.promise;
    await Promise.resolve();

    expect(harness.expireCall).not.toHaveBeenCalled();
  });

  it('continues bounded repeats after a best-effort push failure', async () => {
    const harness = createHarness();
    await harness.service.deliverInitialPush({
      ...baseParams,
      targetHasActiveSockets: false
    });
    harness.sendIncomingPush.mockRejectedValueOnce(new Error('temporary push failure'));

    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(harness.sendIncomingPush).toHaveBeenCalledTimes(3);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'call_repeat_push_failed',
      expect.objectContaining({
        familyId: 'family-1',
        callSessionId: 'call-1',
        error: expect.any(Error)
      })
    );
  });
});
