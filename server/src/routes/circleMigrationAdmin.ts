import { routeLogger } from '../utils/routeLogger';
import { Router, type Response } from 'express';
import type { ApiResponse } from '../../../shared/types';
import {
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  getSignedPayload,
  type AuthRequest
} from '../middleware/auth';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import { circleMigrationPreflightService } from '../services/circleMigrationPreflightService';
import { CircleMigrationHttpError, postCircleMigrationJson } from '../services/circleMigrationHttpClient';
import { CircleMigrationServiceError } from '../services/circleMigrationSlotService';
import { circleMigrationScheduleService } from '../services/circleMigrationScheduleService';
import type { OwnerSignedMigrationIntent } from '../services/circleMigrationSlotService';
import { circleMigrationStartService } from '../services/circleMigrationStartService';
import { circleMigrationAbortService } from '../services/circleMigrationAbortService';
import {
  type OwnerSignedCutoverConfirmation
} from '../services/circleMigrationActivationService';
import { circleMigrationCutoverService } from '../services/circleMigrationCutoverService';
import { decryptMigrationSecret, type MigrationSessionCredentials } from '../services/circleMigrationCrypto';
import { refreshCircleMigrationSession } from '../services/circleMigrationTransferService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

const router: Router = Router();

function sendMigrationAdminError(res: Response, error: unknown) {
  if (error instanceof CircleMigrationServiceError) {
    return res.status(error.status).json({
      status: 'error',
      error: { code: error.code, message: error.message }
    } as ApiResponse);
  }
  if (error instanceof CircleMigrationHttpError) {
    return res.status(502).json({
      status: 'error',
      error: {
        code: 'MIGRATION_DESTINATION_REJECTED',
        message: error.message,
        details: error.responseBody
      }
    } as ApiResponse);
  }
  routeLogger.error('Circle migration admin error:', error);
  return res.status(500).json({
    status: 'error',
    error: {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Circle migration request failed'
    }
  } as ApiResponse);
}

router.post(
  '/preflight',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;
      const ownerIdentityId = req.identity?.identityId;
      if (!familyId || !ownerIdentityId) {
        throw new CircleMigrationServiceError(500, 'INTERNAL_ERROR', 'Circle identity context is missing');
      }
      const payload = getSignedPayload<Record<string, unknown>>(req);
      const result = await circleMigrationPreflightService.run({
        familyId,
        ownerIdentityId,
        destinationServiceEndpoint: String(payload.destinationServiceEndpoint || '').trim(),
        migrationSlotId: String(payload.migrationSlotId || '').trim(),
        migrationCode: String(payload.migrationCode || '').trim(),
        targetPublicBaseUrl: String(payload.targetPublicBaseUrl || '').trim()
      });
      return res.json({
        status: 'ok',
        result: {
          migrationId: result.migration.migration_id,
          ...result.summary
        }
      } as ApiResponse);
    } catch (error) {
      return sendMigrationAdminError(res, error);
    }
  }
);

router.post(
  '/schedule',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;
      const ownerIdentityId = req.identity?.identityId;
      if (!familyId || !ownerIdentityId) {
        throw new CircleMigrationServiceError(500, 'INTERNAL_ERROR', 'Circle identity context is missing');
      }
      const payload = getSignedPayload<Record<string, unknown>>(req);
      const migration = await circleMigrationScheduleService.schedule({
        familyId,
        ownerIdentityId,
        migrationId: String(payload.migrationId || '').trim(),
        scheduledAt: payload.scheduledAt,
        notifyMembers: payload.notifyMembers,
        confirmedDataLoss: (payload.confirmedDataLoss && typeof payload.confirmedDataLoss === 'object')
          ? payload.confirmedDataLoss as Record<string, unknown>
          : {},
        ownerSignedMigrationIntent: payload.ownerSignedMigrationIntent as OwnerSignedMigrationIntent
      });
      return res.json({
        status: 'ok',
        result: {
          migrationId: migration.migration_id,
          migrationStatus: migration.status,
          scheduledAt: migration.scheduled_at,
          membersNotifiedAt: migration.members_notified_at,
          destinationPublicBaseUrl: migration.destination_public_base_url
        }
      } as ApiResponse);
    } catch (error) {
      return sendMigrationAdminError(res, error);
    }
  }
);

