import type { RequestHandler } from 'express';

jest.mock('../db', () => ({
  transaction: jest.fn(async (callback: any) => callback({ query: jest.fn(async () => ({ rows: [] })) })),
  inTransactionContext: jest.fn(async (_client: unknown, callback: any) => callback())
}));
jest.mock('../services/authenticatedActor', () => ({
  authenticatedActorFromHttpRequest: jest.fn(() => ({ familyId: 'f', identityId: 'callee', deviceId: 'd' }))
}));
jest.mock('../services/callLifecycleService', () => ({
  CallLifecycleServiceError: class extends Error {},
  finalizeCallForActor: jest.fn(),
  markCallConnectedForActor: jest.fn(),
  recordCallHandlingEventForActor: jest.fn()
}));
jest.mock('../services/callHistoryService', () => ({
  CallHistoryServiceError: class extends Error {},
  ackCallHistorySyncForActor: jest.fn(),
  listCallHistoryForActor: jest.fn(),
  markMissedCallsSeenForActor: jest.fn()
}));
jest.mock('../ws/wsGateway', () => ({
  sendCallDeliveryStatusWs: jest.fn(),
  sendToIdentityWs: jest.fn(),
  declineCallViaMobileAction: jest.fn(async () => ({ status: 'declined' }))
}));

import router from './calls';
import { declineCallViaMobileAction, sendCallDeliveryStatusWs } from '../ws/wsGateway';
import { transaction } from '../db';
import { recordCallHandlingEventForActor } from '../services/callLifecycleService';
import { verifySignature, requireActiveIdentity } from '../middleware/auth';

const route = (router as any).stack.find((layer: any) => layer.route?.path === '/handling-event').route;
const handle: RequestHandler = route.stack.at(-1).handle;
const payload = { callSessionId: 'call', eventType: 'busy', occurredAt: 123 };

async function invoke(fields: Record<string, unknown>) {
  const req: any = {
    familyId: 'f',
    params: {},
    signedRequest: { type: 'call:handling-event', signerId: 'd', payload, ...fields }
  };
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; }
  };
  await handle(req, res, (error) => { throw error; });
  return res;
}

describe('reliable call handling events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(recordCallHandlingEventForActor).mockResolvedValue(null);
  });

  test('keeps signature and active-identity middleware before reliable operation handling', () => {
    expect(route.stack[0].handle).toBe(verifySignature);
    expect(route.stack[1].handle).toBe(requireActiveIdentity);
  });

  test.each([undefined, null, '', 123, 'invalid'])(
    'rejects a missing or invalid operationId %p',
    async (operationId) => {
      const fields = operationId === undefined ? {} : { operationId };
      const response = await invoke(fields);
      expect(response.statusCode).toBe(400);
      expect(recordCallHandlingEventForActor).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    }
  );

  test('handles a valid operation through the transactional reliability layer', async () => {
    const operationId = Date.now().toString(16).padStart(16, '0') + '-' + 'a'.repeat(64);
    expect((await invoke({ operationId })).statusCode).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(recordCallHandlingEventForActor).toHaveBeenCalledTimes(1);
  });

  test.each(['incoming_ui', 'notification_action', 'locally_declined'])(
    'finishes a reported decline from %s even without a separate decline command',
    async (reason) => {
      jest.mocked(recordCallHandlingEventForActor).mockResolvedValue({
        callerIdentityId: 'caller', callSessionId: 'call', status: 'declined',
        reason, occurredAt: 123, shouldEndCall: false
      });
      const operationId = Date.now().toString(16).padStart(16, '0') + '-' + 'b'.repeat(64);
      expect((await invoke({ operationId })).statusCode).toBe(200);
      expect(declineCallViaMobileAction).toHaveBeenCalledWith({
        familyId: 'f', callSessionId: 'call', targetIdentityId: 'callee'
      });
      expect(sendCallDeliveryStatusWs).toHaveBeenCalledWith(expect.objectContaining({ status: 'declined' }));
    }
  );

  test.each(['ringing', 'answered', 'busy', 'failed'] as const)(
    'does not turn a %s report into a decline',
    async (status) => {
      jest.mocked(recordCallHandlingEventForActor).mockResolvedValue({
        callerIdentityId: 'caller', callSessionId: 'call', status, occurredAt: 123
      });
      const operationId = Date.now().toString(16).padStart(16, '0') + '-' + 'c'.repeat(64);
      expect((await invoke({ operationId })).statusCode).toBe(200);
      expect(declineCallViaMobileAction).not.toHaveBeenCalled();
    }
  );

});
