import { pool } from '../index';
import type { CallSessionId, IdentityId } from '@shared/types';

import type {
  FindByCallSessionIdResult,
  CreateCallSessionParams,
} from './callSessionRepository.queries';

import {
  findByCallSessionId,
  createCallSession,
  updateCallState,
  updateSdpOffer,
  updateSdpAnswer,
  addIceCandidate,
  endCallSession,
  findActiveCallSessions,
  cleanupExpiredSessions,
  countActiveCalls,
} from './callSessionRepository.queries';

export class CallSessionRepository {
  /**
   * Find call session by call_session_id
   */
  async findByCallSessionId(familyId: string, callSessionId: CallSessionId): Promise<FindByCallSessionIdResult | null> {
    const results = await findByCallSessionId.run({ familyId, callSessionId }, pool);
    return results[0] || null;
  }

  /**
   * Create new call session
   */
  async create(data: {
    familyId: string;
    callSessionId: CallSessionId;
    participants: IdentityId[];
    initiator: IdentityId;
    state?: string;
  }): Promise<FindByCallSessionIdResult> {
    const params: CreateCallSessionParams & { familyId: string } = {
      familyId: data.familyId,
      callSessionId: data.callSessionId,
      participants: data.participants,
      initiator: data.initiator,
      state: data.state || 'new',
    };
    const results = await createCallSession.run(params, pool);
    return results[0];
  }

  /**
   * Update call session state
   */
  async updateState(
    familyId: string,
    callSessionId: CallSessionId,
    state: string
  ): Promise<void> {
    await updateCallState.run({ familyId, callSessionId, state }, pool);
  }

  /**
   * Update SDP offer
   */
  async updateSdpOffer(
    familyId: string,
    callSessionId: CallSessionId,
    sdpOffer: string
  ): Promise<void> {
    await updateSdpOffer.run({ familyId, callSessionId, sdpOffer }, pool);
  }

  /**
   * Update SDP answer
   */
  async updateSdpAnswer(
    familyId: string,
    callSessionId: CallSessionId,
    sdpAnswer: string
  ): Promise<void> {
    await updateSdpAnswer.run({ familyId, callSessionId, sdpAnswer }, pool);
  }

  /**
   * Add ICE candidate
   */
  async addIceCandidate(
    familyId: string,
    callSessionId: CallSessionId,
    candidate: { from: string; candidate: unknown }
  ): Promise<void> {
    await addIceCandidate.run({
      familyId,
      callSessionId,
      candidate: JSON.stringify(candidate),
    }, pool);
  }

  /**
   * End call session
   */
  async end(familyId: string, callSessionId: CallSessionId): Promise<void> {
    await endCallSession.run({ familyId, callSessionId }, pool);
  }

  /**
   * Find active call sessions
   */
  async findActive(familyId: string): Promise<FindByCallSessionIdResult[]> {
    return await findActiveCallSessions.run({ familyId }, pool);
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpired(familyId: string): Promise<{ callSessionId: CallSessionId; initiator: IdentityId; participants: IdentityId[]; createdAt: Date; }[]> {
    const results = await cleanupExpiredSessions.run({ familyId }, pool);
    return results.map((row) => ({
      callSessionId: row.call_session_id as CallSessionId,
      initiator: row.initiator as IdentityId,
      participants: row.participants as IdentityId[],
      createdAt: row.created_at
    }));
  }

  /**
   * Count active calls
   */
  async countActiveCalls(familyId: string): Promise<number> {
    const results = await countActiveCalls.run({ familyId }, pool);
    return parseInt(results[0].count ?? '0', 10);
  }
}

export const callSessionRepository = new CallSessionRepository();
