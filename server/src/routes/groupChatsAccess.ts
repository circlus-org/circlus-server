import type { NextFunction, Response } from 'express';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import type { GroupLeaveRequestClaim } from '../../../shared/types';
import type { AuthRequest } from '../middleware/auth';
import { groupChatRepository, temporaryDeviceRepository } from '../db/repositories';
import { findCurrentGroupMembershipTransitionId } from './groupChatTrustProtocol';

export async function hasPendingGroupLeaveRequest(
  familyId: string,
  chatId: string,
  identityId: string
): Promise<boolean> {
  const message = await groupChatRepository.findLatestSystemMessageBySenderAndType(
    familyId,
    chatId,
    identityId,
    'participant_leave_requested'
  );
  if (!message?.system_payload_json) return false;
  let leaveRequest: GroupLeaveRequestClaim | null = null;
  try {
    leaveRequest = (JSON.parse(message.system_payload_json) as { leaveRequest?: GroupLeaveRequestClaim }).leaveRequest || null;
  } catch {
    return false;
  }
  if (
    leaveRequest?.type !== 'grp:leave-request'
    || leaveRequest.signerId !== identityId
    || leaveRequest.payload.participantIdentityId !== identityId
  ) return false;
  const transitions = await groupChatRepository.listStateTransitions(familyId, chatId);
  return findCurrentGroupMembershipTransitionId(
    transitions.map((row) => row.signed_transition),
    identityId
  ) === leaveRequest.payload.membershipTransitionId;
}

export async function requireGroupChatOwner(
  req: AuthRequest,
  chatId: string
): Promise<{ ok: true } | { ok: false; status: number; body: ApiResponse }> {
  const familyId = req.familyId;
  const identityId = req.device?.identityId;
  if (!familyId || !identityId) {
    return {
      ok: false,
      status: 500,
      body: {
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      }
    };
  }

  const chat = await groupChatRepository.findChat(familyId, chatId);
  if (!chat) {
    return {
      ok: false,
      status: 404,
      body: {
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Group chat not found' }
      }
    };
  }

  if (chat.owner_identity_id !== identityId) {
    return {
      ok: false,
      status: 403,
      body: {
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only owner can perform this action' }
      }
    };
  }

  return { ok: true };
}

export function requireTrustedGroupDevice(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.device?.accessLevel === 'temporary') {
    res.status(403).json({
      status: 'error',
      error: {
        code: 'FORBIDDEN' as ErrorCode,
        message: 'Temporary devices cannot manage group chats'
      }
    } as ApiResponse);
    return;
  }
  next();
}

export async function requireGrantedTemporaryGroupChat(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.device?.accessLevel !== 'temporary') {
    next();
    return;
  }

  const familyId = req.familyId;
  const deviceId = req.device.deviceId;
  const chatId = String(req.params.chatId || '').trim();
  const hasAccess = familyId
    && chatId
    && await temporaryDeviceRepository.hasChatAccess(familyId, deviceId, chatId, 'group');
  if (!hasAccess) {
    res.status(403).json({
      status: 'error',
      error: {
        code: 'FORBIDDEN' as ErrorCode,
        message: 'Temporary device has no access to this chat'
      }
    } as ApiResponse);
    return;
  }
  next();
}
