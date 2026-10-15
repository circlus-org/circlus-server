import { CallOperationQueue } from './callOperationQueue';
it('orders offer/cancel while unrelated Circle/call work proceeds', async () => {
  const queue = new CallOperationQueue(), events: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const offer = queue.run('family-a', 'call-a', async () => { events.push('offer'); await barrier; events.push('delivered'); });
  const cancel = queue.run('family-a', 'call-a', async () => { events.push('cancel'); });
  await queue.run('family-b', 'call-a', async () => { events.push('other-circle'); });
  expect(events).toEqual(['offer', 'other-circle']);
  release(); await Promise.all([offer, cancel]);
  expect(events).toEqual(['offer', 'other-circle', 'delivered', 'cancel']);
});
it('releases the queue after failure and does not substitute missing IDs', async () => {
  const queue = new CallOperationQueue();
  await expect(queue.run('', 'call-a', async () => {})).rejects.toThrow('CALL_OPERATION_SCOPE_REQUIRED');
  await expect(queue.run('family-a', '', async () => {})).rejects.toThrow('CALL_OPERATION_SCOPE_REQUIRED');
  await expect(queue.run('family-a', 'call-a', async () => { throw new Error('failure'); })).rejects.toThrow('failure');
  expect(await queue.run('family-a', 'call-a', async () => 'next')).toBe('next');
});
it('does not let a queued event select a reauthenticated or disconnected actor', async () => {
  const queue = new CallOperationQueue();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const initial = { identity: 'identity-a', device: 'device-a' };
  let current: typeof initial | undefined = initial;
  const first = queue.run('family-a', 'call-a', async () => { await barrier; });
  const execute = jest.fn();
  const stale = queue.run('family-a', 'call-a', execute, () => current === initial);
  current = { identity: 'identity-b', device: 'device-b' };
  const rejected = expect(stale).rejects.toThrow('CALL_OPERATION_AUTHORITY_CHANGED');
  release(); await first; await rejected; expect(execute).not.toHaveBeenCalled();
  current = undefined;
  await expect(queue.run('family-a', 'call-a', execute, () => current === initial)).rejects.toThrow('CALL_OPERATION_AUTHORITY_CHANGED');
  expect(execute).not.toHaveBeenCalled();
});
