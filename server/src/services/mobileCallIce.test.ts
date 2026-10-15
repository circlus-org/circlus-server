jest.mock('./iceServersService', () => ({ iceServersService: { getIceServers: jest.fn(), getTurnServerConfig: jest.fn() } }));
jest.mock('./circleMediaRoutingService', () => ({ circleMediaRoutingService: { getRequestedTurnClusterId: jest.fn() } }));
import { iceServersService } from './iceServersService';
import { circleMediaRoutingService } from './circleMediaRoutingService';
import { getMobileCallIceServers } from './mobileCallIce';

describe('mobile bootstrap call ICE scope', () => {
  beforeEach(() => jest.clearAllMocks());
  it('uses exact family/call for two Circles on one host and replaces bootstrap TURN credentials', async () => {
    (circleMediaRoutingService.getRequestedTurnClusterId as jest.Mock).mockImplementation(async family => 'turn-' + family);
    (iceServersService.getIceServers as jest.Mock).mockResolvedValue([
      { urls: ['stun:relay.example'] }, { urls: ['turn:relay.example'], username: 'bootstrap', credential: 'old' }
    ]);
    (iceServersService.getTurnServerConfig as jest.Mock).mockImplementation(async scope => ({
      urls: ['turns:relay.example'], username: scope.familyId + ':' + scope.callSessionId, credential: 'fresh'
    }));
    for (const familyId of ['circle-a-family', 'circle-b-family']) {
      const result = await getMobileCallIceServers({ familyId, callSessionId: 'call-a' });
      expect(iceServersService.getTurnServerConfig).toHaveBeenLastCalledWith({ familyId, callSessionId: 'call-a', requestedTurnClusterId: 'turn-' + familyId });
      expect(result).toEqual([{ urls: ['stun:relay.example'] }, { urls: ['turns:relay.example'], username: familyId + ':call-a', credential: 'fresh' }]);
    }
  });
  it.each([{ familyId: '', callSessionId: 'call-a' }, { familyId: 'family-a', callSessionId: '' }])('stops missing scope before configuration access', async scope => {
    await expect(getMobileCallIceServers(scope)).rejects.toThrow('CALL_ICE_SCOPE_REQUIRED');
    expect(circleMediaRoutingService.getRequestedTurnClusterId).not.toHaveBeenCalled();
  });
  it('propagates media-service failure instead of substituting another route', async () => {
    (circleMediaRoutingService.getRequestedTurnClusterId as jest.Mock).mockRejectedValueOnce(new Error('unavailable'));
    await expect(getMobileCallIceServers({ familyId: 'family-a', callSessionId: 'call-a' })).rejects.toThrow('unavailable');
    expect(iceServersService.getTurnServerConfig).not.toHaveBeenCalled();
  });
});
