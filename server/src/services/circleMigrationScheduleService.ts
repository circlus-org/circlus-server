import { circleMigrationRepository, type CircleMigrationRecord } from '../db/repositories/circleMigrationRepository';
import { familyConfigRepository } from '../db/repositories/familyConfigRepository';
import { identityRepository } from '../db/repositories/identityRepository';
import { verifySignature } from '../utils/crypto';
import { normalizePublicServerUrl } from '../utils/serverIdentity';
import {
  canonicalizeCircleMigrationJson,
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
  sha256Fingerprint
} from './circleMigrationContract';
import {
  decryptMigrationSecret,
  encryptMigrationSecret,
  type MigrationSessionCredentials
} from './circleMigrationCrypto';
import { postCircleMigrationJson } from './circleMigrationHttpClient';
import {
  CircleMigrationServiceError,
  type OwnerSignedMigrationIntent
} from './circleMigrationSlotService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

const FIXED_DATA_LOSS_POLICY = {
  dropAttachments: true,
  dropMessageArchive: true,
  dropCallHistory: true,
  dropCallLinks: true,
  dropInvites: true,
  dropSystemEvents: true
} as const;

function normalizedScheduledAt(raw: unknown): Date {
  const value = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(value)) {
    throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'scheduledAt must be an ISO timestamp');
  }
  const now = Date.now();
  if (value < now - 60_000 || value > now + 7 * 24 * 60 * 60 * 1000) {
    throw new CircleMigrationServiceError(
      400,
      'INVALID_REQUEST',
      'scheduledAt must be between now and seven days from now'
    );
  }
  return new Date(Math.max(value, now));
}

function validateLocalOwnerIntent(params: {
  migration: CircleMigrationRecord;
  ownerIdentityId: string;
  ownerPublicKey: { algorithm: 'ed25519'; value: string };
  sourceServerUrl: string;
  intent: OwnerSignedMigrationIntent;
  preflightSummaryFingerprint: string;
}): void {
  const payload = params.intent?.payload;
  const expectedPayload = {
    migrationSlotId: params.migration.migration_slot_id,
    migrationId: params.migration.migration_id,
    familyId: params.migration.family_id,
    ownerIdentityId: params.ownerIdentityId,
    sourceServerId: getServerIdentityRuntimeConfig().vpsId,
    destinationServerId: params.migration.destination_server_id,
    sourceCircleId: String(
      (params.migration.preflight_summary?.migrationBinding as Record<string, unknown> | undefined)?.sourceCircleId || ''
    ),
    destinationCircleId: String(
      (params.migration.preflight_summary?.migrationBinding as Record<string, unknown> | undefined)?.destinationCircleId || ''
    ),
    oldPublicBaseUrl: params.sourceServerUrl,
    targetPublicBaseUrl: params.migration.destination_public_base_url,
    migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
    sourceSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
    destinationSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
    dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
    preflightSummaryFingerprint: params.preflightSummaryFingerprint,
    dataLossPolicy: FIXED_DATA_LOSS_POLICY,
    expiresAt: payload?.expiresAt
  };
  const expiresAt = Date.parse(String(payload?.expiresAt || ''));
  const slotExpiresAt = Date.parse(String(params.migration.preflight_summary?.destinationSlotExpiresAt || ''));
  if (
    !payload
    || typeof params.intent.signature !== 'string'
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
    || expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000
    || !Number.isFinite(slotExpiresAt)
    || expiresAt > slotExpiresAt
    || canonicalizeCircleMigrationJson(payload) !== canonicalizeCircleMigrationJson(expectedPayload)
    || !verifySignature(
      canonicalizeCircleMigrationJson(payload),
      params.intent.signature,
      params.ownerPublicKey
    )
  ) {
    throw new CircleMigrationServiceError(
      401,
      'MIGRATION_OWNER_PROOF_INVALID',
      'Owner-signed migration intent is invalid or does not match the preflight'
    );
  }
}

async function refreshSessionIfNeeded(
  migration: CircleMigrationRecord,
  credentials: MigrationSessionCredentials
): Promise<{ credentials: MigrationSessionCredentials; expiresAt: Date }> {
  const currentExpiry = migration.session_expires_at?.getTime() || 0;
  if (currentExpiry > Date.now() + 30_000) {
    return { credentials, expiresAt: migration.session_expires_at! };
  }
  const refreshed = await postCircleMigrationJson<{
    status: 'ok';
    result: { sessionToken: string; sessionExpiresAt: string };
  }>(
    migration.destination_service_endpoint,
    '/api/migration/session/refresh',
    {
      migrationSlotId: migration.migration_slot_id,
      sessionKey: credentials.sessionKey
    }
  );
  const expiresAt = new Date(refreshed?.result?.sessionExpiresAt);
  if (
    refreshed?.status !== 'ok'
    || typeof refreshed.result?.sessionToken !== 'string'
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= Date.now()
  ) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_SESSION_EXPIRED',
      'Destination did not refresh the migration session'
    );
  }
  return {
    credentials: {
      ...credentials,
      sessionToken: refreshed.result.sessionToken
    },
    expiresAt
  };
}

