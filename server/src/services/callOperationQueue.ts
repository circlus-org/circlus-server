/** Serializes delivery and terminal commands, not unrelated calls. The server's
 * existing PostgreSQL process lock guarantees a single active API process.
 * Admission itself is additionally transactional and advisory-locked in PG. */
export class CallOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly counts = new Map<string, number>();
  async run<T>(familyId: string, callId: string, operation: () => Promise<T>, isCurrent: () => boolean = () => true): Promise<T> {
    const key = JSON.stringify([familyId, callId]);
    if (!familyId || !callId) throw new Error('CALL_OPERATION_SCOPE_REQUIRED');
    const count = this.counts.get(key) || 0;
    if (count >= 32) throw new Error('CALL_OPERATION_QUEUE_FULL');
    this.counts.set(key, count + 1);
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(key, tail);
    await previous;
    try {
      if (!isCurrent()) throw new Error('CALL_OPERATION_AUTHORITY_CHANGED');
      return await operation();
    }
    finally {
      release(); this.counts.set(key, (this.counts.get(key) || 1) - 1);
      if (this.tails.get(key) === tail) { this.tails.delete(key); this.counts.delete(key); }
    }
  }
}