router.post(
  '/start',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;
      const ownerIdentityId = req.identity?.identityId;
      if (!familyId || !ownerIdentityId) {
        throw new CircleMigrationServiceError(500, 'INTERNAL_ERROR', 'Circle identity context is missing');
      }
      const payload = getSignedPayload<Record<string, unknown>>(req);
      const migration = await circleMigrationStartService.start({
        familyId,
        ownerIdentityId,
        migrationId: String(payload.migrationId || '').trim()
      });
      return res.json({
        status: 'ok',
        result: {
          migrationId: migration.migration_id,
          migrationStatus: migration.status,
          exportSnapshotId: migration.export_snapshot_id,
          manifest: migration.manifest,
          targetPublicBaseUrl: migration.destination_public_base_url
        }
      } as ApiResponse);
    } catch (error) {
      return sendMigrationAdminError(res, error);
    }
  }
);

router.post(
  '/cutover',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;
      const ownerIdentityId = req.identity?.identityId;
      if (!familyId || !ownerIdentityId) {
        throw new CircleMigrationServiceError(500, 'INTERNAL_ERROR', 'Circle identity context is missing');
      }
      const payload = getSignedPayload<Record<string, unknown>>(req);
      const migration = await circleMigrationCutoverService.cutover({
        familyId,
        ownerIdentityId,
        migrationId: String(payload.migrationId || '').trim(),
        confirmation: payload.ownerSignedCutoverConfirmation as OwnerSignedCutoverConfirmation
      });
      return res.json({
        status: 'ok',
        result: {
          migrationId: migration.migration_id,
          migrationStatus: migration.status,
          targetPublicBaseUrl: migration.destination_public_base_url,
          ownerSignedMigrationProof: migration.owner_signed_cutover_confirmation,
          completedAt: migration.completed_at
        }
      } as ApiResponse);
    } catch (error) {
      return sendMigrationAdminError(res, error);
    }
  }
);

router.post(
  '/abort',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;
      const ownerIdentityId = req.identity?.identityId;
      if (!familyId || !ownerIdentityId) {
        throw new CircleMigrationServiceError(500, 'INTERNAL_ERROR', 'Circle identity context is missing');
      }
      const payload = getSignedPayload<Record<string, unknown>>(req);
      const migration = await circleMigrationAbortService.abort({
        familyId,
        ownerIdentityId,
        migrationId: String(payload.migrationId || '').trim(),
        reason: String(payload.reason || '').trim()
      });
      return res.json({
        status: 'ok',
        result: {
          migrationId: migration.migration_id,
          migrationStatus: migration.status,
          abortedAt: migration.completed_at
        }
      } as ApiResponse);
    } catch (error) {
      return sendMigrationAdminError(res, error);
    }
  }
);

router.post(
  '/status',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId) {
        throw new CircleMigrationServiceError(500, 'INTERNAL_ERROR', 'Circle context is missing');
      }
      const payload = getSignedPayload<Record<string, unknown>>(req);
      const migrationId = String(payload.migrationId || '').trim();
      const migration = await circleMigrationRepository.findSourceMigration(migrationId);
      if (!migration || migration.family_id !== familyId) {
        throw new CircleMigrationServiceError(404, 'MIGRATION_NOT_FOUND', 'Migration not found');
      }
      let destinationStatus: Record<string, unknown> | null = null;
      if (migration.session_credentials_encrypted && migration.destination_service_endpoint) {
        try {
          let credentials = decryptMigrationSecret<MigrationSessionCredentials>(
            migration.session_credentials_encrypted
          );
          ({ credentials } = await refreshCircleMigrationSession(migration, credentials));
          const remote = await postCircleMigrationJson<{
            status: 'ok';
            result: Record<string, unknown>;
          }>(
            migration.destination_service_endpoint,
            '/api/migration/import/status',
            { migrationSlotId: migration.migration_slot_id },
            { authorization: `MigrationSession ${credentials.sessionToken}` }
          );
          destinationStatus = remote?.status === 'ok' ? remote.result : null;
        } catch {
          // Local migration status remains useful when destination is temporarily unavailable.
        }
      }
      return res.json({
        status: 'ok',
        result: {
          migrationId: migration.migration_id,
          migrationSlotId: migration.migration_slot_id,
          familyId: migration.family_id,
          sourceServerId: getServerIdentityRuntimeConfig().vpsId,
          migrationStatus: migration.status,
          destinationPublicBaseUrl: migration.destination_public_base_url,
          destinationServerId: migration.destination_server_id,
          preflightSummary: migration.preflight_summary,
          manifest: migration.manifest,
          ownerSignedCutoverConfirmation: migration.owner_signed_cutover_confirmation,
          destinationStatus,
          failureCode: migration.failure_code,
          failureMessage: migration.failure_message,
          updatedAt: migration.updated_at
        }
      } as ApiResponse);
    } catch (error) {
      return sendMigrationAdminError(res, error);
    }
  }
);

export default router;
