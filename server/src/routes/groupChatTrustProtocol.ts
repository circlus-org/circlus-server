import type {
  GroupMessageAuthorAction,
  GroupMessageAuthorClaim,
  GroupLeaveRequestClaim,
  GroupStateTransitionClaim,
  GroupStateTransitionPayload,
  PublicKey
} from '../../../shared/types';
import { verifySignedRequest } from '../utils/crypto';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const TRANSITION_ID = /^gst_[A-Za-z0-9_-]{12,}$/;
const LEAVE_REQUEST_ID = /^glr_[A-Za-z0-9_-]{12,}$/;

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasUniqueNonEmptyValues(values: string[]): boolean {
  return values.length > 0
    && values.every((value) => Boolean(value.trim()))
    && new Set(values).size === values.length;
}

export function findCurrentGroupMembershipTransitionId(
  transitions: GroupStateTransitionClaim[],
  participantIdentityId: string
): string | null {
  const ordered = [...transitions].sort((left, right) => left.payload.sequence - right.payload.sequence);
  let active = false;
  let membershipTransitionId: string | null = null;
  for (const transition of ordered) {
    const nextActive = transition.payload.participantIdentityIds.includes(participantIdentityId);
    if (!active && nextActive) membershipTransitionId = transition.payload.transitionId;
    if (active && !nextActive) membershipTransitionId = null;
    active = nextActive;
  }
  return active ? membershipTransitionId : null;
}

export function validateGroupLeaveRequest(params: {
  claim: GroupLeaveRequestClaim | null | undefined;
  chatId: string;
  participantPublicKey: PublicKey;
  transitions: GroupStateTransitionClaim[];
}): { ok: true } | { ok: false; message: string } {
  const claim = params.claim;
  const payload = claim?.payload;
  if (
    !claim
    || claim.type !== 'grp:leave-request'
    || payload?.version !== 1
    || payload.purpose !== 'group-leave-request-v1'
    || payload.chatId !== params.chatId
    || !LEAVE_REQUEST_ID.test(payload.requestId)
    || !TRANSITION_ID.test(payload.membershipTransitionId)
    || !TRANSITION_ID.test(payload.observedTransitionId)
    || !Number.isSafeInteger(payload.requestedAt)
    || payload.requestedAt <= 0
    || claim.signerId !== payload.participantIdentityId
  ) return { ok: false, message: 'Invalid group leave request' };
  const ordered = [...params.transitions].sort((left, right) => left.payload.sequence - right.payload.sequence);
  const observedIndex = ordered.findIndex((transition) => transition.payload.transitionId === payload.observedTransitionId);
  if (
    observedIndex < 0
    || findCurrentGroupMembershipTransitionId(
      ordered.slice(0, observedIndex + 1),
      payload.participantIdentityId
    ) !== payload.membershipTransitionId
    || !verifySignedRequest(claim, params.participantPublicKey)
  ) return { ok: false, message: 'Invalid group leave request' };
  return { ok: true };
}

