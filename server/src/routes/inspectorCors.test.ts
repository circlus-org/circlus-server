import express from 'express';
import cors from 'cors';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../services/configService', () => ({
  configService: { getFamilyConfig: jest.fn() }
}));
jest.mock('../db/repositories/circleInspectorRepository', () => ({
  circleInspectorRepository: {
    createUnboundRequest: jest.fn(),
    findRequestById: jest.fn(),
    findActiveSessionByTokenHash: jest.fn(),
    touchSession: jest.fn()
  }
}));

import { configService } from '../services/configService';
import { circleInspectorRepository } from '../db/repositories/circleInspectorRepository';
import { createCorsOptions, isTrustedClientRequestOrigin } from '../middleware/security';
import type { TenancyRequest } from '../middleware/tenancy';
import inspectorBootstrapRouter from './inspectorBootstrap';
import { requireInspectorSession, tokenHash } from './inspectorSupport';

const INSPECTOR_ORIGIN = 'https://inspector.circlus.org';

describe('official Inspector CORS with default deployment settings', () => {
  const originalEnv = { ...process.env };
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    // Match production order: CORS also runs before tenant resolution.
    app.use(cors(createCorsOptions()));
    app.use('/api/inspector', express.json(), inspectorBootstrapRouter);
    app.use((req: TenancyRequest, _res, next) => {
      req.familyId = 'family-1';
      next();
    });
    app.use(cors(createCorsOptions()));
    app.get('/api/inspector/summary', requireInspectorSession, (_req, res) => {
      res.json({ status: 'ok' });
    });
    app.use((_req, res) => res.status(404).end());
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TRUSTED_CLIENT_ORIGINS;
    process.env.VPS_ID = 'vps-cors-test';
    (configService.getFamilyConfig as jest.Mock).mockResolvedValue({ extra_trusted_client_origins: [] });
    (circleInspectorRepository.createUnboundRequest as jest.Mock).mockResolvedValue({
      request_id: 'request-1', status: 'pending', expires_at: Date.now() + 60_000
    });
    (circleInspectorRepository.findRequestById as jest.Mock).mockResolvedValue({
      request_id: 'request-1', status: 'pending', expires_at: Date.now() + 60_000,
      request_token_hash: tokenHash('request-secret')
    });
    (circleInspectorRepository.findActiveSessionByTokenHash as jest.Mock).mockResolvedValue(null);
    (circleInspectorRepository.touchSession as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function request(
    path: string,
    method = 'GET',
    headers: Record<string, string> = {},
    body?: string
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
        agent: false,
        headers: {
          Origin: INSPECTOR_ORIGIN,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers
        }
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  test('allows preflight and request creation before a Circle is selected', async () => {
    const preflight = await request('/api/inspector/requests', 'OPTIONS', {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(INSPECTOR_ORIGIN);

    const created = await request('/api/inspector/requests', 'POST', {
      'Content-Type': 'application/json'
    }, JSON.stringify({ viewerLabel: 'Browser' }));
    expect(created.status).toBe(200);
    expect(created.headers['access-control-allow-origin']).toBe(INSPECTOR_ORIGIN);
    expect(JSON.parse(created.body).result.status).toBe('pending');
  });

  test('allows pickup headers and retains request-token checks', async () => {
    const preflight = await request('/api/inspector/requests/request-1', 'OPTIONS', {
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type,x-inspector-request-token,x-inspector-session-pickup'
    });
    expect(preflight.headers['access-control-allow-origin']).toBe(INSPECTOR_ORIGIN);
    expect(preflight.headers['access-control-allow-headers']).toContain('X-Inspector-Session-Pickup');

    const denied = await request('/api/inspector/requests/request-1', 'GET', {
      'X-Inspector-Request-Token': 'wrong'
    });
    expect(denied.status).toBe(404);
    expect(denied.headers['access-control-allow-origin']).toBe(INSPECTOR_ORIGIN);

    const pending = await request('/api/inspector/requests/request-1', 'GET', {
      'X-Inspector-Request-Token': 'request-secret'
    });
    expect(pending.status).toBe(200);
    expect(pending.headers['access-control-allow-origin']).toBe(INSPECTOR_ORIGIN);
  });

  test('allows authenticated reads but still rejects missing or expired session tokens', async () => {
    const preflight = await request('/api/inspector/summary', 'OPTIONS', {
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,x-circlus-circle-id'
    });
    expect(preflight.headers['access-control-allow-origin']).toBe(INSPECTOR_ORIGIN);
    expect(preflight.headers['access-control-allow-headers']).toContain('X-Circlus-Circle-ID');

    const missing = await request('/api/inspector/summary');
    expect(missing.status).toBe(401);
    expect(missing.headers['access-control-allow-origin']).toBe(INSPECTOR_ORIGIN);

    const expired = await request('/api/inspector/summary', 'GET', { Authorization: 'Bearer expired' });
    expect(expired.status).toBe(401);
    expect(expired.headers['access-control-allow-origin']).toBe(INSPECTOR_ORIGIN);

    (circleInspectorRepository.findActiveSessionByTokenHash as jest.Mock).mockResolvedValue({
      session_id: 'session-1'
    });
    const allowed = await request('/api/inspector/summary', 'GET', { Authorization: 'Bearer valid' });
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(INSPECTOR_ORIGIN);
    expect(circleInspectorRepository.findActiveSessionByTokenHash).toHaveBeenLastCalledWith(
      'family-1', tokenHash('valid'), expect.any(Number)
    );
  });

  test.each([
    'https://evil.example.com',
    'http://inspector.circlus.org',
    'https://inspector.circlus.org.evil.example',
    'https://inspector.circlus.org:8443'
  ])('does not allow a different Inspector origin: %s', async (origin) => {
    const response = await request('/api/inspector/requests', 'OPTIONS', {
      Origin: origin, 'Access-Control-Request-Method': 'POST'
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  test.each([
    '/api/config/capabilities',
    '/api/auth/register-device',
    '/api/host-provisioning',
    '/api/inspector-other',
    '/api/config?path=/api/inspector/requests'
  ])('does not grant the Inspector origin CORS access to %s', async (path) => {
    const response = await request(path, 'OPTIONS', { 'Access-Control-Request-Method': 'POST' });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('does not add Inspector to the trusted client policy used outside CORS', async () => {
    await expect(isTrustedClientRequestOrigin(INSPECTOR_ORIGIN, 'family-1')).resolves.toBe(false);
  });
});
