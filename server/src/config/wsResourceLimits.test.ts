import { loadCallRuntimeConfig } from './callRuntimeConfig';

describe('WS resource configuration', () => {
  test.each(['0', '-1', 'Infinity', 'NaN', '1.5', '100001'])('rejects invalid connection limit %s', value => {
    expect(() => loadCallRuntimeConfig({ WS_MAX_CONNECTIONS: value })).toThrow('WS_MAX_CONNECTIONS');
  });
  test('accepts bounded explicit settings', () => {
    expect(loadCallRuntimeConfig({ WS_MAX_CONNECTIONS: '512', WS_MAX_GLOBAL_QUEUED_BYTES: '67108864' }).webSocket.limits)
      .toMatchObject({ maxConnections: 512, maxGlobalQueuedBytes: 67108864 });
  });
});
