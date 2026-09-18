import type { Logger } from './logger';
import { createRouteLogFunctions } from './routeLogger';

describe('route logger', () => {
  it('uses a stable event and separates the operation from the error', () => {
    const error = jest.fn();
    const logger = createLoggerStub({ error });
    const routeLog = createRouteLogFunctions(() => logger);
    const cause = new Error('boom');

    routeLog.error('Load channel posts error:', cause);

    expect(error).toHaveBeenCalledWith('http_route_failed', {
      operation: 'load_channel_posts_error',
      error: cause
    });
  });

  it('keeps structured context but drops trailing primitive values', () => {
    const warn = jest.fn();
    const logger = createLoggerStub({ warn });
    const routeLog = createRouteLogFunctions(() => logger);

    routeLog.warn('[Mobile] rejected invalid token', {
      familyId: 'family-1',
      deliveryToken: 'secret'
    }, 'unstructured secret');

    expect(warn).toHaveBeenCalledWith('http_route_warning', {
      operation: 'mobile_rejected_invalid_token',
      details: {
        familyId: 'family-1',
        deliveryToken: 'secret'
      }
    });
  });
});

function createLoggerStub(overrides: Partial<Logger>): Logger {
  const logger: Logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => logger),
    ...overrides
  };
  return logger;
}
