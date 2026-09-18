import { query } from '../db';
import { circleMigrationRepository, type CircleMigrationRecord } from '../db/repositories/circleMigrationRepository';
import { familyConfigRepository } from '../db/repositories/familyConfigRepository';
import { identityRepository } from '../db/repositories/identityRepository';
import {
  activateCircleFreeze,
  updateCircleFreezeStatus,
  waitForCircleRequestsToDrain
} from '../middleware/circleMigrationFreeze';
import { drainFamilySocketsForMigration } from '../ws/wsGateway';
import { circleMigrationExportService } from './circleMigrationExportService';
import { CircleMigrationServiceError } from './circleMigrationSlotService';
import { circleMigrationTransferService } from './circleMigrationTransferService';

function freezeState(migration: CircleMigrationRecord, status = migration.status) {
  return {
    migrationId: migration.migration_id,
    migrationStatus: status,
    targetPublicBaseUrl: migration.destination_public_base_url
  };
}

async function assertActiveOwner(
  migration: CircleMigrationRecord,
  familyId: string,
  ownerIdentityId: string
): Promise<void> {
  const [config, owner] = await Promise.all([
    familyConfigRepository.findByFamilyId(familyId),
    identityRepository.findByIdentityId(familyId, ownerIdentityId)
  ]);
  if (
    migration.family_id !== familyId
    || !config
    || config.status !== 'active'
    || config.owner_identity_id !== ownerIdentityId
    || !owner
    || owner.status !== 'active'
    || owner.role !== 'owner'
  ) {
    throw new CircleMigrationServiceError(403, 'FORBIDDEN', 'Only the active Circle owner can start migration');
  }
}

class CircleMigrationStartService {
  async start(input: {
    familyId: string;
    ownerIdentityId: string;
    migrationId: string;
  }): Promise<CircleMigrationRecord> {
    const existing = activeMigrationStarts.get(input.migrationId);
    if (existing) return existing;
    const running = this.run(input);
    activeMigrationStarts.set(input.migrationId, running);
    try {
      return await running;
    } finally {
      if (activeMigrationStarts.get(input.migrationId) === running) {
        activeMigrationStarts.delete(input.migrationId);
      }
    }
  }

