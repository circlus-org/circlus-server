import { routeLogger } from '../utils/routeLogger';
import { Router, type Request, type Response } from 'express';
import { createRateLimiter, ipKey } from '../middleware/rateLimit';
import {
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FIXED_SCOPES,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
} from '../services/circleMigrationContract';
import {
  CircleMigrationServiceError,
  circleMigrationSlotService,
  type OwnerSignedMigrationIntent
} from '../services/circleMigrationSlotService';
import { circleMigrationImportService } from '../services/circleMigrationImportService';
import { circleMigrationPendingImportService } from '../services/circleMigrationPendingImportService';
import type { EncryptedMigrationChunk } from '../services/circleMigrationCrypto';
import {
  circleMigrationActivationService,
  type OwnerSignedCutoverConfirmation
} from '../services/circleMigrationActivationService';
import { getRequestHost } from '../middleware/tenancy';
import { circleMigrationDestinationAbortService } from '../services/circleMigrationDestinationAbortService';
import {
  getRateLimitRuntimeConfig,
  getServerIdentityRuntimeConfig
} from '../config/serverRuntimeConfig';

const router: Router = Router();
const migrationRateLimits = getRateLimitRuntimeConfig().circleMigration;

router.use((req, res, next) => {
  if (getServerIdentityRuntimeConfig().nodeEnvironment === 'production' && !req.secure) {
    res.status(426).json({
      status: 'error',
      error: {
        code: 'MIGRATION_HTTPS_REQUIRED',
        message: 'Circle migration service endpoints require HTTPS'
      }
    });
    return;
  }
  next();
});

const verifyLimiter = createRateLimiter({
  name: 'circle-migration:verify',
  windowMs: migrationRateLimits.verify.windowMs,
  max: migrationRateLimits.verify.max,
  keyFn: ipKey
});

const sessionLimiter = createRateLimiter({
  name: 'circle-migration:session',
  windowMs: migrationRateLimits.session.windowMs,
  max: migrationRateLimits.session.max,
  keyFn: ipKey
});

function readSessionToken(req: Request): string {
  const authorization = String(req.get('authorization') || '').trim();
  const match = /^MigrationSession\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || '';
}

function sendMigrationError(res: Response, error: unknown) {
  if (error instanceof CircleMigrationServiceError) {
    return res.status(error.status).json({
      status: 'error',
      error: { code: error.code, message: error.message }
    });
  }
  routeLogger.error('Circle migration endpoint error:', error);
  return res.status(500).json({
    status: 'error',
    error: { code: 'INTERNAL_ERROR', message: 'Circle migration request failed' }
  });
}

