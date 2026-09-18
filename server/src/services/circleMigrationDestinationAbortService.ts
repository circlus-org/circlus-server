import type { MigrationSlotRecord } from '../db/repositories/circleMigrationRepository';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import { removeCircleMigrationStaging } from './circleMigrationImportService';
import { CircleMigrationServiceError } from './circleMigrationSlotService';

class CircleMigrationDestinationAbortService {
  async abort(slot: MigrationSlotRecord, reason: string): Promise<MigrationSlotRecord> {
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'Abort reason is required');
    }
    if (slot.status === 'active' || slot.status === 'activating') {
      throw new CircleMigrationServiceError(
        409,
        'INVALID_STATE',
        `Migration slot cannot be aborted from ${slot.status}`
      );
    }
    let aborted = slot;
    if (slot.status !== 'aborted') {
      const updated = await circleMigrationRepository.abortSlotImport({
        migrationSlotId: slot.migration_slot_id,
        reason: normalizedReason
      });
      if (!updated) {
        throw new CircleMigrationServiceError(
          409,
          'INVALID_STATE',
          `Migration slot cannot be aborted from ${slot.status}`
        );
      }
      aborted = updated;
    }
    await removeCircleMigrationStaging(aborted);
    return aborted;
  }
}

export const circleMigrationDestinationAbortService = new CircleMigrationDestinationAbortService();
