import type { WebSocket } from 'ws';
import { getRequestLogger } from '../middleware/requestContext';
import type { CallSessionId, DeviceId, IdentityId } from '@shared/types';

export type CallSessionRoute = Readonly<{
  familyId: string;
  initiatorIdentityId: IdentityId;
  initiatorWs?: WebSocket;
  initiatorDeviceId?: DeviceId;
  targetIdentityId: IdentityId;
  acceptedTargetWs?: WebSocket;
  acceptedTargetDeviceId?: DeviceId;
}>;

type MutableCallSessionRoute = {
  -readonly [Key in keyof CallSessionRoute]: CallSessionRoute[Key];
};

export type RouteBindingResult = {
  status: 'bound' | 'already_bound' | 'not_found' | 'identity_mismatch';
  route?: CallSessionRoute;
};

export type DetachedCallRoute = {
  callSessionId: CallSessionId;
  role: 'initiator' | 'accepted_target';
  route: CallSessionRoute;
};

function snapshot(route: MutableCallSessionRoute): CallSessionRoute {
  return { ...route };
}

export class CallSessionRoutingRegistry {
  hasIdentity(familyId: string, identityId: string): boolean {
    return [...this.routes.values()].some(route => route.familyId === familyId && (route.initiatorIdentityId === identityId || route.targetIdentityId === identityId));
  }

  hasSocket(ws: WebSocket): boolean {
    return [...this.routes.values()].some(route => route.initiatorWs === ws || route.acceptedTargetWs === ws);
  }

  private readonly routes = new Map<CallSessionId, MutableCallSessionRoute>();

  /** A durable route has authority but no fabricated live sockets. */
  restore(callSessionId: CallSessionId, route: Omit<CallSessionRoute, 'initiatorWs' | 'acceptedTargetWs'>): CallSessionRoute {
    const previous = this.routes.get(callSessionId);
    if (!route.familyId || !route.initiatorIdentityId || !route.initiatorDeviceId || !route.targetIdentityId
        || route.initiatorIdentityId === route.targetIdentityId
        || (previous && (previous.familyId !== route.familyId || previous.initiatorIdentityId !== route.initiatorIdentityId
          || previous.initiatorDeviceId !== route.initiatorDeviceId || previous.targetIdentityId !== route.targetIdentityId
          || previous.acceptedTargetDeviceId !== route.acceptedTargetDeviceId))) {
      getRequestLogger({ subsystem: 'call-routing' }).warn('call_route_rejected', { operation: 'call.routeRestore', reason: 'CALL_DURABLE_ROUTE_CONFLICT',
        candidateCount: previous ? 1 : 0, missingFields: ['familyId', 'initiatorIdentityId', 'initiatorDeviceId', 'targetIdentityId'].filter(field => !(route as any)[field]) });
      throw new Error('CALL_DURABLE_ROUTE_CONFLICT');
    }
    if (previous) return snapshot(previous);
    this.routes.set(callSessionId, { ...route }); return { ...route };
  }

  registerInitiator(params: {
    callSessionId: CallSessionId;
    familyId: string;
    initiatorIdentityId: IdentityId;
    initiatorWs: WebSocket;
    initiatorDeviceId?: DeviceId;
    targetIdentityId: IdentityId;
  }): CallSessionRoute {
    const previous = this.routes.get(params.callSessionId);
    if (previous && (previous.familyId !== params.familyId || previous.initiatorIdentityId !== params.initiatorIdentityId
      || previous.targetIdentityId !== params.targetIdentityId || previous.initiatorDeviceId !== params.initiatorDeviceId)) {
      getRequestLogger({ subsystem: 'call-routing' }).warn('call_route_rejected', { operation: 'call.routeRegister', reason: 'CALL_ROUTE_AUTHORITY_MISMATCH', candidateCount: 1 });
      throw new Error('CALL_ROUTE_AUTHORITY_MISMATCH');
    }
    const route: MutableCallSessionRoute = {
      ...previous,
      familyId: params.familyId,
      initiatorIdentityId: params.initiatorIdentityId,
      initiatorWs: params.initiatorWs,
      initiatorDeviceId: params.initiatorDeviceId,
      targetIdentityId: params.targetIdentityId
    };
    this.routes.set(params.callSessionId, route);
    return snapshot(route);
  }

