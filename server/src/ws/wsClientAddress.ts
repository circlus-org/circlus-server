import type { IncomingMessage } from 'node:http';
import type { Express, Request } from 'express';

/** Evaluate Express's actual req.ip getter with the application's trust-proxy policy. */
export function wsClientAddress(app: Express, request: IncomingMessage): string {
  const context = Object.create(request) as Request;
  context.app = app;
  return Reflect.get(app.request, 'ip', context) || request.socket.remoteAddress || 'unknown';
}
