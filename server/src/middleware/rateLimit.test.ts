import type { Request, Response } from 'express';
import { createRateLimiter, ipFamilyKey, ipKey } from './rateLimit';

function makeReq(overrides?: Partial<Request>): Request {
  return {
    ip: '127.0.0.1',
    ...overrides
  } as Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res: Partial<Response> & {
    headers: Record<string, string>;
    statusCode?: number;
    body?: unknown;
  } = {
    headers,
    setHeader: jest.fn(function setHeader(this: any, name: string, value: string | number | readonly string[]) {
      headers[name] = String(value);
      return this;
    }),
    status: jest.fn(function status(this: any, code: number) {
      res.statusCode = code;
      return this;
    }),
    json: jest.fn(function json(this: any, body: unknown) {
      res.body = body;
      return this;
    })
  };
  return res as Response & typeof res;
}

describe('rateLimit helpers', () => {
  test('ipKey and ipFamilyKey produce expected format', () => {
    const req = makeReq({ ip: ' 10.0.0.5 ', familyId: ' family-1 ' } as any);

    expect(ipKey(req)).toBe('ip:10.0.0.5');
    expect(ipFamilyKey(req)).toBe('ip:10.0.0.5|family:family-1');
  });

  test('createRateLimiter blocks requests above configured max', () => {
    const limiter = createRateLimiter({
      name: 'test',
      windowMs: 60_000,
      max: 2,
      keyFn: ipKey
    });

    const req = makeReq();
    const next = jest.fn();

    const res1 = makeRes();
    limiter(req, res1, next);
    expect(next).toHaveBeenCalledTimes(1);

    const res2 = makeRes();
    limiter(req, res2, next);
    expect(next).toHaveBeenCalledTimes(2);

    const res3 = makeRes();
    limiter(req, res3, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res3.status).toHaveBeenCalledWith(429);
    expect(res3.headers['Retry-After']).toBeDefined();
  });
});
