import { EventEmitter } from 'node:events';
import {
  activateCircleFreeze,
  circleMigrationFreezeMiddleware,
  deactivateCircleFreeze
} from './circleMigrationFreeze';

jest.mock('../db/repositories/circleMigrationRepository', () => ({
  circleMigrationRepository: {
    findFrozenSourceMigrationByFamily: jest.fn().mockResolvedValue(null)
  }
}));

function response() {
  const emitter = new EventEmitter() as EventEmitter & {
    status: jest.Mock;
    json: jest.Mock;
  };
  emitter.status = jest.fn().mockReturnValue(emitter);
  emitter.json = jest.fn().mockReturnValue(emitter);
  return emitter;
}

describe('Circle migration freeze middleware', () => {
  const familyId = '11111111-1111-4111-8111-111111111111';

  afterEach(() => deactivateCircleFreeze(familyId));

  it('blocks tenant mutations with CIRCLE_MIGRATING', async () => {
    activateCircleFreeze(familyId, {
      migrationId: 'migjob_test',
      migrationStatus: 'frozen',
      targetPublicBaseUrl: 'https://target.example'
    });
    const res = response();
    const next = jest.fn();
    await circleMigrationFreezeMiddleware({
      familyId,
      method: 'POST',
      path: '/messages/send'
    } as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'CIRCLE_MIGRATING' })
    }));
  });

  it('allows explicitly read-only endpoints during freeze', async () => {
    activateCircleFreeze(familyId, {
      migrationId: 'migjob_test',
      migrationStatus: 'exporting',
      targetPublicBaseUrl: 'https://target.example'
    });
    const res = response();
    const next = jest.fn();
    await circleMigrationFreezeMiddleware({
      familyId,
      method: 'GET',
      path: '/config/capabilities'
    } as any, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('always allows signed migration control endpoints', async () => {
    activateCircleFreeze(familyId, {
      migrationId: 'migjob_test',
      migrationStatus: 'failed',
      targetPublicBaseUrl: 'https://target.example'
    });
    const next = jest.fn();
    await circleMigrationFreezeMiddleware({
      familyId,
      method: 'POST',
      path: '/admin/migration/abort'
    } as any, response() as any, next);
    expect(next).toHaveBeenCalled();
  });
});
