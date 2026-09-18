import { createRuntimeHealth } from './runtimeHealth';

describe('runtime health', () => {
  it('is not ready until startup completes and while shutting down', async () => {
    const health = createRuntimeHealth(async () => undefined);
    await expect(health.readiness()).resolves.toEqual({ ready: false, reason: 'starting' });
    health.markReady();
    await expect(health.readiness()).resolves.toEqual({ ready: true });
    health.markNotReady();
    await expect(health.readiness()).resolves.toEqual({ ready: false, reason: 'shutting_down' });
  });

  it('reports database failures without throwing', async () => {
    const health = createRuntimeHealth(async () => { throw new Error('offline'); });
    health.markReady();
    await expect(health.readiness()).resolves.toEqual({
      ready: false,
      reason: 'database_unavailable'
    });
  });
});
