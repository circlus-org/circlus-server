export type RuntimeHealth = {
  markReady: () => void;
  markNotReady: () => void;
  isReady: () => boolean;
  readiness: () => Promise<{ ready: boolean; reason?: 'starting' | 'shutting_down' | 'database_unavailable' }>;
};

export function createRuntimeHealth(checkDatabase: () => Promise<void>): RuntimeHealth {
  let lifecycleState: 'starting' | 'ready' | 'shutting_down' = 'starting';

  return {
    markReady: () => { lifecycleState = 'ready'; },
    markNotReady: () => { lifecycleState = 'shutting_down'; },
    isReady: () => lifecycleState === 'ready',
    async readiness() {
      if (lifecycleState !== 'ready') {
        return { ready: false, reason: lifecycleState };
      }
      try {
        await checkDatabase();
        return { ready: true };
      } catch {
        return { ready: false, reason: 'database_unavailable' };
      }
    }
  };
}
