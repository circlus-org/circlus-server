import { createActivityTracker } from './activityTracker';

describe('activity tracker', () => {
  it('waits until every activity has finished', async () => {
    const tracker = createActivityTracker();
    const finishFirst = tracker.begin();
    const finishSecond = tracker.begin();
    const idle = tracker.waitForIdle(1_000);

    finishFirst();
    expect(tracker.activeCount()).toBe(1);
    finishSecond();

    await expect(idle).resolves.toBe(true);
  });

  it('times out while work is still active', async () => {
    const tracker = createActivityTracker();
    const finish = tracker.begin();
    await expect(tracker.waitForIdle(1)).resolves.toBe(false);
    finish();
  });

  it('makes completion idempotent', () => {
    const tracker = createActivityTracker();
    const finish = tracker.begin();
    finish();
    finish();
    expect(tracker.activeCount()).toBe(0);
  });
});
