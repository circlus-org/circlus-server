import { createCorsOptions, isTrustedClientRequestOrigin } from './security';
import { configService } from '../services/configService';
import type { CorsOptions } from 'cors';

jest.mock('../services/configService', () => ({
  configService: {
    getFamilyConfig: jest.fn()
  }
}));

function checkCorsOrigin(origin: string | undefined, familyId = 'family-1'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const delegate = createCorsOptions();
    delegate({ familyId } as any, (error, options) => {
      if (error) {
        reject(error);
        return;
      }

      const originOption = options?.origin;
      if (typeof originOption !== 'function') {
        reject(new Error('Expected dynamic CORS origin function'));
        return;
      }

      originOption(origin, (originError, allowed) => {
        if (originError) {
          reject(originError);
          return;
        }
        resolve(Boolean(allowed));
      });
    });
  });
}

function getCorsOptions(familyId = 'family-1'): Promise<CorsOptions> {
  return new Promise((resolve, reject) => {
    createCorsOptions()({ familyId } as any, (error, options) => {
      if (error || !options) {
        reject(error || new Error('Expected CORS options'));
        return;
      }
      resolve(options);
    });
  });
}

describe('createCorsOptions', () => {
  const getFamilyConfig = configService.getFamilyConfig as jest.Mock;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TRUSTED_CLIENT_ORIGINS = 'https://ru.circlus.org';
    getFamilyConfig.mockResolvedValue({
      extra_trusted_client_origins: ['https://custom.example.com']
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('allows requests without Origin header', async () => {
    await expect(checkCorsOrigin(undefined)).resolves.toBe(true);
  });

  test('allows official, global, and per-family trusted client origins', async () => {
    await expect(checkCorsOrigin('https://web.circlus.org')).resolves.toBe(true);
    await expect(checkCorsOrigin('https://ru.circlus.org')).resolves.toBe(true);
    await expect(checkCorsOrigin('https://custom.example.com')).resolves.toBe(true);
  });

  test('rejects untrusted origins', async () => {
    await expect(checkCorsOrigin('https://evil.example.com')).resolves.toBe(false);
  });

  test('allows the inspector request and session pickup headers', async () => {
    const options = await getCorsOptions();
    expect(options.allowedHeaders).toContain('X-Inspector-Request-Token');
    expect(options.allowedHeaders).toContain('X-Inspector-Session-Pickup');
  });

  test('fails closed when family config lookup fails', async () => {
    getFamilyConfig.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(checkCorsOrigin('https://ru.circlus.org')).resolves.toBe(false);
  });

  test('exposes the same trusted-origin policy for websocket upgrades', async () => {
    await expect(isTrustedClientRequestOrigin('https://web.circlus.org', 'family-1')).resolves.toBe(true);
    await expect(isTrustedClientRequestOrigin('https://ru.circlus.org', 'family-1')).resolves.toBe(true);
    await expect(isTrustedClientRequestOrigin('https://evil.example.com', 'family-1')).resolves.toBe(false);
    await expect(isTrustedClientRequestOrigin(undefined, 'family-1')).resolves.toBe(true);
  });
});
