import { CallIceWsHandler } from './callIceWsHandler';
import type { WebSocket } from 'ws';
import type { LocalConnectionInfo } from './wsConnectionContext';

function fixture() {
  const ws = {} as WebSocket;
  let info: LocalConnectionInfo = { actorType: 'local', runtimeMode: 'video-native', familyId: 'family-a',
    identityId: 'local-a', deviceId: 'device-a', scopedCallSessionId: 'call-a' };
  let route = { familyId: 'family-a', initiatorIdentityId: 'local-a', initiatorDeviceId: 'device-a', initiatorWs: ws,
    targetIdentityId: 'remote-a', acceptedTargetWs: {} as WebSocket, acceptedTargetDeviceId: 'device-b' };
  const data = { requestId: '6b810d50-95ef-4f46-9fb3-e200a1059733', callSessionId: 'call-a', vpsId: 'vps', circleId: 'circle-a',
    localIdentityId: 'local-a', deviceId: 'device-a', remoteIdentityId: 'remote-a' };
  const call = { state: 'active', participants: ['local-a', 'remote-a'], initiator: 'local-a', ended_at: null as Date | null, expires_at: null };
  const device = { identity_id: 'local-a', status: 'active' };
  const deps = { getInfo: () => info, getCircleId: () => 'circle-a', getVpsId: () => 'vps', getRoute: () => route,
    getConfig: jest.fn(async () => ({ circle_id: 'circle-a' })), getCall: jest.fn(async () => call),
    getDevice: jest.fn(async () => device), getIdentity: jest.fn(async () => ({ status: 'active' })),
    getIce: jest.fn(async () => [{ urls: 'turn:relay.example', username: 'fresh-call-user', credential: 'secret' }]),
    send: jest.fn(), reject: jest.fn(), diagnostic: jest.fn(), now: () => 10_000 };
  return { ws, data, deps, call, device, setInfo: (next: LocalConnectionInfo) => { info = next; },
    getInfo: () => info, replaceSocket: () => { route = { ...route, initiatorWs: {} as WebSocket }; },
    handler: new CallIceWsHandler(deps) };
}
it('issues fresh call-scoped TURN on the exact delegated media runtime with correlated response', async () => {
  const f = fixture(); await f.handler.handle(f.ws, f.data);
  expect(f.deps.getIce).toHaveBeenCalledWith({ familyId: 'family-a', callSessionId: 'call-a' });
  expect(f.deps.send).toHaveBeenCalledWith(f.ws, { type: 'call:ice-configured', data: { ...f.data, iceServers: await f.deps.getIce() }, timestamp: 10_000 });
  expect(f.deps.reject).not.toHaveBeenCalled();
});
it.each(['requestId', 'callSessionId', 'vpsId', 'circleId', 'localIdentityId', 'deviceId', 'remoteIdentityId'])('rejects missing %s without issuing TURN', async field => {
  const f = fixture(); await f.handler.handle(f.ws, { ...f.data, [field]: '' });
  expect(f.deps.getIce).not.toHaveBeenCalled();
  expect(f.deps.diagnostic).toHaveBeenCalledWith({ operation: 'call.iceConfig', reason: 'CALL_ROUTE_INCOMPLETE', missingFields: [field] });
});
it.each(['callSessionId', 'vpsId', 'circleId', 'localIdentityId', 'deviceId', 'remoteIdentityId'])('rejects mismatched %s, including two Circles on the same transport', async field => {
  const f = fixture(); await f.handler.handle(f.ws, { ...f.data, [field]: 'other' });
  expect(f.deps.getIce).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled();
});
it.each(['terminal', 'default', 'other-device', 'other-family'])('rejects %s authority', async mode => {
  const f = fixture(), info = f.getInfo();
  f.setInfo({ ...info, ...(mode === 'terminal' ? { callRuntimePurpose: 'terminal' } : mode === 'default' ? { runtimeMode: 'default' }
    : mode === 'other-device' ? { deviceId: 'device-other' } : { familyId: 'family-b' }) });
  await f.handler.handle(f.ws, f.data); expect(f.deps.getIce).not.toHaveBeenCalled();
});
it.each(['ended', 'revoked', 'replaced', 'participants', 'config'])('rechecks %s after asynchronous TURN issuance', async change => {
  const f = fixture(); f.deps.getIce.mockImplementationOnce(async () => {
    if (change === 'ended') f.call.ended_at = new Date();
    if (change === 'revoked') f.device.status = 'disabled';
    if (change === 'replaced') f.replaceSocket();
    if (change === 'participants') f.call.participants = ['local-a', 'remote-a', 'unknown'];
    if (change === 'config') f.deps.getConfig.mockResolvedValue({ circle_id: 'circle-b' });
    return [];
  });
  await f.handler.handle(f.ws, f.data); expect(f.deps.send).not.toHaveBeenCalled();
  expect(f.deps.diagnostic).toHaveBeenCalledWith({ operation: 'call.iceConfig', reason: 'CALL_ICE_AUTHORITY_CHANGED' });
});
it('bounds issuance, fails closed on provider errors and never logs credentials', async () => {
  const f = fixture(); f.deps.getIce.mockRejectedValueOnce(new Error('private-provider-secret'));
  await f.handler.handle(f.ws, f.data); await f.handler.handle(f.ws, f.data);
  expect(f.deps.getIce).toHaveBeenCalledTimes(1); expect(f.deps.send).not.toHaveBeenCalled();
  expect(JSON.stringify(f.deps.diagnostic.mock.calls)).not.toMatch(/secret|fresh-call-user/);
});
it('issues TURN to the selected callee device, including a locked limited-key runtime', async () => {
  const f = fixture();
  f.setInfo({ ...f.getInfo(), identityId: 'remote-a', deviceId: 'device-b' });
  const previous = f.deps.getRoute();
  f.deps.getRoute = () => ({ ...previous, acceptedTargetWs: f.ws });
  f.deps.getDevice.mockResolvedValue({ identity_id: 'remote-a', status: 'active' });
  await f.handler.handle(f.ws, { ...f.data, localIdentityId: 'remote-a', deviceId: 'device-b', remoteIdentityId: 'local-a' });
  expect(f.deps.send).toHaveBeenCalledTimes(1); expect(f.deps.reject).not.toHaveBeenCalled();
});
it('does not issue credentials to an expired session', async () => {
  const f = fixture();
  f.deps.getCall.mockResolvedValue({ ...f.call, state: 'expired' });
  await f.handler.handle(f.ws, f.data);
  expect(f.deps.getIce).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled();
});
