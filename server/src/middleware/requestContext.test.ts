import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import {
  createRequestContextMiddleware,
  getRequestContext,
  getRequestLogger,
  updateRequestContext
} from './requestContext';
import { serverLogger } from '../utils/logger';

function response(): Response & EventEmitter {
  const res = new EventEmitter() as Response & EventEmitter;
  res.statusCode = 200;
  res.writableEnded = true;
  res.setHeader = jest.fn() as any;
  return res;
}

function request(requestId?: string): Request {
  return {
    method: 'POST',
    get: jest.fn((name: string) => name.toLowerCase() === 'x-request-id' ? requestId : undefined)
  } as unknown as Request;
}

function logger() {
  return {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn()
  };
}

describe('HTTP request context', () => {
  it('keeps a valid request id and exposes family context to asynchronous work', async () => {
    const log = logger();
    const res = response();
    let observed: unknown;
    const middleware = createRequestContextMiddleware({
      logger: log as any,
      createRequestId: () => 'generated-id',
      now: () => 100
    });

    await new Promise<void>((resolve) => {
      middleware(request('client-request-1'), res, (() => {
        updateRequestContext({ familyId: 'family-1' });
        setImmediate(() => {
          observed = getRequestContext();
          resolve();
        });
      }) as NextFunction);
    });
    res.emit('finish');

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'client-request-1');
    expect(observed).toEqual({
      requestId: 'client-request-1',
      method: 'POST',
      familyId: 'family-1'
    });
    expect(log.info).toHaveBeenCalledWith('http_request_completed', {
      requestId: 'client-request-1',
      method: 'POST',
      familyId: 'family-1',
      statusCode: 200,
      durationMs: 0,
      aborted: false
    });
  });

  it('replaces unsafe request ids and logs an aborted response only once', () => {
    const log = logger();
    const res = response();
    res.statusCode = 499;
    res.writableEnded = false;
    let currentTime = 10;
    const middleware = createRequestContextMiddleware({
      logger: log as any,
      createRequestId: () => 'generated-id',
      now: () => currentTime
    });

    middleware(request('unsafe request id\nvalue'), res, jest.fn());
    currentTime = 25;
    res.emit('close');
    res.emit('finish');

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'generated-id');
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'http_request_completed',
      expect.objectContaining({ durationMs: 15, aborted: true })
    );
  });

  it('creates request-scoped loggers with correlation context', () => {
    const log = logger();
    const child = jest.spyOn(serverLogger, 'child').mockReturnValue(log as any);
    const res = response();
    const middleware = createRequestContextMiddleware({
      logger: log as any,
      createRequestId: () => 'generated-id'
    });

    middleware(request('request-1'), res, (() => {
      updateRequestContext({ familyId: 'family-1' });
      getRequestLogger({ subsystem: 'push' });
    }) as NextFunction);

    expect(child).toHaveBeenCalledWith({
      requestId: 'request-1',
      method: 'POST',
      familyId: 'family-1',
      subsystem: 'push'
    });
    child.mockRestore();
  });
});
