import { iceServersService } from './iceServersService';
import { circleMediaRoutingService } from './circleMediaRoutingService';

// Caller already validated the bootstrap token, participant and exact device
// against this Circle. TURN is issued for that call, never for a default Circle.
export async function getMobileCallIceServers(scope: { familyId: string; callSessionId: string }) {
  if (!scope.familyId || !scope.callSessionId) throw new Error('CALL_ICE_SCOPE_REQUIRED');
  const { familyId, callSessionId } = scope;
  const requestedTurnClusterId = await circleMediaRoutingService.getRequestedTurnClusterId(familyId);
  const configured = await iceServersService.getIceServers({ familyId, requestedTurnClusterId });
  const fresh = await iceServersService.getTurnServerConfig({ familyId, callSessionId, requestedTurnClusterId });
  const servers = configured.filter(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return !urls.some(url => /^turns?:/.test(url));
  });
  if (fresh) servers.push(fresh);
  return servers;
}
