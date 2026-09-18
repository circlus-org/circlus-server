import { getRequestedCircleId, getRequestHost } from './tenancy';

describe('getRequestHost', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('reads host from express-style req.get()', () => {
    const req = {
      get(name: string) {
        if (name.toLowerCase() === 'host') return 'Example.com:443';
        return undefined;
      },
      hostname: 'ignored.example'
    };

    expect(getRequestHost(req)).toBe('example.com');
  });

  test('reads host from websocket upgrade headers', () => {
    const req = {
      headers: {
        host: 'Ru-Test.Example.com'
      }
    };

    expect(getRequestHost(req)).toBe('ru-test.example.com');
  });

  test('prefers forwarded host when explicitly trusted', () => {
    process.env.TENANCY_TRUST_FORWARDED_HOST = 'true';

    const req = {
      headers: {
        host: 'internal.proxy.local',
        'x-forwarded-host': 'Public.Example.com, proxy.local'
      }
    };

    expect(getRequestHost(req)).toBe('public.example.com');
  });
});

describe('getRequestedCircleId', () => {
  test('reads the HTTP tenant selector header', () => {
    expect(getRequestedCircleId({
      headers: { 'x-circlus-circle-id': ' circle_alpha ' }
    })).toBe('circle_alpha');
  });

  test('reads the WebSocket tenant selector query parameter', () => {
    expect(getRequestedCircleId({
      headers: {},
      url: '/ws?circleId=circle_beta'
    })).toBe('circle_beta');
  });

  test('prefers the signed HTTP header over a query parameter', () => {
    expect(getRequestedCircleId({
      headers: { 'x-circlus-circle-id': 'circle_header' },
      url: '/api/config?circleId=circle_query'
    })).toBe('circle_header');
  });
});
