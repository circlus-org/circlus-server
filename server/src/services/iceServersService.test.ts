import { iceServersService } from './iceServersService';

describe('iceServersService TURN cluster catalog', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      VPS_ID: 'server-1',
      ICE_CONFIG_SERVICE_URL: 'https://ice.example.test',
      ICE_CONFIG_SHARED_SECRET: Buffer.alloc(32, 7).toString('base64'),
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('loads the allowed catalog through the signed S2S endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        result: {
          defaultTurnClusterId: 'local',
          turnClusters: [{
            id: 'local',
            displayName: 'Local TURN',
            status: 'active',
            ownership: 'local',
            urls: ['turn:local.example.test:3478'],
            authMode: 'turn-rest-secret',
          }],
        },
      }),
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(iceServersService.listTurnClusters()).resolves.toEqual(expect.objectContaining({
      defaultTurnClusterId: 'local',
    }));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ice.example.test/v1/turn-clusters',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({
          'X-Ice-Server-Id': 'server-1',
          'X-Ice-Key-Id': 'k1',
          'X-Ice-Signature': expect.any(String),
        }),
      })
    );
  });
});