  get(callSessionId: CallSessionId): CallSessionRoute | undefined {
    const route = this.routes.get(callSessionId);
    return route ? snapshot(route) : undefined;
  }

  routesForSocket(ws: WebSocket): DetachedCallRoute[] {
    return [...this.routes.entries()].flatMap(([callSessionId, route]) => {
      const role = route.initiatorWs === ws ? 'initiator'
        : route.acceptedTargetWs === ws ? 'accepted_target' : null;
      return role ? [{ callSessionId, role, route: snapshot(route) } as DetachedCallRoute] : [];
    });
  }

  bindInitiatorRuntime(params: {
    callSessionId: CallSessionId;
    identityId: IdentityId;
    ws: WebSocket;
    deviceId?: DeviceId;
  }): RouteBindingResult {
    const route = this.routes.get(params.callSessionId);
    if (!route) return { status: 'not_found' };
    if (route.initiatorIdentityId !== params.identityId) {
      return { status: 'identity_mismatch', route: snapshot(route) };
    }
    route.initiatorWs = params.ws;
    route.initiatorDeviceId = params.deviceId;
    return { status: 'bound', route: snapshot(route) };
  }

  bindTargetRuntime(params: {
    callSessionId: CallSessionId;
    identityId: IdentityId;
    ws: WebSocket;
    deviceId?: DeviceId;
  }): RouteBindingResult {
    const route = this.routes.get(params.callSessionId);
    if (!route) return { status: 'not_found' };
    if (route.targetIdentityId !== params.identityId) {
      return { status: 'identity_mismatch', route: snapshot(route) };
    }
    route.acceptedTargetWs = params.ws;
    route.acceptedTargetDeviceId = params.deviceId;
    return { status: 'bound', route: snapshot(route) };
  }

  bindAcceptedTargetIfAbsent(params: {
    callSessionId: CallSessionId;
    identityId: IdentityId;
    ws: WebSocket;
    deviceId?: DeviceId;
  }): RouteBindingResult {
    const route = this.routes.get(params.callSessionId);
    if (!route) return { status: 'not_found' };
    if (route.targetIdentityId !== params.identityId) {
      return { status: 'identity_mismatch', route: snapshot(route) };
    }
    if (route.acceptedTargetWs || (route.acceptedTargetDeviceId && route.acceptedTargetDeviceId !== params.deviceId)) {
      return { status: 'already_bound', route: snapshot(route) };
    }
    route.acceptedTargetWs = params.ws;
    route.acceptedTargetDeviceId = params.deviceId;
    return { status: 'bound', route: snapshot(route) };
  }

  resolvePeerSocket(
    callSessionId: CallSessionId,
    senderIdentityId: IdentityId
  ): WebSocket | undefined {
    const route = this.routes.get(callSessionId);
    if (!route) return undefined;
    if (senderIdentityId === route.targetIdentityId) return route.initiatorWs;
    if (senderIdentityId === route.initiatorIdentityId) return route.acceptedTargetWs;
    return undefined;
  }

  remove(callSessionId: CallSessionId): CallSessionRoute | undefined {
    const route = this.routes.get(callSessionId);
    if (!route) return undefined;
    this.routes.delete(callSessionId);
    return snapshot(route);
  }

  detachSocket(ws: WebSocket): DetachedCallRoute[] {
    const detached: DetachedCallRoute[] = [];
    for (const [callSessionId, route] of this.routes.entries()) {
      if (route.initiatorWs === ws) {
        this.routes.delete(callSessionId);
        detached.push({
          callSessionId,
          role: 'initiator',
          route: snapshot(route)
        });
        continue;
      }
      if (route.acceptedTargetWs === ws) {
        const previousRoute = snapshot(route);
        delete route.acceptedTargetWs;
        detached.push({
          callSessionId,
          role: 'accepted_target',
          route: previousRoute
        });
      }
    }
    return detached;
  }
}