export function validateGroupStateTransition(params: {
  claim: GroupStateTransitionClaim | null | undefined;
  chatId: string;
  signerPublicKey: PublicKey;
  previous: GroupStateTransitionClaim | null;
}): { ok: true } | { ok: false; message: string } {
  const { claim, previous } = params;
  if (!claim || claim.type !== 'grp:state-transition') {
    return { ok: false, message: 'Owner-signed state transition is required' };
  }
  const current = claim.payload;
  if (
    current.version !== 2
    || current.purpose !== 'group-state-transition-v2'
    || current.chatId !== params.chatId
    || !TRANSITION_ID.test(current.transitionId)
    || current.sequence < 1
    || current.epoch < 1
    || !SHA256_HEX.test(current.keyCommitment)
    || !hasUniqueNonEmptyValues(current.participantIdentityIds)
    || !current.participantIdentityIds.includes(current.ownerIdentityId)
  ) return { ok: false, message: 'Invalid group state transition payload' };

  const expectedSigner = previous?.payload.ownerIdentityId || current.ownerIdentityId;
  if (claim.signerId !== expectedSigner || !verifySignedRequest(claim, params.signerPublicKey)) {
    return { ok: false, message: 'Invalid group owner signature' };
  }

  if (!previous) {
    if (
      current.action !== 'create'
      || current.sequence !== 1
      || current.previousTransitionId !== null
      || current.epoch !== 1
    ) return { ok: false, message: 'Invalid group genesis transition' };
    return { ok: true };
  }

  if (
    current.sequence !== previous.payload.sequence + 1
    || current.previousTransitionId !== previous.payload.transitionId
  ) return { ok: false, message: 'Group state compare-and-swap conflict' };

  const oldState = previous.payload;
  const sameParticipants = arraysEqual(current.participantIdentityIds, oldState.participantIdentityIds);
  const oldSet = new Set(oldState.participantIdentityIds);
  const nextSet = new Set(current.participantIdentityIds);
  const added = current.participantIdentityIds.filter((id) => !oldSet.has(id));
  const removed = oldState.participantIdentityIds.filter((id) => !nextSet.has(id));
  let valid = false;
  switch (current.action) {
    case 'add_participants':
      valid = current.ownerIdentityId === oldState.ownerIdentityId
        && added.length > 0 && removed.length === 0
        && arraysEqual(current.participantIdentityIds.slice(0, oldState.participantIdentityIds.length), oldState.participantIdentityIds)
        && current.epoch === oldState.epoch + 1
        && current.keyCommitment !== oldState.keyCommitment;
      break;
    case 'remove_participants':
      valid = current.ownerIdentityId === oldState.ownerIdentityId
        && removed.length > 0 && added.length === 0
        && current.epoch === oldState.epoch + 1
        && current.keyCommitment !== oldState.keyCommitment;
      break;
    case 'transfer_owner':
      valid = sameParticipants
        && current.ownerIdentityId !== oldState.ownerIdentityId
        && current.epoch === oldState.epoch
        && current.keyCommitment === oldState.keyCommitment
        && current.titleCiphertext === oldState.titleCiphertext;
      break;
    case 'rekey':
      valid = sameParticipants
        && current.ownerIdentityId === oldState.ownerIdentityId
        && current.epoch === oldState.epoch + 1
        && current.keyCommitment !== oldState.keyCommitment;
      break;
    case 'rename':
      valid = sameParticipants
        && current.ownerIdentityId === oldState.ownerIdentityId
        && current.epoch === oldState.epoch
        && current.keyCommitment === oldState.keyCommitment
        && current.titleCiphertext !== oldState.titleCiphertext;
      break;
  }
  return valid ? { ok: true } : { ok: false, message: 'Invalid group state transition' };
}

export function validateGroupMessageAuthorClaim(params: {
  claim: GroupMessageAuthorClaim | null | undefined;
  action: GroupMessageAuthorAction;
  chatId: string;
  senderIdentityId: string;
  clientMessageId: string;
  clientCreatedAt: number;
  epoch: number;
  revision: number;
  ciphertext: string;
  senderPublicKey: PublicKey;
}): boolean {
  const claim = params.claim;
  if (!claim || claim.type !== 'grp:message-author' || claim.signerId !== params.senderIdentityId) return false;
  const payload = claim.payload;
  return payload.version === 1
    && payload.purpose === 'group-message-author-v1'
    && payload.action === params.action
    && payload.chatId === params.chatId
    && payload.senderIdentityId === params.senderIdentityId
    && payload.clientMessageId === params.clientMessageId
    && payload.clientCreatedAt === params.clientCreatedAt
    && payload.epoch === params.epoch
    && payload.revision === params.revision
    && payload.ciphertext === params.ciphertext
    && verifySignedRequest(claim, params.senderPublicKey);
}

export function getGroupTransitionParticipantDiff(
  previous: GroupStateTransitionPayload,
  current: GroupStateTransitionPayload
): { added: string[]; removed: string[] } {
  const previousSet = new Set(previous.participantIdentityIds);
  const currentSet = new Set(current.participantIdentityIds);
  return {
    added: current.participantIdentityIds.filter((id) => !previousSet.has(id)),
    removed: previous.participantIdentityIds.filter((id) => !currentSet.has(id))
  };
}
