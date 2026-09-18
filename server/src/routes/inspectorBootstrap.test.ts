process.env.VPS_ID = 'vps-test';

jest.mock('../db', () => ({
  query: jest.fn()
}));

jest.mock('../db/repositories/circleInspectorRepository', () => ({
  circleInspectorRepository: {
    createUnboundRequest: jest.fn(),
    findRequestById: jest.fn(),
    findSessionForRequestId: jest.fn(),
    consumeSessionTokenHandoff: jest.fn()
  }
}));

import { query } from '../db';
import { circleInspectorRepository } from '../db/repositories/circleInspectorRepository';
import { tokenHash } from './inspectorSupport';

const inspectorBootstrapRouter = require('./inspectorBootstrap').default;

type MockResponse = {
  status: jest.Mock;
  json: jest.Mock;
};

function getHandler(path: string) {
  const layer = (inspectorBootstrapRouter as any).stack
    .find((item: any) => item.route?.path === path && item.route?.methods?.get);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function makeResponse(): MockResponse {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

const REQUEST_TOKEN = 'circt_pickup_key';

function approvedRequest() {
  return {
    request_id: 'cir_request',
    family_id: 'family-1',
    request_token_hash: tokenHash(REQUEST_TOKEN),
    viewer_label: 'Laptop',
    status: 'approved',
    approved_by_identity_id: 'owner-1',
    approved_by_device_id: 'device-1',
    created_at: 100,
    expires_at: Date.now() + 60_000,
    approved_at: 200
  };
}

describe('Inspector bootstrap request polling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (circleInspectorRepository.findRequestById as jest.Mock).mockResolvedValue(approvedRequest());
    (circleInspectorRepository.findSessionForRequestId as jest.Mock).mockResolvedValue({
      session_id: 'cis_session',
      expires_at: Date.now() + 3_600_000
    });
    (circleInspectorRepository.consumeSessionTokenHandoff as jest.Mock).mockResolvedValue('cis_session_token');
    (query as jest.Mock).mockResolvedValue({
      rows: [{ circle_id: 'circle_1', server_name: 'Home', server_url: 'https://circle.example' }]
    });
  });

  it('delivers a session token that differs from the request token', async () => {
    const res = makeResponse();
    await getHandler('/requests/:requestId')({
      params: { requestId: 'cir_request' },
      headers: { 'x-inspector-request-token': REQUEST_TOKEN, 'x-inspector-session-pickup': '1' },
      query: {}
    }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('ok');
    expect(body.result.sessionToken).toBe('cis_session_token');
    expect(body.result.sessionToken).not.toBe(REQUEST_TOKEN);
    expect(body.result.sessionTokenClaimed).toBe(false);
  });

  it('rejects a request token supplied as a query parameter', async () => {
    const res = makeResponse();
    await getHandler('/requests/:requestId')({
      params: { requestId: 'cir_request' },
      headers: {},
      query: { requestToken: REQUEST_TOKEN }
    }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(circleInspectorRepository.consumeSessionTokenHandoff).not.toHaveBeenCalled();
  });

  it('leaves the token waiting when the approving owner reads the request', async () => {
    const res = makeResponse();
    await getHandler('/requests/:requestId')({
      params: { requestId: 'cir_request' },
      headers: { 'x-inspector-request-token': REQUEST_TOKEN },
      query: {}
    }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('ok');
    expect(body.result.sessionToken).toBeNull();
    expect(body.result.sessionTokenClaimed).toBe(false);
    expect(circleInspectorRepository.consumeSessionTokenHandoff).not.toHaveBeenCalled();
  });

  it('reports an already collected approval instead of repeating the token', async () => {
    (circleInspectorRepository.consumeSessionTokenHandoff as jest.Mock).mockResolvedValue(null);
    const res = makeResponse();

    await getHandler('/requests/:requestId')({
      params: { requestId: 'cir_request' },
      headers: { 'x-inspector-request-token': REQUEST_TOKEN, 'x-inspector-session-pickup': '1' },
      query: {}
    }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.result.sessionToken).toBeNull();
    expect(body.result.sessionTokenClaimed).toBe(true);
  });

  it('uses the Circle config URL when no active domain exists', async () => {
    const res = makeResponse();
    await getHandler('/requests/:requestId')({
      params: { requestId: 'cir_request' },
      headers: { 'x-inspector-request-token': REQUEST_TOKEN, 'x-inspector-session-pickup': '1' }
    }, res);

    const sql = (query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain('fc.public_base_url) AS server_url');
    expect(res.json.mock.calls[0][0].result.sessionToken).toBe('cis_session_token');
  });

  it('does not consume the session token when Circle context lookup fails', async () => {
    (query as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
    const res = makeResponse();
    await getHandler('/requests/:requestId')({
      params: { requestId: 'cir_request' },
      headers: { 'x-inspector-request-token': REQUEST_TOKEN, 'x-inspector-session-pickup': '1' }
    }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(circleInspectorRepository.consumeSessionTokenHandoff).not.toHaveBeenCalled();
  });
});
