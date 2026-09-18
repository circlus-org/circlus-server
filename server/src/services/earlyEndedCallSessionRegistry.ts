import type { CallSessionId, IdentityId } from '@shared/types';

type EarlyEndedCallSession = {
  endedByIdentityId: IdentityId;
  expiresAt: number;
};

export class EarlyEndedCallSessionRegistry {
  private readonly sessions = new Map<string, EarlyEndedCallSession>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('Early-ended call session TTL must be positive');
    }
  }

  remember(params: {
    familyId: string;
    callSessionId: CallSessionId | string;
    endedByIdentityId: IdentityId;
  }): void {
    const callSessionId = this.normalizeCallSessionId(params.callSessionId);
    if (!callSessionId) return;
    const now = this.now();
    this.cleanup(now);
    this.sessions.set(this.key(params.familyId, callSessionId), {
      endedByIdentityId: params.endedByIdentityId,
      expiresAt: now + this.ttlMs
    });
  }

  consume(params: {
    familyId: string;
    callSessionId: CallSessionId | string;
    initiatorIdentityId: IdentityId;
  }): boolean {
    const callSessionId = this.normalizeCallSessionId(params.callSessionId);
    if (!callSessionId) return false;
    const now = this.now();
    this.cleanup(now);
    const key = this.key(params.familyId, callSessionId);
    const session = this.sessions.get(key);
    if (!session || session.endedByIdentityId !== params.initiatorIdentityId) {
      return false;
    }
    this.sessions.delete(key);
    return true;
  }

  private cleanup(now: number): void {
    for (const [key, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }

  private key(familyId: string, callSessionId: string): string {
    return `${familyId}:${callSessionId}`;
  }

  private normalizeCallSessionId(callSessionId: CallSessionId | string): string {
    return String(callSessionId || '').trim();
  }
}
