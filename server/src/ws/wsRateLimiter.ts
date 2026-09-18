export type WsRateLimitBucket = 'general' | 'call:signaling' | 'call:termination';

export type WsRateLimitResult = {
  bucket: WsRateLimitBucket;
  count: number;
  limit: number;
  limitExceeded: boolean;
};

type BucketState = { count: number; windowStart: number };

export class WsRateLimiter<Connection extends object> {
  private readonly states: Record<WsRateLimitBucket, Map<Connection, BucketState>> = {
    general: new Map(),
    'call:signaling': new Map(),
    'call:termination': new Map()
  };

  constructor(
    private readonly limits: Record<WsRateLimitBucket, number>,
    private readonly windowMs = 60_000
  ) {}

  consume(connection: Connection, messageType: string, now = Date.now()): WsRateLimitResult {
    const bucket = classifyWsRateLimitBucket(messageType);
    const states = this.states[bucket];
    const state = states.get(connection) || { count: 0, windowStart: now };
    if (now - state.windowStart >= this.windowMs) {
      state.windowStart = now;
      state.count = 0;
    }
    state.count += 1;
    states.set(connection, state);
    const limit = this.limits[bucket];
    return { bucket, count: state.count, limit, limitExceeded: state.count > limit };
  }

  remove(connection: Connection): void {
    for (const states of Object.values(this.states)) {
      states.delete(connection);
    }
  }
}

export function classifyWsRateLimitBucket(messageType: string): WsRateLimitBucket {
  if (
    messageType === 'call:cancel'
    || messageType === 'call:decline'
    || messageType === 'call:hangup'
  ) {
    return 'call:termination';
  }
  return messageType.startsWith('call:') ? 'call:signaling' : 'general';
}
