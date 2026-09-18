import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { circleMigrationRepository, type CircleMigrationRecord } from '../db/repositories/circleMigrationRepository';
import { familyConfigRepository } from '../db/repositories/familyConfigRepository';
import { identityRepository } from '../db/repositories/identityRepository';
import { isBlockedManagedHost } from '../utils/publicSiteDomainPolicy';
import { createOpaqueClaimToken } from '../utils/claimTokens';
import { normalizePublicServerUrl } from '../utils/serverIdentity';
import {
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FIXED_SCOPES,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
} from './circleMigrationContract';
import {
  decryptMigrationSecret,
  encryptMigrationSecret,
  openMigrationSessionEnvelope,
  type MigrationSessionEnvelope
} from './circleMigrationCrypto';
import { postCircleMigrationJson, CircleMigrationHttpError } from './circleMigrationHttpClient';
import { CircleMigrationServiceError, requireNormalizedHttpsUrl } from './circleMigrationSlotService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

interface StoredSourceSessionBootstrap {
  sourceSessionSecretKey: string;
}

interface DestinationVerifyResponse {
  status: 'ok';
  result: {
    slotStatus: 'verified';
    targetPublicBaseUrl: string;
    destinationServerId: string;
    destinationCircleId: string;
    acceptedDataScopes: readonly string[];
    migrationFormatVersion: number;
    schemaFingerprint: string;
    dataScopeFingerprint: string;
    limits: {
      maxMemberIdentities?: number | null;
      maxTotalIdentities?: number | null;
    };
    policies: {
      messageTtlHours?: number | null;
    };
    sessionKeyEnvelope: MigrationSessionEnvelope;
    sessionExpiresAt: string;
    slotExpiresAt: string;
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function publicKeyForOwner(identity: NonNullable<Awaited<ReturnType<typeof identityRepository.findByIdentityId>>>) {
  if (identity.public_key_algorithm !== 'ed25519' || !identity.public_key_value) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_OWNER_PROOF_INVALID',
      'Circle owner identity must have an Ed25519 public key'
    );
  }
  return {
    algorithm: 'ed25519' as const,
    value: identity.public_key_value
  };
}

function assertSameExistingRequest(
  migration: CircleMigrationRecord,
  destinationServiceEndpoint: string,
  migrationSlotId: string,
  targetPublicBaseUrl: string
): void {
  if (
    migration.destination_service_endpoint !== destinationServiceEndpoint
    || migration.migration_slot_id !== migrationSlotId
    || migration.destination_public_base_url !== targetPublicBaseUrl
  ) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_ALREADY_IN_PROGRESS',
      'This Circle already has a migration bound to another destination request'
    );
  }
}

function validateDestinationResponse(
  response: DestinationVerifyResponse,
  targetPublicBaseUrl: string
): DestinationVerifyResponse['result'] {
  const result = response?.result;
  if (
    response?.status !== 'ok'
    || result?.slotStatus !== 'verified'
    || !result.destinationServerId
    || !result.destinationCircleId
    || result.migrationFormatVersion !== CIRCLE_MIGRATION_FORMAT_VERSION
    || result.schemaFingerprint !== CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
    || result.dataScopeFingerprint !== CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT
    || normalizePublicServerUrl(result.targetPublicBaseUrl) !== targetPublicBaseUrl
    || !result.sessionKeyEnvelope
  ) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_SCHEMA_FINGERPRINT_MISMATCH',
      'Destination returned an incompatible migration contract'
    );
  }
  const scopes = Array.isArray(result.acceptedDataScopes) ? [...result.acceptedDataScopes].sort() : [];
  if (JSON.stringify(scopes) !== JSON.stringify([...CIRCLE_MIGRATION_FIXED_SCOPES].sort())) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_SCHEMA_FINGERPRINT_MISMATCH',
      'Destination accepted data scopes do not match the fixed v1 scope'
    );
  }
  const expiresAt = Date.parse(result.sessionExpiresAt);
  const slotExpiresAt = Date.parse(result.slotExpiresAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(slotExpiresAt) || slotExpiresAt <= Date.now()) {
    throw new CircleMigrationServiceError(409, 'MIGRATION_SESSION_EXPIRED', 'Destination session expiry is invalid');
  }
  return result;
}

