jest.mock('../db/repositories', () => ({
  messageRepository: {
    getSyncState: jest.fn(),
    fetchMessagesForSync: jest.fn(),
    fetchStatusUpdatesForSync: jest.fn(),
    fetchReadCursors: jest.fn(),
    updateSyncState: jest.fn()
  }
}));

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../services/configService', () => ({
  configService: { getNoNamesOnServer: jest.fn() }
}));
jest.mock('../services/directMessages', () => {
  class DirectMessageServiceError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    DirectMessageServiceError,
    sendDirectMessage: jest.fn(),
    updateDirectMessageStatus: jest.fn(),
    editDirectMessage: jest.fn(),
    deleteDirectMessage: jest.fn(),
    markDirectMessagesRead: jest.fn()
  };
});

import type { WebSocket } from 'ws';
import type { AuthenticatedActor } from '../services/authenticatedActor';
import { DirectMessageServiceError, sendDirectMessage } from '../services/directMessages';
import { DirectMessageWsHandlers, type DirectMessageWsHandlerDependencies } from './directMessageWsHandlers';

const ws = {} as WebSocket;
const actor: AuthenticatedActor = {
  familyId: 'family-1',
  identityId: 'identity-1',
  deviceId: 'device-1',
  accessLevel: 'trusted'
};

function harness(overrides: Partial<DirectMessageWsHandlerDependencies> = {}) {
  const logger = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn()
  };
  const dependencies: DirectMessageWsHandlerDependencies = {
    requireActor: jest.fn(() => actor),
    requireTemporaryChatAccess: jest.fn(async () => true),
    rejectTemporaryDirectMessages: jest.fn(() => false),
    sendMessage: jest.fn(),
    sendError: jest.fn(),
    maxSyncBatch: 100,
    logger: logger as any,
    now: () => 123,
    ...overrides
  };
  return { dependencies, logger, handlers: new DirectMessageWsHandlers(dependencies) };
}

describe('direct message WebSocket handlers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates message creation and preserves the existing ack envelope', async () => {
    (sendDirectMessage as jest.Mock).mockResolvedValue({ ack: { serverMessageId: 'message-1' } });
    const { handlers, dependencies } = harness();

    await handlers.handleSend(ws, {
      deviceId: 'device-1',
      signature: 'signature',
      payload: {
        recipientIdentityId: 'identity-2',
        ciphertext: 'ciphertext',
        clientMessageId: 'client-message-1'
      }
    } as any);

    expect(sendDirectMessage).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family-1',
      senderIdentityId: 'identity-1',
      recipientIdentityId: 'identity-2',
      clientMessageId: 'client-message-1'
    }));
    expect(dependencies.sendMessage).toHaveBeenCalledWith(ws, {
      type: 'message:ack',
      data: { serverMessageId: 'message-1' },
      timestamp: 123
    });
  });

  it('stops before the service when temporary chat access is denied', async () => {
    const { handlers } = harness({ requireTemporaryChatAccess: async () => false });
    await handlers.handleSend(ws, {
      deviceId: 'device-1',
      payload: { recipientIdentityId: 'identity-2' }
    } as any);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  it('preserves typed service errors on the wire', async () => {
    (sendDirectMessage as jest.Mock).mockRejectedValue(
      new DirectMessageServiceError(403, 'FORBIDDEN' as any, 'Message denied')
    );
    const { handlers, dependencies } = harness();
    await handlers.handleSend(ws, {
      deviceId: 'device-1',
      payload: { recipientIdentityId: 'identity-2' }
    } as any);
    expect(dependencies.sendError).toHaveBeenCalledWith(ws, 'FORBIDDEN', 'Message denied');
  });

  it('logs unexpected service errors with actor and operation context', async () => {
    const failure = new Error('database unavailable');
    (sendDirectMessage as jest.Mock).mockRejectedValue(failure);
    const { handlers, dependencies, logger } = harness();

    await handlers.handleSend(ws, {
      deviceId: 'device-1',
      payload: { recipientIdentityId: 'identity-2' }
    } as any);

    expect(logger.error).toHaveBeenCalledWith(
      'direct_message_ws_operation_failed',
      {
        familyId: 'family-1',
        identityId: 'identity-1',
        deviceId: 'device-1',
        operation: 'send',
        error: failure
      }
    );
    expect(dependencies.sendError).toHaveBeenCalledWith(
      ws,
      'INTERNAL_ERROR',
      'Failed to send message'
    );
  });
});
