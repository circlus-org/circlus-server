import { createMigrationSession } from './circleMigrationCrypto';
import {
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FIXED_SCOPES,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
} from './circleMigrationContract';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import { familyConfigRepository } from '../db/repositories/familyConfigRepository';
import { identityRepository } from '../db/repositories/identityRepository';
import { postCircleMigrationJson } from './circleMigrationHttpClient';

jest.mock('../db/repositories/circleMigrationRepository', () => ({
  circleMigrationRepository: {
    findOpenSourceMigrationByFamily: jest.fn(),
    createSourceMigration: jest.fn(),
    transitionSourceMigration: jest.fn(),
    collectSourcePreflightStats: jest.fn(),
    completeSourcePreflight: jest.fn()
  }
}));
jest.mock('../db/repositories/familyConfigRepository', () => ({
  familyConfigRepository: { findByFamilyId: jest.fn() }
}));
jest.mock('../db/repositories/identityRepository', () => ({
  identityRepository: { findByIdentityId: jest.fn() }
}));
jest.mock('./circleMigrationHttpClient', () => {
  class MockHttpError extends Error {}
  return {
    postCircleMigrationJson: jest.fn(),
    CircleMigrationHttpError: MockHttpError
  };
});

const { circleMigrationPreflightService } = require('./circleMigrationPreflightService');

function migrationRecord(overrides: Record<string, unknown> = {}) {
  return {
    migration_id: 'migjob_test',
    family_id: '11111111-1111-4111-8111-111111111111',
    destination_service_endpoint: 'https://destination.example',
    destination_public_base_url: 'https://circle.example',
    migration_slot_id: 'mslot_test',
    status: 'draft',
    started_by_identity_id: 'owner_1',
    destination_server_id: null,
    data_scope_fingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
    session_credentials_encrypted: null,
    session_expires_at: null,
    preflight_summary: null,
    confirmed_data_loss: null,
    owner_signed_migration_intent: null,
    manifest: null,
    export_snapshot_id: null,
    last_progress_at: new Date(),
    freeze_started_at: null,
    export_started_at: null,
    transfer_started_at: null,
    cutover_started_at: null,
    completed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    failure_code: null,
    failure_message: null,
    ...overrides
  };
}

