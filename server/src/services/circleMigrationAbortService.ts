import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import { familyConfigRepository } from '../db/repositories/familyConfigRepository';
import { identityRepository } from '../db/repositories/identityRepository';
import { deactivateCircleFreeze } from '../middleware/circleMigrationFreeze';
import { removeCircleMigrationExport } from './circleMigrationExportService';
import { CircleMigrationServiceError } from './circleMigrationSlotService';
import { waitForActiveCircleMigrationStart } from './circleMigrationStartService';
import {
  decryptMigrationSecret,
  type MigrationSessionCredentials
} from './circleMigrationCrypto';
import { refreshCircleMigrationSession } from './circleMigrationTransferService';
import { postCircleMigrationJson } from './circleMigrationHttpClient';

class CircleMigrationAbortService {
  async abort(input: {
    familyId: string;
    ownerIdentityId: string;
    migrationId: string;
    reason: string;
  }) {
    if (!input.reason.trim()) {
      throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'Abort reason is required');
    }
    await waitForActiveCircleMigrationStart(input.migrationId);
    const migration = await circleMigrationRepository.findSourceMigration(input.migrationId);
    if (!migration || migration.family_id !== input.familyId) {
      throw new CircleMigrationServiceError(404, 'MIGRATION_NOT_FOUND', 'Migration not found');
    }
    const [config, owner] = await Promise.all([
      familyConfigRepository.findByFamilyId(input.familyId),
      identityRepository.findByIdentityId(input.familyId, input.ownerIdentityId)
    ]);
    if (
      !config
      || config.owner_identity_id !== input.ownerIdentityId
      || !owner
      || owner.status !== 'active'
      || owner.role !== 'owner'
    ) {
      throw new CircleMigrationServiceError(403, 'FORBIDDEN', 'Only the active Circle owner can abort migration');
    }
    if (migration.status === 'aborted') {
      deactivateCircleFreeze(input.familyId);
      return migration;
    }
    if (
      ![
        'draft',
        'preflight',
        'ready',
        'scheduled',
        'freezing',
        'frozen',
        'exporting',
        'transferring',
        'waiting_import',
        'waiting_cutover',
        'failed'
      ].includes(migration.status)
    ) {
      throw new CircleMigrationServiceError(
        409,
        'INVALID_STATE',
        `Migration cannot be aborted from ${migration.status}`
      );
    }
    if (migration.session_credentials_encrypted) {
      let credentials = decryptMigrationSecret<Partial<MigrationSessionCredentials>>(
        migration.session_credentials_encrypted
      );
      // A failed/draft preflight may contain only the one-time X25519 bootstrap
      // secret. No destination import can exist before session credentials and
      // reserve, so local abort is sufficient in that state.
      if (typeof credentials.sessionKey === 'string' && typeof credentials.sessionToken === 'string') {
        let authenticatedCredentials = credentials as MigrationSessionCredentials;
        ({ credentials: authenticatedCredentials } = await refreshCircleMigrationSession(
          migration,
          authenticatedCredentials
        ));
        const destination = await postCircleMigrationJson<{
          status: 'ok';
          result: { migrationSlotId: string; slotStatus: string };
        }>(
          migration.destination_service_endpoint,
          '/api/migration/import/abort',
          {
            migrationSlotId: migration.migration_slot_id,
            reason: input.reason.trim()
          },
          { authorization: `MigrationSession ${authenticatedCredentials.sessionToken}` }
        );
        if (
          destination?.status !== 'ok'
          || destination.result?.migrationSlotId !== migration.migration_slot_id
          || destination.result?.slotStatus !== 'aborted'
        ) {
          throw new Error('Destination did not confirm migration abort');
        }
      }
    }
    const aborted = await circleMigrationRepository.transitionSourceMigration(
      migration.migration_id,
      migration.status,
      'aborted',
      { code: 'MIGRATION_ABORTED_BY_OWNER', message: input.reason.trim().slice(0, 500) }
    );
    if (!aborted) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration changed concurrently');
    }
    deactivateCircleFreeze(input.familyId);
    await removeCircleMigrationExport(input.migrationId);
    return aborted;
  }
}

export const circleMigrationAbortService = new CircleMigrationAbortService();
