export type ActivityTracker = {
  begin: () => () => void;
  activeCount: () => number;
  waitForIdle: (timeoutMs: number) => Promise<boolean>;
};

export function createActivityTracker(): ActivityTracker {
  let active = 0;
  const idleWaiters = new Set<() => void>();

  const notifyIdle = () => {
    if (active !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  return {
    begin() {
      active += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        active = Math.max(0, active - 1);
        notifyIdle();
      };
    },
    activeCount: () => active,
    async waitForIdle(timeoutMs: number) {
      if (active === 0) return true;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (idle: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          idleWaiters.delete(onIdle);
          resolve(idle);
        };
        const onIdle = () => finish(true);
        const timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs));
        timeout.unref?.();
        idleWaiters.add(onIdle);
      });
    }
  };
}
