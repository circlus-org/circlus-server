import { createWsMessageDispatcher } from './wsMessageDispatcher';

describe('WebSocket message dispatcher', () => {
  it('routes the complete message to the handler registered for its exact type', async () => {
    const handler = jest.fn(async () => undefined);
    const dispatch = createWsMessageDispatcher<{ id: string }>({ 'call:offer': handler });
    const socket = { id: 'socket-1' };
    const message = { type: 'call:offer', data: { offer: 'sdp' }, timestamp: 123 };

    await expect(dispatch(socket, message)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith(socket, message.data, message);
  });

  it('returns false without invoking another handler for an unknown type', async () => {
    const handler = jest.fn();
    const dispatch = createWsMessageDispatcher({ ping: handler });

    await expect(dispatch({}, { type: 'unknown', data: null })).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('awaits asynchronous handlers and preserves their errors for the outer boundary', async () => {
    const error = new Error('handler failed');
    const dispatch = createWsMessageDispatcher({
      ping: async () => { throw error; }
    });

    await expect(dispatch({}, { type: 'ping', data: null })).rejects.toBe(error);
  });
});
