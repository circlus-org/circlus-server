import { resolveCallTermination, type CallTerminationKind } from './callTerminationPolicy';

const base = {
  requestedReason: '',
  actorIdentityId: 'caller',
  actorDeviceId: 'caller-device',
  actorIsLocal: true,
  session: {
    state: 'ringing',
    initiatorIdentityId: 'caller',
    participantIdentityIds: ['caller', 'recipient']
  },
  activeRouteSocket: 'current' as const
};

describe('resolveCallTermination', () => {
  it.each([
    ['cancel', 'caller', 'ringing', true],
    ['decline', 'recipient', 'ringing', true],
    ['hangup', 'caller', 'active', true],
    ['cancel', 'recipient', 'ringing', false],
    ['decline', 'caller', 'ringing', false],
    ['hangup', 'caller', 'ringing', false]
  ] satisfies Array<[CallTerminationKind, string, string, boolean]>) (
    'validates %s from %s while the call is %s',
    (kind, actorIdentityId, state, accepted) => {
      expect(resolveCallTermination({
        ...base,
        kind,
        actorIdentityId,
        session: { ...base.session, state }
      }).accepted).toBe(accepted);
    }
  );

  it('plans a ringing caller cancellation as a missed peer notification', () => {
    expect(resolveCallTermination({
      ...base,
      kind: 'cancel'
    })).toEqual({
      accepted: true,
      context: {
        kind: 'cancel',
        endedByInitiator: true,
        ringingCallState: true,
        connectedCallState: false,
        endReason: 'cancelled',
        pushEndReason: 'cancelled',
        cancelledRecipientIdentityId: 'recipient',
        otherParticipantIdentityId: 'recipient',
        peerPushStatus: 'missed',
        peerPushEndReason: 'cancelled'
      }
    });
  });

  it('preserves an explicit decline reason and ends the caller notification', () => {
    const decision = resolveCallTermination({
      ...base,
      kind: 'decline',
      actorIdentityId: 'recipient',
      requestedReason: 'tab_rejected'
    });

    expect(decision).toMatchObject({
      accepted: true,
      context: {
        endReason: 'tab_rejected',
        pushEndReason: 'normal',
        otherParticipantIdentityId: 'caller',
        peerPushStatus: 'ended',
        peerPushEndReason: 'normal'
      }
    });
  });

  it('rejects a hangup sent by a socket other than the active route', () => {
    expect(resolveCallTermination({
      ...base,
      kind: 'hangup',
      session: { ...base.session, state: 'active' },
      activeRouteSocket: 'other'
    })).toEqual({ accepted: false, reason: 'socket_mismatch' });
  });

  it.each([
    ['cancel', 'caller', 'cancel_requires_initiator_ringing'],
    ['decline', 'recipient', 'decline_requires_target_ringing'],
    ['hangup', 'caller', 'hangup_requires_connected_call']
  ] satisfies Array<[CallTerminationKind, string, string]>) (
    'rejects a late or duplicate %s after the session is terminal',
    (kind, actorIdentityId, reason) => {
      expect(resolveCallTermination({
        ...base,
        kind,
        actorIdentityId,
        session: { ...base.session, state: 'ended' }
      })).toEqual({ accepted: false, reason });
    }
  );

  it('rejects a local hangup from a device other than the accepted route', () => {
    expect(resolveCallTermination({
      ...base,
      kind: 'hangup',
      session: { ...base.session, state: 'accepted' },
      activeRouteSocket: 'none',
      activeRouteDeviceId: 'other-device'
    })).toEqual({ accepted: false, reason: 'device_mismatch' });
  });

  it('allows an external hangup when no local device route is available', () => {
    expect(resolveCallTermination({
      ...base,
      kind: 'hangup',
      actorIsLocal: false,
      session: { ...base.session, state: 'active' },
      activeRouteSocket: 'none',
      activeRouteDeviceId: 'other-device'
    }).accepted).toBe(true);
  });
});
