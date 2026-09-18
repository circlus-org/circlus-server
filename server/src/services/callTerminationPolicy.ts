export type CallTerminationKind = 'cancel' | 'decline' | 'hangup';

export type CallTerminationSession = {
  state: string;
  initiatorIdentityId: string;
  participantIdentityIds: string[];
};

export type CallTerminationContext = {
  kind: CallTerminationKind;
  endedByInitiator: boolean;
  ringingCallState: boolean;
  connectedCallState: boolean;
  endReason: string;
  pushEndReason: 'cancelled' | 'normal';
  cancelledRecipientIdentityId?: string;
  otherParticipantIdentityId?: string;
  peerPushStatus: 'missed' | 'ended';
  peerPushEndReason: 'cancelled' | 'normal';
};

export type CallTerminationDecision =
  | { accepted: false; reason: string }
  | { accepted: true; context: CallTerminationContext };

export function resolveCallTermination(params: {
  kind: CallTerminationKind;
  requestedReason?: string;
  actorIdentityId: string;
  actorDeviceId?: string;
  actorIsLocal: boolean;
  session: CallTerminationSession;
  activeRouteSocket: 'none' | 'current' | 'other';
  activeRouteDeviceId?: string;
}): CallTerminationDecision {
  const endedByInitiator = params.session.initiatorIdentityId === params.actorIdentityId;
  const ringingCallState = params.session.state === 'new' || params.session.state === 'ringing';
  const connectedCallState = params.session.state === 'accepted' || params.session.state === 'active';
  const invalidReason =
    params.kind === 'cancel' && (!endedByInitiator || !ringingCallState)
      ? 'cancel_requires_initiator_ringing'
      : params.kind === 'decline' && (endedByInitiator || !ringingCallState)
        ? 'decline_requires_target_ringing'
        : params.kind === 'hangup' && !connectedCallState
          ? 'hangup_requires_connected_call'
          : null;
  if (invalidReason) {
    return { accepted: false, reason: invalidReason };
  }

  if (params.kind === 'hangup' && params.activeRouteSocket === 'other') {
    return { accepted: false, reason: 'socket_mismatch' };
  }
  if (
    params.kind === 'hangup'
    && params.activeRouteSocket === 'none'
    && params.actorIsLocal
    && params.activeRouteDeviceId
    && params.activeRouteDeviceId !== params.actorDeviceId
  ) {
    return { accepted: false, reason: 'device_mismatch' };
  }

  const requestedReason = String(params.requestedReason || '').trim();
  const endReason = params.kind === 'cancel'
    ? requestedReason || 'cancelled'
    : params.kind === 'decline'
      ? requestedReason || 'declined'
      : requestedReason || 'normal';
  const pushEndReason = params.kind === 'cancel' ? 'cancelled' : 'normal';
  const cancelledRecipientIdentityId = params.kind === 'cancel' && ringingCallState && endedByInitiator
    ? params.session.participantIdentityIds.find((identityId) => identityId !== params.session.initiatorIdentityId)
    : undefined;
  const otherParticipantIdentityId = params.session.participantIdentityIds.find(
    (identityId) => identityId !== params.actorIdentityId
  );
  const peerMissedCall = params.kind === 'cancel' && ringingCallState;

  return {
    accepted: true,
    context: {
      kind: params.kind,
      endedByInitiator,
      ringingCallState,
      connectedCallState,
      endReason,
      pushEndReason,
      cancelledRecipientIdentityId,
      otherParticipantIdentityId,
      peerPushStatus: peerMissedCall ? 'missed' : 'ended',
      peerPushEndReason: peerMissedCall ? 'cancelled' : pushEndReason
    }
  };
}