describe('Circle migration source preflight', () => {
  const familyId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    process.env.CIRCLE_MIGRATION_SECRET_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');
    process.env.VPS_ID = 'source-server';
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({
      family_id: familyId,
      status: 'active',
      owner_identity_id: 'owner_1',
      circle_id: 'circle_source_1234567890',
      public_base_url: 'https://source.example',
      message_ttl_hours: 24
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      identity_id: 'owner_1',
      status: 'active',
      role: 'owner',
      public_key_algorithm: 'ed25519',
      public_key_value: Buffer.alloc(32, 3).toString('base64')
    });
    (circleMigrationRepository.findOpenSourceMigrationByFamily as jest.Mock).mockResolvedValue(null);
    (circleMigrationRepository.createSourceMigration as jest.Mock).mockImplementation(async (data) => (
      migrationRecord({ session_credentials_encrypted: data.sessionCredentialsEncrypted })
    ));
    (circleMigrationRepository.transitionSourceMigration as jest.Mock).mockImplementation(
      async (_id, _from, to, failure) => migrationRecord({
        status: to,
        failure_code: failure?.code || null,
        failure_message: failure?.message || null,
        session_credentials_encrypted: (
          (circleMigrationRepository.createSourceMigration as jest.Mock).mock.results[0]?.value
        )?.session_credentials_encrypted
      })
    );
    (circleMigrationRepository.collectSourcePreflightStats as jest.Mock).mockResolvedValue({
      counts: { identities: 2, messages: 5 },
      byteSizes: { identities: 100, messages: 500 },
      dataLossCounts: { attachment_blobs: 1 },
      dataLossByteSizes: { attachment_blobs: 200 },
      estimatedTransferBytes: 600,
      excludedMessageCountByTargetTtl: 1,
      memberIdentityCount: 2,
      totalIdentityCount: 2,
      publicSiteEnabled: false,
      publicGuestLinkCount: 0
    });
    (circleMigrationRepository.completeSourcePreflight as jest.Mock).mockImplementation(async (data) => (
      migrationRecord({
        status: 'ready',
        destination_server_id: data.destinationServerId,
        session_credentials_encrypted: data.sessionCredentialsEncrypted,
        session_expires_at: data.sessionExpiresAt,
        preflight_summary: data.preflightSummary
      })
    ));
    (postCircleMigrationJson as jest.Mock).mockImplementation(async (_endpoint, _path, payload) => {
      const session = createMigrationSession(payload.sourceSessionPublicKey.value);
      return {
        status: 'ok',
        result: {
          slotStatus: 'verified',
          targetPublicBaseUrl: 'https://circle.example',
          destinationServerId: 'destination-server',
          destinationCircleId: 'circle_destination_123456',
          acceptedDataScopes: CIRCLE_MIGRATION_FIXED_SCOPES,
          migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
          schemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
          dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
          limits: { maxMemberIdentities: 10, maxTotalIdentities: 20 },
          policies: { messageTtlHours: 12 },
          sessionKeyEnvelope: session.envelope,
          sessionExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          slotExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }
      };
    });
  });

  afterAll(() => {
    delete process.env.CIRCLE_MIGRATION_SECRET_KEY_BASE64;
  });

  it('binds the destination session, checks counts, and persists a ready summary', async () => {
    const result = await circleMigrationPreflightService.run({
      familyId,
      ownerIdentityId: 'owner_1',
      destinationServiceEndpoint: 'https://destination.example',
      migrationSlotId: 'mslot_test',
      migrationCode: 'mig_secret',
      targetPublicBaseUrl: 'https://circle.example'
    });

    expect(result.migration.status).toBe('ready');
    expect(result.summary).toMatchObject({
      preflightStatus: 'ready',
      estimatedTransferBytes: 600,
      targetMessageTtlHours: 12,
      excludedMessageCountByTargetTtl: 1
    });
    expect(circleMigrationRepository.collectSourcePreflightStats).toHaveBeenCalledWith(familyId, 12);
    expect(circleMigrationRepository.completeSourcePreflight).toHaveBeenCalled();
  });

  it('fails preflight when destination identity limits are lower than the Circle counts', async () => {
    (circleMigrationRepository.collectSourcePreflightStats as jest.Mock).mockResolvedValueOnce({
      counts: {},
      byteSizes: {},
      dataLossCounts: {},
      dataLossByteSizes: {},
      estimatedTransferBytes: 0,
      excludedMessageCountByTargetTtl: 0,
      memberIdentityCount: 11,
      totalIdentityCount: 11,
      publicSiteEnabled: false,
      publicGuestLinkCount: 0
    });

    await expect(circleMigrationPreflightService.run({
      familyId,
      ownerIdentityId: 'owner_1',
      destinationServiceEndpoint: 'https://destination.example',
      migrationSlotId: 'mslot_test',
      migrationCode: 'mig_secret',
      targetPublicBaseUrl: 'https://circle.example'
    })).rejects.toMatchObject({ code: 'MIGRATION_DESTINATION_LIMIT_EXCEEDED' });
    expect(circleMigrationRepository.transitionSourceMigration).toHaveBeenLastCalledWith(
      'migjob_test',
      'preflight',
      'failed',
      expect.objectContaining({ code: 'MIGRATION_DESTINATION_LIMIT_EXCEEDED' })
    );
  });

  it('returns an existing ready preflight without contacting destination again', async () => {
    (circleMigrationRepository.findOpenSourceMigrationByFamily as jest.Mock).mockResolvedValueOnce(
      migrationRecord({
        status: 'ready',
        preflight_summary: { preflightStatus: 'ready', estimatedTransferBytes: 42 }
      })
    );

    const result = await circleMigrationPreflightService.run({
      familyId,
      ownerIdentityId: 'owner_1',
      destinationServiceEndpoint: 'https://destination.example',
      migrationSlotId: 'mslot_test',
      migrationCode: 'mig_secret',
      targetPublicBaseUrl: 'https://circle.example'
    });

    expect(result.summary).toEqual({ preflightStatus: 'ready', estimatedTransferBytes: 42 });
    expect(postCircleMigrationJson).not.toHaveBeenCalled();
  });
});
