import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { WebSocketMessage } from '@shared/types';
import { CallSdpRecovery } from './callSdpRecovery';
import type { LocalConnectionInfo } from '../ws/wsConnectionContext';

const ws = {} as WebSocket, successor = {} as WebSocket;
const local: LocalConnectionInfo = { actorType: 'local', familyId: 'circle-a', identityId: 'local', deviceId: 'device',
  scopedRemoteIdentityId: 'remote', scopedCallSessionId: 'call', callRuntimeRole: 'caller', runtimeMode: 'video-native', sdpRecoveryVersion: 1 };
const command = (id = randomUUID(), changes = {}) => ({ type: 'call:offer', data: { callSessionId: 'call', targetIdentityId: 'remote',
  offer: { sdp: 'private-sdp', type: 'offer' }, sdpRecoveryVersion: 1, sdpOperationId: id, ...changes }, timestamp: 1 }) as WebSocketMessage;
function setup() {
  let now = 0;
  const actors = new Map([[ws, local], [successor, local]]);
  const sent = jest.fn(), diagnostic = jest.fn(), authorize = jest.fn(async () => true);
  const recovery = new CallSdpRecovery({ info: socket => actors.get(socket), send: sent, diagnostic, authorize, now: () => now });
  return { recovery, sent, diagnostic, authorize, actors, advance: () => { now += 121_000; } };
}
describe('SDP recovery protocol v1', () => {
  it('retries an initial offer without repeating admission, ringing or push', async () => {
    const { recovery, sent } = setup(); const dispatch = jest.fn(async () => {}), message = command();
    await recovery.execute(ws, local, message, dispatch);
    await recovery.execute(successor, local, { ...message, data: { ...(message.data as any), sdpOperationId: (message.data as any).sdpOperationId.toUpperCase() }, timestamp: 2 }, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls.map(call => call[1].type)).toEqual(['call:sdp-committed', 'call:sdp-committed']);
  });
  it('canonicalizes nested key order and rejects a conflicting body for the same ID', async () => {
    const { recovery, sent, diagnostic } = setup(); const dispatch = jest.fn(async () => {}), message = command();
    await recovery.execute(ws, local, message, dispatch);
    const data = message.data as any;
    await recovery.execute(successor, local, { ...message, data: { ...data, offer: { type: 'offer', sdp: 'private-sdp' } } }, dispatch);
    await recovery.execute(successor, local, { ...message, data: { ...data, offer: { sdp: 'different-private-sdp' } } }, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls.at(-1)![1].data.message).toBe('CALL_SDP_OPERATION_CONFLICT');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-sdp');
  });
  it('does not commit a queued duplicate before the first operation finishes', async () => {
    const { recovery, sent } = setup(); let release!: () => void;
    const dispatch = jest.fn(() => new Promise<void>(resolve => { release = resolve; })), message = command();
    const first = recovery.execute(ws, local, message, dispatch);
    await new Promise(resolve => setImmediate(resolve));
    const duplicate = recovery.execute(successor, local, message, dispatch);
    await new Promise(resolve => setImmediate(resolve)); expect(sent).not.toHaveBeenCalled();
    release(); await Promise.all([first, duplicate]); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(2);
  });
  it('keeps outcome after the original socket closes and replays it to its selected successor', async () => {
    const { recovery, sent, actors } = setup(); const message = command();
    await recovery.execute(ws, local, message, async () => { actors.delete(ws); });
    expect(sent).not.toHaveBeenCalled();
    await recovery.execute(successor, local, message, async () => { throw new Error('must not redispatch'); });
    expect(sent.mock.calls.at(-1)![1].type).toBe('call:sdp-committed');
  });
  it.each([undefined, '', 'bad', 12])('rejects missing/invalid operation ID %p', async id => {
    const { recovery, sent } = setup(), dispatch = jest.fn();
    await recovery.execute(ws, local, command(randomUUID(), { sdpOperationId: id }), dispatch);
    expect(dispatch).not.toHaveBeenCalled(); expect(sent.mock.calls.at(-1)![1].data.message).toBe('CALL_SDP_OPERATION_REQUIRED');
  });
  it('checks selected authority even for a known duplicate and ACK', async () => {
    const { recovery, authorize, sent } = setup(); const message = command();
    await recovery.execute(ws, local, message, async () => {}); authorize.mockResolvedValue(false); sent.mockClear();
    await recovery.execute(successor, local, message, async () => { throw new Error('must not run'); });
    await recovery.acknowledge(ws, local, { callSessionId: 'call', sdpRecoveryVersion: 1, sdpDeliveryId: randomUUID() });
    expect(sent).not.toHaveBeenCalled();
  });
  it('retains handler rejection without issuing a committed receipt', async () => {
    const { recovery, sent } = setup(); const message = command(), dispatch = jest.fn(async () => {
      recovery.capture(ws, { type: 'error', data: { code: 'FORBIDDEN', message: 'denied' }, timestamp: 1 });
    });
    await recovery.execute(ws, local, message, dispatch); await recovery.execute(successor, local, message, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls.every(call => call[1].type === 'error')).toBe(true);
  });
  it('does not ACK a throwing handler or run it again', async () => {
    const { recovery, sent } = setup(); const message = command(), dispatch = jest.fn(async () => { throw new Error('private failure'); });
    await recovery.execute(ws, local, message, dispatch); await recovery.execute(successor, local, message, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(JSON.stringify(sent.mock.calls)).not.toContain('private failure');
    expect(sent.mock.calls.every(call => call[1].type === 'error')).toBe(true);
  });
  it.each(['call:answered', 'call:renegotiate-offer', 'call:renegotiate-answer'])('replays %s with the same delivery ID until scoped ACK', async type => {
    const { recovery, sent } = setup();
    const message = recovery.capture(ws, { type, data: { callSessionId: 'call', answer: { sdp: 'private' } }, timestamp: 1 });
    expect(recovery.capture(ws, message)).toBe(message);
    recovery.replay(successor, local, 'call'); recovery.replay(successor, local, 'call');
    expect(sent.mock.calls.map(call => call[1])).toEqual([message, message]);
    await recovery.acknowledge(successor, local, { ...(message.data as any), sdpDeliveryId: (message.data as any).sdpDeliveryId.toUpperCase() });
    sent.mockClear(); recovery.replay(successor, local, 'call'); expect(sent).not.toHaveBeenCalled();
  });
  it.each([{ ...local, deviceId: 'sibling' }, { ...local, scopedRemoteIdentityId: 'other' }, { ...local, familyId: 'circle-b' }])('isolates mailbox authority %p', async other => {
    const { recovery, sent } = setup();
    const message = recovery.capture(ws, { type: 'call:answered', data: { callSessionId: 'call', answer: {} }, timestamp: 1 });
    recovery.replay(successor, other, 'call'); expect(sent).not.toHaveBeenCalled();
    await recovery.acknowledge(successor, other, message.data);
    sent.mockClear(); recovery.replay(successor, local, 'call'); expect(sent).toHaveBeenCalledWith(successor, message);
  });
  it('terminal state clears the mailbox and cannot be revived by another resume', () => {
    const { recovery, sent, advance } = setup();
    recovery.capture(ws, { type: 'call:answered', data: { callSessionId: 'call', answer: {} }, timestamp: 1 });
    recovery.close(local.familyId, 'call'); recovery.replay(ws, local, 'call'); expect(sent).not.toHaveBeenCalled();
    advance(); recovery.replay(ws, local, 'call'); expect(sent).not.toHaveBeenCalled();
  });
  it('captures a description for an exactly remembered endpoint even after transport removal', () => {
    const { recovery, actors, sent } = setup();
    recovery.remember(ws, local); actors.delete(ws);
    const message = recovery.capture(ws, { type: 'call:answered', data: { callSessionId: 'call', answer: {} }, timestamp: 1 });
    recovery.replay(successor, local, 'call'); expect(sent).toHaveBeenCalledWith(successor, message);
    expect((message.data as any).sdpDeliveryId).toBeTruthy();
  });
  it('bounds outstanding delivery memory instead of discarding unacknowledged SDP', () => {
    const { recovery } = setup();
    for (let n = 0; n < 32; n++) recovery.capture(ws, { type: 'call:answered', data: { callSessionId: 'call', answer: {} }, timestamp: n });
    expect(() => recovery.capture(ws, { type: 'call:answered', data: { callSessionId: 'call', answer: {} }, timestamp: 40 })).toThrow('CALL_SDP_MAILBOX_LIMIT');
  });
});
