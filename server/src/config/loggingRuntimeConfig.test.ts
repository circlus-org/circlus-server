import { loadLoggingRuntimeConfig } from './loggingRuntimeConfig';

describe('logging runtime config', () => {
  it('uses quiet readable logging in tests and JSON logging in production', () => {
    expect(loadLoggingRuntimeConfig({ NODE_ENV: 'test' })).toEqual({
      level: 'silent',
      format: 'pretty'
    });
    expect(loadLoggingRuntimeConfig({ NODE_ENV: 'production' })).toEqual({
      level: 'info',
      format: 'json'
    });
  });

  it('accepts explicit supported values', () => {
    expect(loadLoggingRuntimeConfig({
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug',
      LOG_FORMAT: 'json'
    })).toEqual({ level: 'debug', format: 'json' });
  });

  it('rejects unsupported levels and formats', () => {
    expect(() => loadLoggingRuntimeConfig({
      NODE_ENV: 'production',
      LOG_LEVEL: 'verbose'
    })).toThrow('LOG_LEVEL must be one of');
    expect(() => loadLoggingRuntimeConfig({
      NODE_ENV: 'production',
      LOG_FORMAT: 'text'
    })).toThrow('LOG_FORMAT must be json or pretty');
  });
});
