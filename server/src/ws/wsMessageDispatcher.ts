export type WsDispatchMessage = {
  type: string;
  data: unknown;
  timestamp?: number;
};

export type WsMessageHandler<TSocket> = (
  socket: TSocket,
  data: unknown,
  message: WsDispatchMessage
) => void | Promise<void>;

export type WsMessageHandlerMap<TSocket> = Readonly<Record<string, WsMessageHandler<TSocket>>>;

export function createWsMessageDispatcher<TSocket>(handlers: WsMessageHandlerMap<TSocket>) {
  const registeredHandlers = new Map(Object.entries(handlers));
  return async (socket: TSocket, message: WsDispatchMessage): Promise<boolean> => {
    const handler = registeredHandlers.get(message.type);
    if (!handler) return false;
    await handler(socket, message.data, message);
    return true;
  };
}
