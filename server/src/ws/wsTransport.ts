import WebSocket from 'ws';
import type { WebSocketMessage } from '@shared/types';

export type HttpRuntimeMessageQueue = {
  queue: WebSocketMessage[];
  enqueue?: (message: WebSocketMessage) => void;
};

export type WsTransport = {
  send: (ws: WebSocket, message: WebSocketMessage) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
  sendToSet: (sockets: Set<WebSocket> | undefined, message: WebSocketMessage) => void;
};

export function createWsTransport(params: {
  findHttpRuntimeQueue: (ws: WebSocket) => HttpRuntimeMessageQueue | null;
  maxHttpRuntimeQueue: number;
  canSend?: (ws: WebSocket, message: WebSocketMessage) => boolean;
  now?: () => number;
}): WsTransport {
  const now = params.now || Date.now;
  const send = (ws: WebSocket, message: WebSocketMessage): void => {
    if (params.canSend && !params.canSend(ws, message)) return;
    const httpRuntime = params.findHttpRuntimeQueue(ws);
    if (httpRuntime) {
      if (httpRuntime.enqueue) { httpRuntime.enqueue(message); return; }
      httpRuntime.queue.push(message);
      if (httpRuntime.queue.length > params.maxHttpRuntimeQueue) {
        httpRuntime.queue.splice(0, httpRuntime.queue.length - params.maxHttpRuntimeQueue);
      }
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  return {
    send,
    sendError(ws, code, message) {
      send(ws, {
        type: 'error',
        data: { code, message },
        timestamp: now()
      });
    },
    sendToSet(sockets, message) {
      for (const socket of sockets || []) send(socket, message);
    }
  };
}
