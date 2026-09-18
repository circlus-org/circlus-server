import { classifyWsRateLimitBucket, WsRateLimiter } from './wsRateLimiter';

describe('WsRateLimiter', () => {
  it('classifies call termination separately from other call signaling', () => {
    expect(classifyWsRateLimitBucket('call:hangup')).toBe('call:termination');
    expect(classifyWsRateLimitBucket('call:ice-candidate')).toBe('call:signaling');
    expect(classifyWsRateLimitBucket('message:send')).toBe('general');
  });

  it('tracks each connection and bucket independently', () => {
    const limiter = new WsRateLimiter<object>({
      general: 2,
      'call:signaling': 1,
      'call:termination': 1
    });
    const first = {};
    const second = {};

    expect(limiter.consume(first, 'message:send', 1).limitExceeded).toBe(false);
    expect(limiter.consume(first, 'message:send', 2).limitExceeded).toBe(false);
    expect(limiter.consume(first, 'message:send', 3).limitExceeded).toBe(true);
    expect(limiter.consume(first, 'call:offer', 4).limitExceeded).toBe(false);
    expect(limiter.consume(second, 'message:send', 5).count).toBe(1);
  });

  it('resets a bucket after the window and removes all connection state', () => {
    const limiter = new WsRateLimiter<object>({
      general: 1,
      'call:signaling': 1,
      'call:termination': 1
    }, 100);
    const connection = {};

    limiter.consume(connection, 'message:send', 10);
    expect(limiter.consume(connection, 'message:send', 109).limitExceeded).toBe(true);
    expect(limiter.consume(connection, 'message:send', 110).count).toBe(1);
    limiter.consume(connection, 'call:offer', 111);
    limiter.remove(connection);
    expect(limiter.consume(connection, 'call:offer', 112).count).toBe(1);
  });
});
