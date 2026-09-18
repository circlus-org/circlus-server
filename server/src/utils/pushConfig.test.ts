jest.mock('../db/repositories', () => ({}));
jest.mock('./pushServiceS2S', () => ({}));
jest.mock('./mobileCallActionToken', () => ({}));
jest.mock('./serverIdentity', () => ({
  normalizePublicServerUrl: () => '',
  resolveServerIdForClients: () => '',
  resolveServerOriginForClients: () => '',
}));
jest.mock('../services/configService', () => ({ configService: {} }));

describe('push config validation', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  test('does not throw when relay delivery is disabled', async () => {
    process.env.ENABLE_RELAY_DELIVERY = 'false';
    delete process.env.PUSH_SERVICE_URL;

    const { validatePushConfig } = await import('./push');

    expect(() => validatePushConfig()).not.toThrow();
  });

  test('throws when relay delivery is enabled without PUSH_SERVICE_URL', async () => {
    process.env.ENABLE_RELAY_DELIVERY = 'true';
    delete process.env.PUSH_SERVICE_URL;

    const { validatePushConfig } = await import('./push');

    expect(() => validatePushConfig()).toThrow('PUSH_SERVICE_URL is required');
  });
});
