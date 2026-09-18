import { circleMigrationRepository, type CircleMigrationRecord } from '../db/repositories/circleMigrationRepository';
import { familyConfigRepository } from '../db/repositories/familyConfigRepository';
import { familyDomainRepository } from '../db/repositories/familyDomainRepository';
import { identityRepository } from '../db/repositories/identityRepository';
import { normalizeHost } from '../middleware/tenancy';
import {
  canonicalizeCircleMigrationJson
} from './circleMigrationContract';
import {
  type OwnerSignedCutoverConfirmation,
  validateCutoverConfirmationAgainstBinding
} from './circleMigrationActivationService';
import {
  decryptMigrationSecret,
  type MigrationSessionCredentials
} from './circleMigrationCrypto';
import { postCircleMigrationJson } from './circleMigrationHttpClient';
import { CircleMigrationServiceError } from './circleMigrationSlotService';
import { refreshCircleMigrationSession } from './circleMigrationTransferService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

class CircleMigrationCutoverService {
  async cutover(input: {
    familyId: string;
    ownerIdentityId: string;
    migrationId: string;
    confirmation: OwnerSignedCutoverConfirmation;
  }): Promise<CircleMigrationRecord> {
    let migration = await circleMigrationRepository.findSourceMigration(input.migrationId);
    if (!migration || migration.family_id !== input.familyId) {
      throw new CircleMigrationServiceError(404, 'MIGRATION_NOT_FOUND', 'Migration not found');
    }
    const [config, owner, currentDomain] = await Promise.all([
      familyConfigRepository.findByFamilyId(input.familyId),
      identityRepository.findByIdentityId(input.familyId, input.ownerIdentityId),
      familyDomainRepository.findCurrentByFamilyId(input.familyId)
    ]);
    if (
      !config
      || config.status !== 'active'
      || config.owner_identity_id !== input.ownerIdentityId
      || !owner
      || owner.status !== 'active'
      || owner.role !== 'owner'
      || owner.public_key_algorithm !== 'ed25519'
      || !currentDomain
      || !migration.destination_server_id
      || !migration.manifest
    ) {
      throw new CircleMigrationServiceError(403, 'FORBIDDEN', 'Only the active Circle owner can confirm cutover');
    }
    if (!['waiting_cutover', 'cutover', 'failed'].includes(migration.status)) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration cannot cut over from ${migration.status}`);
    }
    const storedConfirmation = migration.owner_signed_cutover_confirmation;
    if (
      storedConfirmation
      && canonicalizeCircleMigrationJson(storedConfirmation)
        !== canonicalizeCircleMigrationJson(input.confirmation)
    ) {
      throw new CircleMigrationServiceError(
        409,
        'MIGRATION_OWNER_PROOF_INVALID',
        'Cutover retry uses another owner confirmation'
      );
    }
    validateCutoverConfirmationAgainstBinding({
      migrationSlotId: migration.migration_slot_id,
      migrationId: migration.migration_id,
      familyId: migration.family_id,
      ownerIdentityId: input.ownerIdentityId,
      sourceServerId: getServerIdentityRuntimeConfig().vpsId,
      destinationServerId: migration.destination_server_id,
      sourceCircleId: config.circle_id,
      destinationCircleId: String(
        (migration.preflight_summary?.migrationBinding as Record<string, unknown> | undefined)?.destinationCircleId || ''
      ),
      oldPublicBaseUrl: currentDomain.public_base_url,
      targetPublicBaseUrl: migration.destination_public_base_url,
      manifest: migration.manifest,
      ownerPublicKey: {
        algorithm: owner.public_key_algorithm as 'ed25519',
        value: owner.public_key_value
      }
    }, input.confirmation, { requireFresh: !storedConfirmation });

    if (migration.status !== 'cutover') {
      const cutover = await circleMigrationRepository.beginSourceCutover({
        migrationId: migration.migration_id,
        ownerSignedCutoverConfirmation: input.confirmation as unknown as Record<string, unknown>
      });
      if (!cutover) {
        throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration changed concurrently before cutover');
      }
      migration = cutover;
    }

    let credentials = decryptMigrationSecret<MigrationSessionCredentials>(
      migration.session_credentials_encrypted
    );
    ({ credentials } = await refreshCircleMigrationSession(migration, credentials));
    const activated = await postCircleMigrationJson<{
      status: 'ok';
      result: {
        migrationSlotId: string;
        slotStatus: string;
        importedFamilyId: string;
        ownerSignedCutoverConfirmation: Record<string, unknown>;
        activationReport: Record<string, unknown>;
      };
    }>(
      migration.destination_service_endpoint,
      '/api/migration/import/activate',
      {
        migrationSlotId: migration.migration_slot_id,
        activationMode: 'new_domain',
        ownerSignedCutoverConfirmation: input.confirmation
      },
      { authorization: `MigrationSession ${credentials.sessionToken}` }
    );
    if (
      activated?.status !== 'ok'
      || activated.result?.migrationSlotId !== migration.migration_slot_id
      || activated.result?.slotStatus !== 'active'
      || activated.result?.importedFamilyId !== migration.family_id
      || canonicalizeCircleMigrationJson(activated.result?.ownerSignedCutoverConfirmation)
        !== canonicalizeCircleMigrationJson(input.confirmation)
    ) {
      throw new Error('Destination did not confirm Circle activation');
    }

    const movedAt = new Date(input.confirmation.payload.movedAt);
    const bridgeExpiresAt = new Date(input.confirmation.payload.bridgeExpiresAt);
    const destinationServerId = migration.destination_server_id;
    if (!destinationServerId) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Destination server id is missing');
    }
    const migrated = await circleMigrationRepository.completeSourceCutover({
      migrationId: migration.migration_id,
      familyId: migration.family_id,
      oldHost: normalizeHost(new URL(currentDomain.public_base_url).host),
      targetPublicBaseUrl: migration.destination_public_base_url,
      sourceServerId: getServerIdentityRuntimeConfig().vpsId,
      destinationServerId,
      ownerIdentityId: input.ownerIdentityId,
      ownerPublicKey: {
        algorithm: owner.public_key_algorithm,
        value: owner.public_key_value
      },
      ownerSignedMigrationProof: input.confirmation as unknown as Record<string, unknown>,
      movedAt,
      bridgeExpiresAt
    });
    if (!migrated) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Source migration changed concurrently during cutover');
    }
    return migrated;
  }
}

export const circleMigrationCutoverService = new CircleMigrationCutoverService();
