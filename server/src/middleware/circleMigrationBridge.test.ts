import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import {
  circleMigrationBridgeContextMiddleware,
  circleMigrationBridgeMiddleware
} from './circleMigrationBridge';

jest.mock('../db/repositories/circleMigrationRepository', () => ({
  circleMigrationRepository: {
    findActiveRedirectByHost: jest.fn()
  }
}));

function response() {
  return {
    locals: {},
    statusCode: 200,
    body: null as any,
    location: null as string | null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    redirect(code: number, location: string) {
      this.statusCode = code;
      this.location = location;
      return this;
    }
  };
}

describe('Circle migration source bridge', () => {
  const redirect = {
    family_id: '11111111-1111-4111-8111-111111111111',
    moved_to: 'https://new.example',
    migrated_at: new Date('2026-07-23T10:00:00.000Z'),
    bridge_expires_at: new Date('2026-10-21T10:00:00.000Z'),
    owner_public_key: { algorithm: 'ed25519', value: 'key' },
    owner_signed_migration_proof: {
      payload: { familyId: '11111111-1111-4111-8111-111111111111' },
      signature: 'signature'
    }
  };

  beforeEach(() => {
    (circleMigrationRepository.findActiveRedirectByHost as jest.Mock).mockResolvedValue(redirect);
  });

  it('returns CIRCLE_MOVED before tenancy for API requests', async () => {
    const req = {
      method: 'POST',
      path: '/api/messages/list',
      url: '/api/messages/list',
      originalUrl: '/api/messages/list',
      get: (name: string) => name.toLowerCase() === 'host' ? 'old.example' : undefined,
      headers: {}
    } as any;
    const res = response();
    const next = jest.fn();
    await circleMigrationBridgeMiddleware(req, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(410);
    expect(res.body).toMatchObject({
      error: {
        code: 'CIRCLE_MOVED',
        details: {
          targetPublicBaseUrl: 'https://new.example',
          migrationProof: { ownerSignature: 'signature' }
        }
      }
    });
  });

  it('loads the migrated family context before CORS', async () => {
    const req = {
      get: (name: string) => name.toLowerCase() === 'host' ? 'old.example' : undefined,
      headers: {}
    } as any;
    const res = response();
    const next = jest.fn();

    await circleMigrationBridgeContextMiddleware(req, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.familyId).toBe(redirect.family_id);
    expect(circleMigrationRepository.findActiveRedirectByHost).toHaveBeenCalledWith('old.example');
  });

  it('redirects a public site path without receiving a URL fragment', async () => {
    const req = {
      method: 'GET',
      path: '/channels/news/posts/hello',
      url: '/channels/news/posts/hello?from=old',
      originalUrl: '/channels/news/posts/hello?from=old',
      get: (name: string) => name.toLowerCase() === 'host' ? 'old.example' : undefined,
      headers: {}
    } as any;
    const res = response();
    await circleMigrationBridgeMiddleware(req, res as any, jest.fn());
    expect(res.statusCode).toBe(301);
    expect(res.location).toBe('https://new.example/channels/news/posts/hello?from=old');
  });

  it('falls through when the host has no active bridge', async () => {
    (circleMigrationRepository.findActiveRedirectByHost as jest.Mock).mockResolvedValue(null);
    const next = jest.fn();
    await circleMigrationBridgeMiddleware({
      method: 'GET',
      path: '/',
      get: () => 'other.example',
      headers: {}
    } as any, response() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