class CircleMigrationScheduleService {
  async schedule(input: {
    familyId: string;
    ownerIdentityId: string;
    migrationId: string;
    scheduledAt: unknown;
    notifyMembers: unknown;
    confirmedDataLoss: Record<string, unknown>;
    ownerSignedMigrationIntent: OwnerSignedMigrationIntent;
  }): Promise<CircleMigrationRecord> {
    if (input.notifyMembers !== true) {
      throw new CircleMigrationServiceError(
        400,
        'INVALID_REQUEST',
        'notifyMembers must be true for migration v1'
      );
    }
    const scheduledAt = normalizedScheduledAt(input.scheduledAt);
    const migration = await circleMigrationRepository.findSourceMigration(input.migrationId);
    if (!migration || migration.family_id !== input.familyId) {
      throw new CircleMigrationServiceError(404, 'MIGRATION_NOT_FOUND', 'Migration not found');
    }
    if (migration.status === 'scheduled') {
      if (
        canonicalizeCircleMigrationJson(migration.owner_signed_migration_intent)
          === canonicalizeCircleMigrationJson(input.ownerSignedMigrationIntent)
      ) {
        return migration;
      }
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration is already scheduled');
    }
    if (migration.status !== 'ready' || !migration.preflight_summary || !migration.destination_server_id) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration is ${migration.status}`);
    }
    const destinationSlotExpiresAt = Date.parse(
      String(migration.preflight_summary.destinationSlotExpiresAt || '')
    );
    if (
      !Number.isFinite(destinationSlotExpiresAt)
      || scheduledAt.getTime() >= destinationSlotExpiresAt
    ) {
      throw new CircleMigrationServiceError(
        409,
        'MIGRATION_SLOT_EXPIRED',
        'scheduledAt must be before the destination migration slot expires'
      );
    }

    const [config, owner] = await Promise.all([
      familyConfigRepository.findByFamilyId(input.familyId),
      identityRepository.findByIdentityId(input.familyId, input.ownerIdentityId)
    ]);
    if (
      !config
      || config.status !== 'active'
      || config.owner_identity_id !== input.ownerIdentityId
      || !owner
      || owner.status !== 'active'
      || owner.role !== 'owner'
      || owner.public_key_algorithm !== 'ed25519'
    ) {
      throw new CircleMigrationServiceError(403, 'FORBIDDEN', 'Only the active Circle owner can schedule migration');
    }
    const preflightSummaryFingerprint = sha256Fingerprint(
      canonicalizeCircleMigrationJson(migration.preflight_summary)
    );
    if (
      input.confirmedDataLoss?.accepted !== true
      || input.confirmedDataLoss?.preflightSummaryFingerprint !== preflightSummaryFingerprint
    ) {
      throw new CircleMigrationServiceError(
        400,
        'MIGRATION_DATA_LOSS_NOT_CONFIRMED',
        'Data loss confirmation must match the current preflight summary'
      );
    }
    validateLocalOwnerIntent({
      migration,
      ownerIdentityId: input.ownerIdentityId,
      ownerPublicKey: {
        algorithm: 'ed25519',
        value: owner.public_key_value
      },
      sourceServerUrl: normalizePublicServerUrl(config.public_base_url) || config.public_base_url,
      intent: input.ownerSignedMigrationIntent,
      preflightSummaryFingerprint
    });

    const storedCredentials = decryptMigrationSecret<MigrationSessionCredentials>(
      migration.session_credentials_encrypted
    );
    const session = await refreshSessionIfNeeded(migration, storedCredentials);
    const reserved = await postCircleMigrationJson<{
      status: 'ok';
      result: { migrationSlotId: string; slotStatus: 'reserved' };
    }>(
      migration.destination_service_endpoint,
      '/api/migration/slots/reserve',
      {
        migrationSlotId: migration.migration_slot_id,
        familyId: input.familyId,
        preflightSummary: migration.preflight_summary,
        ownerSignedMigrationIntent: input.ownerSignedMigrationIntent
      },
      { authorization: `MigrationSession ${session.credentials.sessionToken}` }
    );
    if (
      reserved?.status !== 'ok'
      || reserved.result?.migrationSlotId !== migration.migration_slot_id
      || reserved.result?.slotStatus !== 'reserved'
    ) {
      throw new CircleMigrationServiceError(409, 'MIGRATION_DESTINATION_REJECTED', 'Destination did not reserve the slot');
    }

    const scheduled = await circleMigrationRepository.scheduleSourceMigration({
      migrationId: migration.migration_id,
      familyId: input.familyId,
      ownerIdentityId: input.ownerIdentityId,
      scheduledAt,
      confirmedDataLoss: input.confirmedDataLoss,
      ownerSignedMigrationIntent: input.ownerSignedMigrationIntent as unknown as Record<string, unknown>,
      destinationPublicBaseUrl: migration.destination_public_base_url,
      sessionCredentialsEncrypted: encryptMigrationSecret(session.credentials),
      sessionExpiresAt: session.expiresAt
    });
    if (!scheduled) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration changed concurrently');
    }
    return scheduled;
  }
}

export const circleMigrationScheduleService = new CircleMigrationScheduleService();
export { FIXED_DATA_LOSS_POLICY };
