import type { WebSocket } from 'ws';
import type { CallSessionId, WebSocketMessage } from '@shared/types';
import type { ConnectionInfo } from './wsConnectionContext';
import type { CallSessionRoute } from '../services/callSessionRoutingRegistry';

type IceRequest = {
  requestId: string; callSessionId: string; vpsId: string; circleId: string;
  localIdentityId: string; deviceId: string; remoteIdentityId: string;
};
type Dependencies = {
  getInfo: (ws: WebSocket) => ConnectionInfo | undefined;
  getCircleId: (ws: WebSocket) => string | undefined;
  getVpsId: () => string;
  getRoute: (id: CallSessionId) => CallSessionRoute | undefined;
  getConfig: (family: string) => Promise<{ circle_id: string } | null>;
  getCall: (family: string, id: CallSessionId) => Promise<{
    state: string; participants: string[]; initiator: string; ended_at: Date | null; expires_at: Date | null;
  } | null>;
  getDevice: (family: string, id: string) => Promise<{ identity_id: string; status: string } | null>;
  getIdentity: (family: string, id: string) => Promise<{ status: string } | null>;
  getIce: (scope: { familyId: string; callSessionId: string }) => Promise<unknown[]>;
  send: (ws: WebSocket, message: WebSocketMessage) => void;
  reject: (ws: WebSocket, code: string, message: string) => void;
  diagnostic: (data: { operation: string; reason: string; missingFields?: string[] }) => void;
  now?: () => number;
};

/** Fresh TURN via the authenticated, delegated, one-call runtime. This path
 * never asks a locked phone for its broadly usable device signing seed. */
export class CallIceWsHandler {
  private readonly pending = new WeakSet<WebSocket>();
  private readonly lastIssued = new WeakMap<WebSocket, number>();
  constructor(private readonly deps: Dependencies) {}

  async handle(ws: WebSocket, input: unknown): Promise<void> {
    const now = this.deps.now || Date.now;
    const fields: (keyof IceRequest)[] = ['requestId', 'callSessionId', 'vpsId', 'circleId', 'localIdentityId', 'deviceId', 'remoteIdentityId'];
    const data = input as IceRequest | null;
    const missingFields = fields.filter(key => !data || typeof data[key] !== 'string' || !data[key].trim() || data[key].length > 256);
    const reject = (reason: string, missing?: string[]) => {
      this.deps.diagnostic({ operation: 'call.iceConfig', reason, ...(missing ? { missingFields: missing } : {}) });
      this.deps.reject(ws, 'FORBIDDEN', reason);
    };
    if (missingFields.length || !data) { reject('CALL_ROUTE_INCOMPLETE', missingFields); return; }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.requestId)) {
      reject('CALL_ICE_REQUEST_INVALID'); return;
    }
    const info = this.deps.getInfo(ws);
    const selected = () => {
      const current = this.deps.getInfo(ws);
      const route = this.deps.getRoute(data.callSessionId as CallSessionId);
      return current === info && info?.actorType === 'local' && info.runtimeMode === 'video-native'
        && !info.callRuntimePurpose && info.callsEnabled !== false && info.scopedCallSessionId === data.callSessionId
        && info.identityId === data.localIdentityId && info.deviceId === data.deviceId
        && this.deps.getCircleId(ws) === data.circleId && this.deps.getVpsId() === data.vpsId
        && route?.familyId === info.familyId
        && ((route.initiatorWs === ws && route.initiatorDeviceId === data.deviceId
          && route.initiatorIdentityId === data.localIdentityId && route.targetIdentityId === data.remoteIdentityId)
          || (route.acceptedTargetWs === ws && route.acceptedTargetDeviceId === data.deviceId
          && route.targetIdentityId === data.localIdentityId && route.initiatorIdentityId === data.remoteIdentityId));
    };
    if (!selected() || !info) { reject('CALL_ICE_ROUTE_MISMATCH'); return; }
    if (this.pending.has(ws) || now() - (this.lastIssued.get(ws) ?? -Infinity) < 5000) {
      reject('CALL_ICE_RATE_LIMITED'); return;
    }
    this.pending.add(ws); this.lastIssued.set(ws, now());
    const valid = async () => {
      const [config, call, device, identity] = await Promise.all([
        this.deps.getConfig(info.familyId), this.deps.getCall(info.familyId, data.callSessionId as CallSessionId),
        this.deps.getDevice(info.familyId, data.deviceId), this.deps.getIdentity(info.familyId, data.localIdentityId)
      ]);
      return selected() && config?.circle_id === data.circleId && device?.identity_id === data.localIdentityId
        && device.status === 'active' && identity?.status === 'active' && call && !call.ended_at
        && (!call.expires_at || call.expires_at.getTime() > now()) && ['new', 'ringing', 'accepted', 'active'].includes(call.state)
        && call.participants.length === 2 && new Set(call.participants).size === 2
        && call.participants.includes(data.localIdentityId) && call.participants.includes(data.remoteIdentityId)
        && call.initiator === this.deps.getRoute(data.callSessionId as CallSessionId)?.initiatorIdentityId;
    };
    try {
      if (!await valid()) { reject('CALL_ICE_AUTHORITY_INVALID'); return; }
      const iceServers = await this.deps.getIce({ familyId: info.familyId, callSessionId: data.callSessionId });
      // End, revocation, migration or socket replacement may happen during TURN I/O.
      if (!await valid()) { reject('CALL_ICE_AUTHORITY_CHANGED'); return; }
      this.deps.send(ws, { type: 'call:ice-configured', data: { ...Object.fromEntries(fields.map(key => [key, data[key]])), iceServers }, timestamp: now() });
    } catch {
      reject('CALL_ICE_CONFIG_UNAVAILABLE');
    } finally { this.pending.delete(ws); }
  }
}