  private async run(input: {
    familyId: string;
    ownerIdentityId: string;
    migrationId: string;
  }): Promise<CircleMigrationRecord> {
    let migration = await circleMigrationRepository.findSourceMigration(input.migrationId);
    if (!migration) {
      throw new CircleMigrationServiceError(404, 'MIGRATION_NOT_FOUND', 'Migration not found');
    }
    await assertActiveOwner(migration, input.familyId, input.ownerIdentityId);
    if (migration.status === 'waiting_cutover') return migration;
    if (migration.status === 'scheduled' && migration.scheduled_at && migration.scheduled_at.getTime() > Date.now() + 30_000) {
      throw new CircleMigrationServiceError(
        409,
        'MIGRATION_NOT_SCHEDULED_YET',
        `Migration is scheduled for ${migration.scheduled_at.toISOString()}`
      );
    }
    if (
      !['scheduled', 'freezing', 'frozen', 'exporting', 'transferring', 'waiting_import', 'failed'].includes(migration.status)
      || (migration.status === 'failed' && !migration.freeze_started_at)
    ) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration cannot start from ${migration.status}`);
    }

    activateCircleFreeze(input.familyId, freezeState(migration, 'freezing'));
    let failurePhase: string = migration.status;
    try {
      if (migration.status === 'scheduled') {
        const freezing = await circleMigrationRepository.transitionSourceMigration(
          migration.migration_id,
          'scheduled',
          'freezing'
        );
        if (!freezing) throw new Error('Migration changed concurrently before freeze');
        migration = freezing;
      }

      if (migration.status === 'freezing' || migration.status === 'failed') {
        failurePhase = migration.status;
        updateCircleFreezeStatus(input.familyId, 'freezing');
        await drainFamilySocketsForMigration(input.familyId, {
          migrationId: migration.migration_id,
          targetPublicBaseUrl: migration.destination_public_base_url
        });
        await waitForCircleRequestsToDrain(input.familyId);
        await query(
          `UPDATE call_sessions
              SET state = 'ended',
                  ended_at = COALESCE(ended_at, NOW())
            WHERE family_id = $1::uuid
              AND state IN ('new', 'ringing', 'accepted', 'connecting', 'active')`,
          [input.familyId]
        );

        if (migration.status === 'freezing') {
          const frozen = await circleMigrationRepository.transitionSourceMigration(
            migration.migration_id,
            'freezing',
            'frozen'
          );
          if (!frozen) throw new Error('Migration changed concurrently while freezing');
          migration = frozen;
        }
      }

      if (migration.status === 'frozen') {
        failurePhase = 'frozen';
        updateCircleFreezeStatus(input.familyId, 'frozen');
        const exporting = await circleMigrationRepository.transitionSourceMigration(
          migration.migration_id,
          'frozen',
          'exporting'
        );
        if (!exporting) throw new Error('Migration changed concurrently before export');
        migration = exporting;
      } else if (migration.status === 'failed') {
        failurePhase = 'failed';
        const retryStatus = migration.manifest && migration.export_snapshot_id
          ? 'transferring'
          : 'exporting';
        const retried = await circleMigrationRepository.transitionSourceMigration(
          migration.migration_id,
          'failed',
          retryStatus
        );
        if (!retried) throw new Error('Migration changed concurrently before retry');
        migration = retried;
      }

      if (migration.status === 'exporting') {
        failurePhase = 'exporting';
        updateCircleFreezeStatus(input.familyId, 'exporting');
        const exported = await circleMigrationExportService.export(migration);
        const completed = await circleMigrationRepository.completeSourceExport({
          migrationId: migration.migration_id,
          snapshotId: exported.snapshotId,
          manifest: exported.manifest
        });
        if (!completed) throw new Error('Migration changed concurrently after export');
        migration = completed;
      }
      if (migration.status === 'transferring') {
        failurePhase = 'transferring';
        updateCircleFreezeStatus(input.familyId, 'transferring');
        migration = await circleMigrationTransferService.transfer(migration);
      }
      if (migration.status === 'waiting_import') {
        failurePhase = 'waiting_import';
        updateCircleFreezeStatus(input.familyId, 'waiting_import');
        migration = await circleMigrationTransferService.completePendingImport(migration);
      }
      updateCircleFreezeStatus(input.familyId, migration.status);
      return migration;
    } catch (error) {
      const latest = await circleMigrationRepository.findSourceMigration(input.migrationId).catch(() => null);
      if (latest && ['freezing', 'frozen', 'exporting', 'transferring', 'waiting_import'].includes(latest.status)) {
        await circleMigrationRepository.transitionSourceMigration(
          latest.migration_id,
          latest.status as 'freezing' | 'frozen' | 'exporting' | 'transferring' | 'waiting_import',
          'failed',
          {
            code: failurePhase === 'transferring' || failurePhase === 'waiting_import'
              ? 'MIGRATION_TRANSFER_FAILED'
              : 'MIGRATION_EXPORT_FAILED',
            message: error instanceof Error ? error.message : `Migration failed during ${failurePhase}`
          }
        ).catch(() => undefined);
      }
      updateCircleFreezeStatus(input.familyId, 'failed');
      throw error;
    }
  }
}

const activeMigrationStarts = new Map<string, Promise<CircleMigrationRecord>>();
export async function waitForActiveCircleMigrationStart(migrationId: string): Promise<void> {
  const active = activeMigrationStarts.get(migrationId);
  if (!active) return;
  await active.catch(() => undefined);
}
export const circleMigrationStartService = new CircleMigrationStartService();
