import type { NextFunction, Request, Response } from 'express';
import { createRequestBodyErrorHandler } from './requestBodyError';

function logger() {
  return {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn()
  };
}

function request(overrides: Partial<Request> = {}): Request {
  return {
    destroyed: false,
    aborted: false,
    originalUrl: '/api/test',
    url: '/api/test',
    get: jest.fn(() => '123'),
    ...overrides
  } as unknown as Request;
}

function response(overrides: Partial<Response> = {}) {
  const res = {
    destroyed: false,
    headersSent: false,
    status: jest.fn(),
    json: jest.fn(),
    ...overrides
  } as unknown as Response;
  (res.status as jest.Mock).mockReturnValue(res);
  return res;
}

describe('request body error handler', () => {
  it('passes unrelated parser errors to the normal error chain', () => {
    const log = logger();
    const next = jest.fn() as NextFunction;
    const error = Object.assign(new Error('invalid json'), { type: 'entity.parse.failed' });

    createRequestBodyErrorHandler({ getLogger: () => log as any })(
      error,
      request(),
      response(),
      next
    );

    expect(next).toHaveBeenCalledWith(error);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('handles an aborted request without trying to write to its closed socket', () => {
    const log = logger();
    const res = response();

    createRequestBodyErrorHandler({ getLogger: () => log as any })(
      Object.assign(new Error('aborted'), { type: 'stream.not.readable', status: 500 }),
      request({ destroyed: true }),
      res,
      jest.fn()
    );

    expect(log.warn).toHaveBeenCalledWith(
      'http_request_body_unavailable',
      expect.objectContaining({ connectionClosed: true, errorType: 'stream.not.readable' })
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns a structured server error when an open request stream was consumed early', () => {
    const log = logger();
    const res = response();

    createRequestBodyErrorHandler({ getLogger: () => log as any })(
      Object.assign(new Error('not readable'), { type: 'stream.not.readable', status: 500 }),
      request(),
      res,
      jest.fn()
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Request body is unavailable',
      code: 'REQUEST_BODY_UNAVAILABLE'
    });
  });

  it('returns a client error when raw-body reports an aborted request', () => {
    const log = logger();
    const res = response();

    createRequestBodyErrorHandler({ getLogger: () => log as any })(
      Object.assign(new Error('aborted'), { type: 'request.aborted', status: 400 }),
      request(),
      res,
      jest.fn()
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Request body was not fully received',
      code: 'REQUEST_BODY_INCOMPLETE'
    });
  });
});
