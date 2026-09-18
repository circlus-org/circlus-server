import { nanoid } from 'nanoid';
import type { DeviceId, IdentityId } from '../../../shared/types';
import { transaction } from '../db';
import { groupChatRepository } from '../db/repositories';
import {
  buildSystemMessageRecord,
  fanoutGroupChatEvent
} from './groupChatEventService';

type MembershipActor = {
  familyId: string;
  chatId: string;
  actorIdentityId: IdentityId;
  actorDeviceId: DeviceId | null;
  actorSignature: string | null;
  now?: number;
  messageId?: string;
};

function mutationContext(params: MembershipActor) {
  return {
    now: params.now ?? Date.now(),
    messageId: params.messageId ?? `gcm_${nanoid(20)}`
  };
}

export async function addGroupChatParticipants(
  params: MembershipActor & { participantIds: IdentityId[] }
) {
  const { now, messageId } = mutationContext(params);
  const outcome = await transaction(async (client) => {
    const added = await groupChatRepository.addParticipants(
      params.familyId,
      params.chatId,
      params.actorIdentityId,
      params.participantIds,
      now,
      client
    );
    if (added.length === 0) return { added, keyEpoch: null };

    const keyEpoch = await groupChatRepository.bumpKeyEpoch(params.familyId, params.chatId, client);
    await groupChatRepository.insertMessage(buildSystemMessageRecord({
      messageId,
      familyId: params.familyId,
      chatId: params.chatId,
      senderIdentityId: params.actorIdentityId,
      senderDeviceId: params.actorDeviceId,
      senderSignature: params.actorSignature,
      createdAt: now,
      epoch: keyEpoch,
      systemType: 'participants_added',
      systemPayload: { participantIds: added, keyEpoch }
    }), client);
    return { added, keyEpoch };
  });

  const participants = await groupChatRepository.listActiveParticipants(params.familyId, params.chatId);
  fanoutGroupChatEvent({
    familyId: params.familyId,
    participantIdentityIds: participants.map((participant) => participant.identity_id),
    eventType: 'group:chat-updated',
    payload: {
      chatId: params.chatId,
      event: 'participants_added',
      participantIds: outcome.added,
      keyEpoch: outcome.keyEpoch ?? undefined
    }
  });
  return outcome;
}

export async function removeGroupChatParticipant(
  params: MembershipActor & { participantId: IdentityId }
) {
  const { now, messageId } = mutationContext(params);
  const keyEpoch = await transaction(async (client) => {
    await groupChatRepository.removeParticipant(
      params.familyId,
      params.chatId,
      params.participantId,
      now,
      client
    );
    const nextKeyEpoch = await groupChatRepository.bumpKeyEpoch(params.familyId, params.chatId, client);
    await groupChatRepository.insertMessage(buildSystemMessageRecord({
      messageId,
      familyId: params.familyId,
      chatId: params.chatId,
      senderIdentityId: params.actorIdentityId,
      senderDeviceId: params.actorDeviceId,
      senderSignature: params.actorSignature,
      createdAt: now,
      epoch: nextKeyEpoch,
      systemType: 'participant_removed',
      systemPayload: { participantId: params.participantId, keyEpoch: nextKeyEpoch }
    }), client);
    return nextKeyEpoch;
  });

  const participants = await groupChatRepository.listActiveParticipants(params.familyId, params.chatId);
  fanoutGroupChatEvent({
    familyId: params.familyId,
    participantIdentityIds: [
      ...participants.map((participant) => participant.identity_id),
      params.participantId
    ],
    eventType: 'group:chat-updated',
    payload: {
      chatId: params.chatId,
      event: 'participant_removed',
      participantId: params.participantId,
      keyEpoch
    }
  });
  return { keyEpoch };
}

export async function transferGroupChatOwnership(
  params: MembershipActor & { newOwnerIdentityId: IdentityId }
) {
  const { now, messageId } = mutationContext(params);
  await transaction(async (client) => {
    await groupChatRepository.setOwner(
      params.familyId,
      params.chatId,
      params.newOwnerIdentityId,
      now,
      client
    );
    const chat = await groupChatRepository.findChat(params.familyId, params.chatId, client);
    await groupChatRepository.insertMessage(buildSystemMessageRecord({
      messageId,
      familyId: params.familyId,
      chatId: params.chatId,
      senderIdentityId: params.actorIdentityId,
      senderDeviceId: params.actorDeviceId,
      senderSignature: params.actorSignature,
      createdAt: now,
      epoch: chat?.key_epoch || 1,
      systemType: 'owner_transferred',
      systemPayload: { from: params.actorIdentityId, to: params.newOwnerIdentityId }
    }), client);
  });

  const participants = await groupChatRepository.listActiveParticipants(params.familyId, params.chatId);
  fanoutGroupChatEvent({
    familyId: params.familyId,
    participantIdentityIds: participants.map((participant) => participant.identity_id),
    eventType: 'group:chat-updated',
    payload: {
      chatId: params.chatId,
      event: 'owner_transferred',
      from: params.actorIdentityId,
      to: params.newOwnerIdentityId
    }
  });
}

export async function leaveGroupChat(
  params: MembershipActor & { currentOwnerIdentityId: IdentityId }
) {
  const { now, messageId } = mutationContext(params);
  const outcome = await transaction(async (client) => {
    await groupChatRepository.removeParticipant(
      params.familyId,
      params.chatId,
      params.actorIdentityId,
      now,
      client
    );
    const keyEpoch = await groupChatRepository.bumpKeyEpoch(params.familyId, params.chatId, client);

    let ownerIdentityId = params.currentOwnerIdentityId;
    if (params.currentOwnerIdentityId === params.actorIdentityId) {
      const nextOwner = await groupChatRepository.findNextOwner(params.familyId, params.chatId, client);
      if (nextOwner) {
        await groupChatRepository.setOwner(params.familyId, params.chatId, nextOwner, now, client);
        ownerIdentityId = nextOwner;
      }
    }

    await groupChatRepository.insertMessage(buildSystemMessageRecord({
      messageId,
      familyId: params.familyId,
      chatId: params.chatId,
      senderIdentityId: params.actorIdentityId,
      senderDeviceId: params.actorDeviceId,
      senderSignature: params.actorSignature,
      createdAt: now,
      epoch: keyEpoch,
      systemType: 'participant_left',
      systemPayload: { identityId: params.actorIdentityId, ownerIdentityId, keyEpoch }
    }), client);
    return { keyEpoch, ownerIdentityId };
  });

  const participants = await groupChatRepository.listActiveParticipants(params.familyId, params.chatId);
  fanoutGroupChatEvent({
    familyId: params.familyId,
    participantIdentityIds: [
      ...participants.map((participant) => participant.identity_id),
      params.actorIdentityId
    ],
    eventType: 'group:chat-updated',
    payload: {
      chatId: params.chatId,
      event: 'participant_left',
      identityId: params.actorIdentityId,
      ownerIdentityId: outcome.ownerIdentityId,
      keyEpoch: outcome.keyEpoch
    }
  });
  return outcome;
}
