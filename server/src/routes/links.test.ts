import { query } from '../db';

jest.mock('../db', () => ({
  query: jest.fn()
}));

const linksRouter = require('./links').default;

type MockResponse = {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
};

function getResolveHandler() {
  const layer = (linksRouter as any).stack.find((item: any) => item.route?.path === '/resolve');
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function response(): MockResponse {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn()
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('compact link resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns and leaves device bootstrap verification to the web client', async () => {
    const bootstrap = {
      v: 2,
      server: 'https://circle.example',
      identityPublicKey: 'identity-key',
      enrollmentId: 'enr_1',
      sessionPublicKey: 'session-key',
      trustedDeviceId: 'device_1'
    };
    (query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    (query as jest.Mock).mockResolvedValueOnce({ rows: [{ bootstrap_payload: bootstrap }] });
    const res = response();

    await getResolveHandler()({
      familyId: 'family_1',
      body: { secret: 'bootstrap-commitment' }
    }, res);

    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      result: {
        type: 'device-enrollment',
        payload: bootstrap
      }
    });
  });

  test('uses one generic not-found response', async () => {
    (query as jest.Mock).mockResolvedValue({ rows: [] });
    const res = response();

    await getResolveHandler()({
      familyId: 'family_1',
      body: { secret: 'unknown-secret' }
    }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      error: {
        code: 'NOT_FOUND',
        message: 'Link not found or expired'
      }
    });
  });
});
