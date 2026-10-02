import { EventEmitter } from 'node:events';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '172.18.0.5', family: 4 }])
}));

const connectedTo: Array<{ hostname?: string; pinnedAddress?: string }> = [];
jest.mock('node:https', () => ({
  __esModule: true,
  default: {
    request: (options: {
      hostname?: string;
      lookup?: (hostname: string | undefined, options: object, callback: (error: unknown, address: string) => void) => void;
    }) => {
      const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      request.destroy = () => undefined;
      request.end = () => {
        options.lookup?.(options.hostname, {}, (_error: unknown, address: string) => {
          connectedTo.push({ hostname: options.hostname, pinnedAddress: address });
        });
        request.emit('error', new Error('stub connection'));
      };
      return request;
    }
  }
}));

import { postCircleMigrationJson } from './circleMigrationHttpClient';

describe('Circle migration HTTP client private addresses', () => {
  const previous = process.env.CIRCLE_MIGRATION_TEST_PRIVATE_ENDPOINT_HOSTS;
  const previousVpsId = process.env.VPS_ID;

  beforeAll(() => {
    process.env.VPS_ID = previousVpsId || 'vps-migration-http-test';
  });

  afterAll(() => {
    if (previousVpsId === undefined) delete process.env.VPS_ID;
    else process.env.VPS_ID = previousVpsId;
  });

  afterEach(() => {
    connectedTo.length = 0;
    if (previous === undefined) delete process.env.CIRCLE_MIGRATION_TEST_PRIVATE_ENDPOINT_HOSTS;
    else process.env.CIRCLE_MIGRATION_TEST_PRIVATE_ENDPOINT_HOSTS = previous;
  });

  it('refuses a destination that resolves to a private address', async () => {
    delete process.env.CIRCLE_MIGRATION_TEST_PRIVATE_ENDPOINT_HOSTS;
    await expect(postCircleMigrationJson('https://circle-b.test', '/api/migration/x', {}))
      .rejects.toThrow('private address');
    expect(connectedTo).toEqual([]);
  });

  it('connects to the pinned private address only for a listed test hostname', async () => {
    process.env.CIRCLE_MIGRATION_TEST_PRIVATE_ENDPOINT_HOSTS = 'circle-b.test';
    await expect(postCircleMigrationJson('https://circle-b.test', '/api/migration/x', {}))
      .rejects.toThrow('stub connection');
    expect(connectedTo).toEqual([{ hostname: 'circle-b.test', pinnedAddress: '172.18.0.5' }]);

    await expect(postCircleMigrationJson('https://other.test', '/api/migration/x', {}))
      .rejects.toThrow('private address');
  });

  it('keeps requiring HTTPS for a listed test hostname', async () => {
    process.env.CIRCLE_MIGRATION_TEST_PRIVATE_ENDPOINT_HOSTS = 'circle-b.test';
    await expect(postCircleMigrationJson('http://circle-b.test', '/api/migration/x', {}))
      .rejects.toThrow();
    expect(connectedTo).toEqual([]);
  });
});