router.post('/slots/verify', verifyLimiter, async (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const result = await circleMigrationSlotService.verifySlot({
      migrationSlotId: String(payload.migrationSlotId || '').trim(),
      migrationId: String(payload.migrationId || '').trim(),
      migrationCode: String(payload.migrationCode || '').trim(),
      sourceServerUrl: String(payload.sourceServerUrl || '').trim(),
      sourceServerId: String(payload.sourceServerId || '').trim(),
      sourceCircleId: String(payload.sourceCircleId || '').trim(),
      familyId: String(payload.familyId || '').trim(),
      ownerIdentityId: String(payload.ownerIdentityId || '').trim(),
      ownerIdentityPublicKey: payload.ownerIdentityPublicKey,
      sourceSessionPublicKey: payload.sourceSessionPublicKey,
      migrationFormatVersion: payload.migrationFormatVersion,
      sourceSchemaFingerprint: payload.sourceSchemaFingerprint,
      dataScopeFingerprint: payload.dataScopeFingerprint
    });
    return res.json({
      status: 'ok',
      result: {
        slotStatus: result.slot.status,
        targetPublicBaseUrl: result.slot.target_public_base_url,
        destinationServerId: getServerIdentityRuntimeConfig().vpsId,
        destinationCircleId: result.slot.destination_circle_id,
        acceptedDataScopes: CIRCLE_MIGRATION_FIXED_SCOPES,
        migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
        schemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
        dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
        limits: result.slot.limits,
        policies: result.slot.settings,
        sessionKeyEnvelope: result.sessionKeyEnvelope,
        sessionExpiresAt: result.slot.session_expires_at?.toISOString() || null,
        slotExpiresAt: result.slot.expires_at.toISOString()
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.post('/slots/reserve', sessionLimiter, async (req, res) => {
  try {
    const payload = req.body as {
      migrationSlotId?: unknown;
      familyId?: unknown;
      preflightSummary?: Record<string, unknown>;
      ownerSignedMigrationIntent?: OwnerSignedMigrationIntent;
    };
    const sessionToken = readSessionToken(req);
    if (!sessionToken) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is required');
    }
    const slot = await circleMigrationSlotService.reserveSlot({
      migrationSlotId: String(payload.migrationSlotId || '').trim(),
      familyId: String(payload.familyId || '').trim(),
      sessionToken,
      preflightSummary: payload.preflightSummary || {},
      ownerSignedMigrationIntent: payload.ownerSignedMigrationIntent as OwnerSignedMigrationIntent
    });
    return res.json({
      status: 'ok',
      result: {
        migrationSlotId: slot.migration_slot_id,
        slotStatus: slot.status,
        targetPublicBaseUrl: slot.target_public_base_url,
        reservedAt: slot.reserved_at?.toISOString() || null
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.post('/session/refresh', verifyLimiter, async (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const result = await circleMigrationSlotService.refreshSession({
      migrationSlotId: String(payload.migrationSlotId || '').trim(),
      sessionKey: String(payload.sessionKey || '')
    });
    return res.json({
      status: 'ok',
      result: {
        sessionToken: result.sessionToken,
        sessionExpiresAt: result.slot.session_expires_at?.toISOString() || null
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.get('/slots/:migrationSlotId/status', sessionLimiter, async (req, res) => {
  try {
    const sessionToken = readSessionToken(req);
    if (!sessionToken) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is required');
    }
    const slot = await circleMigrationSlotService.authenticateSession(
      String(req.params.migrationSlotId || ''),
      sessionToken
    );
    return res.json({
      status: 'ok',
      result: {
        migrationSlotId: slot.migration_slot_id,
        slotStatus: slot.status,
        targetPublicBaseUrl: slot.target_public_base_url,
        expectedFamilyId: slot.expected_family_id,
        failureCode: slot.failure_code,
        failureMessage: slot.failure_message,
        importedFamilyId: slot.imported_family_id,
        importReport: slot.import_report,
        activationReport: slot.activation_report,
        updatedAt: slot.updated_at
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.post('/import/status', sessionLimiter, async (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const sessionToken = readSessionToken(req);
    if (!sessionToken) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is required');
    }
    const slot = await circleMigrationSlotService.authenticateSession(
      String(payload.migrationSlotId || '').trim(),
      sessionToken
    );
    return res.json({
      status: 'ok',
      result: {
        migrationSlotId: slot.migration_slot_id,
        slotStatus: slot.status,
        targetPublicBaseUrl: slot.target_public_base_url,
        expectedFamilyId: slot.expected_family_id,
        failureCode: slot.failure_code,
        failureMessage: slot.failure_message,
        importedFamilyId: slot.imported_family_id,
        importReport: slot.import_report,
        activationReport: slot.activation_report,
        updatedAt: slot.updated_at
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.post('/import/start', sessionLimiter, async (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const sessionToken = readSessionToken(req);
    if (!sessionToken) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is required');
    }
    const slot = await circleMigrationSlotService.authenticateSession(
      String(payload.migrationSlotId || '').trim(),
      sessionToken
    );
    const importing = await circleMigrationImportService.start(slot, payload.manifest);
    return res.json({
      status: 'ok',
      result: {
        migrationSlotId: importing.migration_slot_id,
        slotStatus: importing.status,
        importStartedAt: importing.import_started_at
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.post('/import/chunk', sessionLimiter, async (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const sessionToken = readSessionToken(req);
    if (!sessionToken) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is required');
    }
    const migrationSlotId = String(payload.migrationSlotId || '').trim();
    const slot = await circleMigrationSlotService.authenticateSession(migrationSlotId, sessionToken);
    await circleMigrationImportService.uploadChunk(slot, {
      filePath: String(payload.filePath || ''),
      chunkIndex: Number(payload.chunkIndex),
      chunkCount: Number(payload.chunkCount),
      encrypted: payload.encrypted as EncryptedMigrationChunk
    });
    return res.json({
      status: 'ok',
      result: {
        migrationSlotId,
        filePath: payload.filePath,
        chunkIndex: payload.chunkIndex,
        received: true
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.post('/import/complete', sessionLimiter, async (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const sessionToken = readSessionToken(req);
    if (!sessionToken) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is required');
    }
    const slot = await circleMigrationSlotService.authenticateSession(
      String(payload.migrationSlotId || '').trim(),
      sessionToken
    );
    const imported = await circleMigrationImportService.complete(slot);
    return res.json({
      status: 'ok',
      result: {
        migrationSlotId: imported.migration_slot_id,
        slotStatus: imported.status,
        importReport: imported.import_report
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.post('/import/apply', sessionLimiter, async (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const sessionToken = readSessionToken(req);
    if (!sessionToken) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is required');
    }
    const slot = await circleMigrationSlotService.authenticateSession(
      String(payload.migrationSlotId || '').trim(),
      sessionToken
    );
    const waiting = await circleMigrationPendingImportService.apply(slot);
    return res.json({
      status: 'ok',
      result: {
        migrationSlotId: waiting.migration_slot_id,
        slotStatus: waiting.status,
        importedFamilyId: waiting.imported_family_id,
        importReport: waiting.import_report
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.post('/import/activate', sessionLimiter, async (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const sessionToken = readSessionToken(req);
    if (!sessionToken) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is required');
    }
    if (payload.activationMode !== 'new_domain') {
      throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'Only new_domain activation is supported');
    }
    const slot = await circleMigrationSlotService.authenticateSession(
      String(payload.migrationSlotId || '').trim(),
      sessionToken
    );
    const active = await circleMigrationActivationService.activate({
      slot,
      serviceRequestHost: getRequestHost(req),
      confirmation: payload.ownerSignedCutoverConfirmation as OwnerSignedCutoverConfirmation
    });
    return res.json({
      status: 'ok',
      result: {
        migrationSlotId: active.migration_slot_id,
        slotStatus: active.status,
        importedFamilyId: active.imported_family_id,
        ownerSignedCutoverConfirmation: active.owner_signed_cutover_confirmation,
        activationReport: active.activation_report
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

router.post('/import/abort', sessionLimiter, async (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const sessionToken = readSessionToken(req);
    if (!sessionToken) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is required');
    }
    const slot = await circleMigrationSlotService.authenticateSession(
      String(payload.migrationSlotId || '').trim(),
      sessionToken
    );
    const aborted = await circleMigrationDestinationAbortService.abort(
      slot,
      String(payload.reason || '')
    );
    return res.json({
      status: 'ok',
      result: {
        migrationSlotId: aborted.migration_slot_id,
        slotStatus: aborted.status,
        importedFamilyId: aborted.imported_family_id
      }
    });
  } catch (error) {
    return sendMigrationError(res, error);
  }
});

export default router;
