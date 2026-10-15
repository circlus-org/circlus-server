jest.mock('../utils/routeLogger', () => ({ routeLogger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../db/repositories', () => ({ callSessionRepository: { findByCallSessionId: jest.fn() }, identityRepository: { findByIdentityId: jest.fn() }, deviceRepository: { findByDeviceId: jest.fn() } }));
jest.mock('../db/repositories/mobileNotificationRepository', () => ({ mobileNotificationRepository: {}, normalizeNativeMessagePreviewMode: jest.fn() }));
jest.mock('../middleware/auth', () => ({ verifySignature: (_req: any, _res: any, next: any) => next(), requireActiveIdentity: (_req: any, _res: any, next: any) => next() }));
jest.mock('../services/reliableOperation', () => ({ reliableOperation: (handler: any) => handler }));
jest.mock('../services/compatiblePushRegistration', () => ({ compatiblePushRegistration: (handler: any) => handler }));
jest.mock('../middleware/security', () => ({ isTrustedClientRequestOrigin: jest.fn() }));
jest.mock('../ws/wsGateway', () => ({}));
jest.mock('../middleware/tenancy', () => ({ getRequestedCircleId: (req: any) => req.circleId }));
jest.mock('../utils/mobileCallBootstrapToken', () => ({ verifyMobileCallBootstrapToken: jest.fn() }));
jest.mock('../services/configService', () => ({ configService: { getFamilyConfig: jest.fn() } }));
jest.mock('../config/serverRuntimeConfig', () => ({ getServerIdentityRuntimeConfig: () => ({ vpsId: 'vps' }) }));
jest.mock('../services/mobileCallIce', () => ({ getMobileCallIceServers: jest.fn() }));
import { callSessionRepository, identityRepository, deviceRepository } from '../db/repositories';
import { verifyMobileCallBootstrapToken } from '../utils/mobileCallBootstrapToken';
import { configService } from '../services/configService';
import { getMobileCallIceServers } from '../services/mobileCallIce';
const router = require('./mobile').default;
const handler = router.stack.find((layer: any) => layer.route?.path === '/calls/bootstrap').route.stack[0].handle;
function response() { const res: any = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res); return res; }
function request(familyId = 'family-a', circleId = 'circle-a') { return { familyId, circleId, body: { callSessionId: 'call-a', bootstrapToken: 'opaque', deviceId: 'device-a', remoteIdentityId: 'caller' } }; }
const session = { state: 'ringing', participants: ['caller', 'callee'], initiator: 'caller', sdp_offer: JSON.stringify({ type: 'offer', sdp: 'test', __externalCaller: { displayName: 'Private metadata' } }) };
describe('mobile incoming bootstrap v2 media contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (verifyMobileCallBootstrapToken as jest.Mock).mockReturnValue({ familyId: 'family-a', callSessionId: 'call-a', targetIdentityId: 'callee' });
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(session);
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ status: 'active', public_key_algorithm: 'ed25519', public_key_value: 'public' });
    (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue({ device_id: 'device-a', identity_id: 'callee', status: 'active' });
    (configService.getFamilyConfig as jest.Mock).mockResolvedValue({ circle_id: 'circle-a', public_base_url: 'https://same.example' });
    (getMobileCallIceServers as jest.Mock).mockResolvedValue([{ urls: ['turns:relay.example'], username: 'fresh', credential: 'secret' }]);
  });
  it('returns fresh call ICE only after token, participant and exact device authorization', async () => {
    const res = response(); await handler(request(), res);
    expect(getMobileCallIceServers).toHaveBeenCalledWith({ familyId: 'family-a', callSessionId: 'call-a' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, callRuntimeProtocolVersion: 2, circleId: 'circle-a', vpsId: 'vps', deviceId: 'device-a', remoteIdentityId: 'caller',
      signalingUrl: 'wss://same.example/ws?circleId=circle-a&vpsId=vps', offer: { type: 'offer', sdp: 'test' }, iceServers: expect.any(Array) }));
  });
  it('does not confuse two Circles sharing one origin', async () => {
    const res = response(); await handler(request('family-b', 'circle-b'), res);
    expect(res.status).toHaveBeenCalledWith(403); expect(getMobileCallIceServers).not.toHaveBeenCalled();
  });
  it.each(['missing-device', 'wrong-device', 'wrong-remote', 'ambiguous-participants', 'missing-initiator', 'wrong-circle', 'ended', 'invalid-token'])('rejects %s before issuing TURN', async mode => {
    const req = request();
    if (mode === 'missing-device') req.body.deviceId = '';
    if (mode === 'wrong-device') (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue({ device_id: 'device-a', identity_id: 'other', status: 'active' });
    if (mode === 'wrong-remote') req.body.remoteIdentityId = 'other';
    if (mode === 'ambiguous-participants') (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({ ...session, participants: ['caller', 'callee', 'extra'] });
    if (mode === 'missing-initiator') (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({ ...session, initiator: '' });
    if (mode === 'wrong-circle') (configService.getFamilyConfig as jest.Mock).mockResolvedValue({ circle_id: 'circle-b', public_base_url: 'https://same.example' });
    if (mode === 'ended') (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({ ...session, state: 'ended' });
    if (mode === 'invalid-token') (verifyMobileCallBootstrapToken as jest.Mock).mockReturnValue(null);
    const res = response(); await handler(req, res);
    expect(res.status).toHaveBeenCalled(); expect(getMobileCallIceServers).not.toHaveBeenCalled();
  });
  it('returns a safe 503 on ICE failure without leaking provider credentials', async () => {
    (getMobileCallIceServers as jest.Mock).mockRejectedValueOnce(new Error('private service URL and credential'));
    const res = response(); await handler(request(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Call media configuration is unavailable' });
  });
});
