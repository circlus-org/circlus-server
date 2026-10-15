import { AsyncLocalStorage } from 'node:async_hooks';

/** Native SDP database transactions must never await push/network delivery.
 * These effects run only after the durable command and its outbox commit. */
export const callSdpEffects = new AsyncLocalStorage<Array<() => Promise<void>>>();
export function deferCallSdpEffect(effect: () => Promise<void>): boolean {
  const effects = callSdpEffects.getStore();
  if (!effects) return false;
  effects.push(effect); return true;
}
