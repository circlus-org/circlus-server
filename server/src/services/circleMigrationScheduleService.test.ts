import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  canonicalizeCircleMigrationJson,
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
  sha256Fingerprint
} from './circleMigrationContract';
import { encryptMigrationSecret } from './circleMigrationCrypto';
import { FIXED_DATA_LOSS_POLICY } from './circleMigrationScheduleService';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import { familyConfigRepository } from '../db/repositories/familyConfigRepository';
import { identityRepository } from '../db/repositories/identityRepository';
import { postCircleMigrationJson } from './circleMigrationHttpClient';

jest.mock('../db/repositories/circleMigrationRepository', () => ({
  circleMigrationRepository: {
    findSourceMigration: jest.fn(),
    scheduleSourceMigration: jest.fn()
  }
}));
jest.mock('../db/repositories/familyConfigRepository', () => ({
  familyConfigRepository: { findByFamilyId: jest.fn() }
}));
jest.mock('../db/repositories/identityRepository', () => ({
  identityRepository: { findByIdentityId: jest.fn() }
}));
jest.mock('./circleMigrationHttpClient', () => ({
  postCircleMigrationJson: jest.fn()
}));

const { circleMigrationScheduleService } = require('./circleMigrationScheduleService');

describe('Circle migration scheduling', () => {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const ownerKeyPair = nacl.sign.keyPair();
  const preflightSummary = {
    preflightStatus: 'ready',
    migrationBinding: {
      sourceCircleId: 'circle_source_1234567890',
      destinationCircleId: 'circle_destination_123456'
    },
    estimatedTransferBytes: 100,
    destinationSlotExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  };

  beforeEach(() => {
    process.env.CIRCLE_MIGRATION_SECRET_KEY_BASE64 = Buffer.alloc(32, 5).toString('base64');
    process.env.VPS_ID = 'source-server';
    (circleMigrationRepository.findSourceMigration as jest.Mock).mockResolvedValue({
      migration_id: 'migjob_test',
      family_id: familyId,
      migration_slot_id: 'mslot_test',
      status: 'ready',
      destination_service_endpoint: 'https://destination.example',
      destination_public_base_url: 'https://circle.example',
      destination_server_id: 'destination-server',
      preflight_summary: preflightSummary,
      session_credentials_encrypted: encryptMigrationSecret({
        sessionToken: 'msess_test',
        sessionKey: Buffer.alloc(32, 6).toString('base64')
      }),
      session_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      owner_signed_migration_intent: null
    });
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({
      family_id: familyId,
      status: 'active',
      owner_identity_id: 'owner_1',
      public_base_url: 'https://source.example'
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      identity_id: 'owner_1',
      status: 'active',
      role: 'owner',
      public_key_algorithm: 'ed25519',
      public_key_value: encodeBase64(ownerKeyPair.publicKey)
    });
    (postCircleMigrationJson as jest.Mock).mockResolvedValue({
      status: 'ok',
      result: { migrationSlotId: 'mslot_test', slotStatus: 'reserved' }
    });
    (circleMigrationRepository.scheduleSourceMigration as jest.Mock).mockImplementation(async (data) => ({
      migration_id: data.migrationId,
      status: 'scheduled',
      scheduled_at: data.scheduledAt,
      members_notified_at: new Date(),
      destination_public_base_url: data.destinationPublicBaseUrl
    }));
  });

  function signedInput() {
    const preflightSummaryFingerprint = sha256Fingerprint(
      canonicalizeCircleMigrationJson(preflightSummary)
    );
    const payload = {
      migrationSlotId: 'mslot_test',
      migrationId: 'migjob_test',
      familyId,
      ownerIdentityId: 'owner_1',
      sourceServerId: 'source-server',
      destinationServerId: 'destination-server',
      sourceCircleId: 'circle_source_1234567890',
      destinationCircleId: 'circle_destination_123456',
      oldPublicBaseUrl: 'https://source.example',
      targetPublicBaseUrl: 'https://circle.example',
      migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
      sourceSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
      destinationSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
      dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
      preflightSummaryFingerprint,
      dataLossPolicy: FIXED_DATA_LOSS_POLICY,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    };
    return {
      preflightSummaryFingerprint,
      ownerSignedMigrationIntent: {
        payload,
        signature: encodeBase64(nacl.sign.detached(
          Buffer.from(canonicalizeCircleMigrationJson(payload), 'utf8'),
          ownerKeyPair.secretKey
        ))
      }
    };
  }

  it('reserves destination and atomically schedules the source migration', async () => {
    const signed = signedInput();
    const scheduled = await circleMigrationScheduleService.schedule({
      familyId,
      ownerIdentityId: 'owner_1',
      migrationId: 'migjob_test',
      scheduledAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      notifyMembers: true,
      confirmedDataLoss: {
        accepted: true,
        preflightSummaryFingerprint: signed.preflightSummaryFingerprint
      },
      ownerSignedMigrationIntent: signed.ownerSignedMigrationIntent
    });

    expect(scheduled.status).toBe('scheduled');
    expect(postCircleMigrationJson).toHaveBeenCalledWith(
      'https://destination.example',
      '/api/migration/slots/reserve',
      expect.objectContaining({ migrationSlotId: 'mslot_test', preflightSummary }),
      { authorization: 'MigrationSession msess_test' }
    );
    expect(circleMigrationRepository.scheduleSourceMigration).toHaveBeenCalled();
  });

  it('rejects confirmation for a different preflight preview', async () => {
    const signed = signedInput();
    await expect(circleMigrationScheduleService.schedule({
      familyId,
      ownerIdentityId: 'owner_1',
      migrationId: 'migjob_test',
      scheduledAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      notifyMembers: true,
      confirmedDataLoss: {
        accepted: true,
        preflightSummaryFingerprint: 'sha256:different'
      },
      ownerSignedMigrationIntent: signed.ownerSignedMigrationIntent
    })).rejects.toMatchObject({ code: 'MIGRATION_DATA_LOSS_NOT_CONFIRMED' });
    expect(postCircleMigrationJson).not.toHaveBeenCalled();
  });
});