class CircleMigrationPreflightService {
  async run(input: {
    familyId: string;
    ownerIdentityId: string;
    destinationServiceEndpoint: string;
    migrationSlotId: string;
    migrationCode: string;
    targetPublicBaseUrl: string;
  }): Promise<{ migration: CircleMigrationRecord; summary: Record<string, unknown> }> {
    const destinationServiceEndpoint = requireNormalizedHttpsUrl(
      input.destinationServiceEndpoint,
      'destinationServiceEndpoint'
    );
    const targetPublicBaseUrl = requireNormalizedHttpsUrl(input.targetPublicBaseUrl, 'targetPublicBaseUrl');
    if (!input.migrationSlotId || !input.migrationCode) {
      throw new CircleMigrationServiceError(
        400,
        'INVALID_REQUEST',
        'migrationSlotId and migrationCode are required'
      );
    }

    const [config, owner] = await Promise.all([
      familyConfigRepository.findByFamilyId(input.familyId),
      identityRepository.findByIdentityId(input.familyId, input.ownerIdentityId)
    ]);
    if (!config || config.status !== 'active') {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Only an active Circle can be migrated');
    }
    if (
      !owner
      || owner.status !== 'active'
      || owner.role !== 'owner'
      || config.owner_identity_id !== input.ownerIdentityId
    ) {
      throw new CircleMigrationServiceError(403, 'FORBIDDEN', 'Only the active Circle owner can start migration');
    }
    const ownerIdentityPublicKey = publicKeyForOwner(owner);
    const sourceServerUrl = requireNormalizedHttpsUrl(config.public_base_url, 'sourceServerUrl');
    const sourceServerId = getServerIdentityRuntimeConfig().vpsId;

    let migration = await circleMigrationRepository.findOpenSourceMigrationByFamily(input.familyId);
    let sourceSessionSecretKey: string;
    let sourceSessionPublicKey: string;

    if (migration) {
      assertSameExistingRequest(
        migration,
        destinationServiceEndpoint,
        input.migrationSlotId,
        targetPublicBaseUrl
      );
      if (migration.status === 'ready' && migration.preflight_summary) {
        return { migration, summary: migration.preflight_summary };
      }
      if (!['draft', 'preflight', 'failed'].includes(migration.status)) {
        throw new CircleMigrationServiceError(
          409,
          'INVALID_STATE',
          `Migration preflight cannot run from ${migration.status}`
        );
      }
      const bootstrap = decryptMigrationSecret<StoredSourceSessionBootstrap>(
        migration.session_credentials_encrypted
      );
      sourceSessionSecretKey = bootstrap.sourceSessionSecretKey;
      const keyPair = nacl.box.keyPair.fromSecretKey(
        Buffer.from(sourceSessionSecretKey, 'base64')
      );
      sourceSessionPublicKey = encodeBase64(keyPair.publicKey);
    } else {
      const keyPair = nacl.box.keyPair();
      sourceSessionSecretKey = encodeBase64(keyPair.secretKey);
      sourceSessionPublicKey = encodeBase64(keyPair.publicKey);
      migration = await circleMigrationRepository.createSourceMigration({
        migrationId: createOpaqueClaimToken('migjob'),
        familyId: input.familyId,
        destinationServiceEndpoint,
        destinationPublicBaseUrl: targetPublicBaseUrl,
        migrationSlotId: input.migrationSlotId,
        startedByIdentityId: input.ownerIdentityId,
        dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
        sessionCredentialsEncrypted: encryptMigrationSecret({ sourceSessionSecretKey })
      });
    }

    if (migration.status === 'draft' || migration.status === 'failed') {
      const transitioned = await circleMigrationRepository.transitionSourceMigration(
        migration.migration_id,
        migration.status,
        'preflight'
      );
      if (!transitioned) {
        throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration changed concurrently');
      }
      migration = transitioned;
    }

    try {
      const response = await postCircleMigrationJson<DestinationVerifyResponse>(
        destinationServiceEndpoint,
        '/api/migration/slots/verify',
        {
          migrationSlotId: input.migrationSlotId,
          migrationId: migration.migration_id,
          migrationCode: input.migrationCode,
          sourceServerUrl,
          sourceServerId,
          sourceCircleId: config.circle_id,
          familyId: input.familyId,
          ownerIdentityId: input.ownerIdentityId,
          ownerIdentityPublicKey,
          sourceSessionPublicKey: {
            algorithm: 'x25519',
            value: sourceSessionPublicKey
          },
          migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
          sourceSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
          dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT
        }
      );
      const destination = validateDestinationResponse(response, targetPublicBaseUrl);
      let sessionCredentials = openMigrationSessionEnvelope(
        destination.sessionKeyEnvelope,
        sourceSessionSecretKey
      );
      let sessionExpiresAt = new Date(destination.sessionExpiresAt);
      if (sessionExpiresAt.getTime() <= Date.now()) {
        const refreshed = await postCircleMigrationJson<{
          status: 'ok';
          result: { sessionToken: string; sessionExpiresAt: string };
        }>(
          destinationServiceEndpoint,
          '/api/migration/session/refresh',
          {
            migrationSlotId: input.migrationSlotId,
            sessionKey: sessionCredentials.sessionKey
          }
        );
        const refreshedExpiry = Date.parse(refreshed?.result?.sessionExpiresAt);
        if (
          refreshed?.status !== 'ok'
          || typeof refreshed.result?.sessionToken !== 'string'
          || !Number.isFinite(refreshedExpiry)
          || refreshedExpiry <= Date.now()
        ) {
          throw new CircleMigrationServiceError(
            409,
            'MIGRATION_SESSION_EXPIRED',
            'Destination did not refresh the expired migration session'
          );
        }
        sessionCredentials = {
          ...sessionCredentials,
          sessionToken: refreshed.result.sessionToken
        };
        sessionExpiresAt = new Date(refreshedExpiry);
      }
      const targetTtlHours = numberOrNull(destination.policies?.messageTtlHours)
        ?? config.message_ttl_hours;
      if (targetTtlHours < 1 || targetTtlHours > 24 * 365) {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_DESTINATION_POLICY_INVALID',
          'Destination returned an invalid message TTL'
        );
      }

      const stats = await circleMigrationRepository.collectSourcePreflightStats(
        input.familyId,
        targetTtlHours
      );
      const maxMemberIdentities = numberOrNull(destination.limits?.maxMemberIdentities);
      const maxTotalIdentities = numberOrNull(destination.limits?.maxTotalIdentities);
      if (maxMemberIdentities !== null && stats.memberIdentityCount > maxMemberIdentities) {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_DESTINATION_LIMIT_EXCEEDED',
          `Circle has ${stats.memberIdentityCount} member identities; destination limit is ${maxMemberIdentities}`
        );
      }
      if (maxTotalIdentities !== null && stats.totalIdentityCount > maxTotalIdentities) {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_DESTINATION_LIMIT_EXCEEDED',
          `Circle has ${stats.totalIdentityCount} identities; destination limit is ${maxTotalIdentities}`
        );
      }
      const targetHost = new URL(targetPublicBaseUrl).host;
      if (
        (stats.publicSiteEnabled || stats.publicGuestLinkCount > 0)
        && isBlockedManagedHost(targetHost)
      ) {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_PUBLIC_SITE_DOMAIN_BLOCKED',
          'Target domain does not allow Public Circle Site publishing'
        );
      }

      const summary: Record<string, unknown> = {
        preflightStatus: 'ready',
        migrationBinding: {
          migrationSlotId: input.migrationSlotId,
          migrationId: migration.migration_id,
          familyId: input.familyId,
          ownerIdentityId: input.ownerIdentityId,
          sourceServerId,
          destinationServerId: destination.destinationServerId,
          sourceCircleId: config.circle_id,
          destinationCircleId: destination.destinationCircleId,
          oldPublicBaseUrl: sourceServerUrl,
          targetPublicBaseUrl,
          migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
          sourceSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
          destinationSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
          dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT
        },
        estimatedReadOnlySeconds: Math.max(60, Math.ceil(stats.estimatedTransferBytes / (5 * 1024 * 1024))),
        estimatedTransferBytes: stats.estimatedTransferBytes,
        targetMessageTtlHours: targetTtlHours,
        destinationSlotExpiresAt: destination.slotExpiresAt,
        excludedMessageCountByTargetTtl: stats.excludedMessageCountByTargetTtl,
        dataLossCounts: stats.dataLossCounts,
        dataLossByteSizes: stats.dataLossByteSizes,
        counts: stats.counts,
        byteSizes: stats.byteSizes,
        warnings: Object.keys(stats.dataLossCounts).length > 0
          ? ['The listed server-side data is not included in migration v1']
          : []
      };
      const completed = await circleMigrationRepository.completeSourcePreflight({
        migrationId: migration.migration_id,
        expectedStatus: 'preflight',
        destinationServerId: destination.destinationServerId,
        destinationPublicBaseUrl: targetPublicBaseUrl,
        sessionCredentialsEncrypted: encryptMigrationSecret(sessionCredentials),
        sessionExpiresAt,
        preflightSummary: summary
      });
      if (!completed) {
        throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration changed concurrently');
      }
      return { migration: completed, summary };
    } catch (error) {
      const failure = error instanceof CircleMigrationServiceError
        ? { code: error.code, message: error.message }
        : error instanceof CircleMigrationHttpError
          ? { code: 'MIGRATION_DESTINATION_REJECTED', message: error.message }
          : { code: 'MIGRATION_PREFLIGHT_FAILED', message: error instanceof Error ? error.message : 'Preflight failed' };
      await circleMigrationRepository.transitionSourceMigration(
        migration.migration_id,
        'preflight',
        'failed',
        failure
      ).catch(() => undefined);
      throw error;
    }
  }
}

export const circleMigrationPreflightService = new CircleMigrationPreflightService();
