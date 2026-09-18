import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router, type NextFunction, type Response } from 'express';
import { messageArchiveRepository } from '../db/repositories';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import { configService } from '../services/configService';
import {
  getEffectiveMessageArchivePolicy,
  isMessageArchiveModeAllowed,
  normalizeMessageArchivePolicyMode
} from '../utils/messageArchivePolicy';

const router = Router();

function err(code: ErrorCode, message: string): ApiResponse {
  return { status: 'error', error: { code, message } };
}

function requireTrustedDevice(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.device?.accessLevel === 'temporary') {
    res.status(403).json(err('FORBIDDEN' as ErrorCode, 'Temporary devices cannot access message archives'));
    return;
  }
  next();
}

function toJobResponse(job: Awaited<ReturnType<typeof messageArchiveRepository.findJob>>) {
  if (!job) return null;
  return {
    archiveId: job.archive_id,
    ownerIdentityId: job.owner_identity_id,
    writerDeviceId: job.writer_device_id,
    destinationType: job.destination_type,
    destinationConfig: job.destination_config,
    mode: job.mode,
    wrappedArchiveKey: job.wrapped_archive_key,
    archiveKeyVersion: job.archive_key_version,
    encryptedManifest: job.encrypted_manifest,
    manifestRevision: job.manifest_revision,
    status: job.status,
    lastArchivedAt: job.last_archived_at?.toISOString() ?? null,
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString()
  };
}

function normalizeLimit(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 100;
  return Math.max(1, Math.min(parsed, 500));
}

router.post('/job/get', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device!.identityId;
    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Family context is missing'));

    const job = await messageArchiveRepository.findJob(familyId, identityId);
    return res.json({ status: 'ok', result: { job: toJobResponse(job) } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Message archive job get error:', error);
    return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Internal server error'));
  }
});

router.post('/job/enable', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device!.identityId;
    const deviceId = req.device!.deviceId;
    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Family context is missing'));

    const payload = req.signedRequest!.payload as {
      destinationType?: string;
      mode?: string;
      wrappedArchiveKey?: unknown;
      encryptedManifest?: unknown;
    };

    if (payload.destinationType && payload.destinationType !== 'circle') {
      return res.status(400).json(err('UNSUPPORTED_FEATURE', 'Only circle archive destination is supported'));
    }
    if (payload.mode && payload.mode !== 'text') {
      return res.status(400).json(err('UNSUPPORTED_FEATURE', 'Only text message archives are supported'));
    }
    if (!payload.wrappedArchiveKey) {
      return res.status(400).json(err('INVALID_STATE', 'wrappedArchiveKey is required'));
    }
    const config = await configService.getFamilyConfig(familyId);
    const policy = getEffectiveMessageArchivePolicy(config);
    const requestedMode = normalizeMessageArchivePolicyMode(payload.mode || 'text');
    if (policy.circlePolicy === 'disabled') {
      return res.status(403).json(err('FORBIDDEN', 'Message archive is disabled by circle policy'));
    }
    if (!isMessageArchiveModeAllowed({ requested: requestedMode, allowed: policy.circlePolicy })) {
      return res.status(403).json(err('FORBIDDEN', 'Requested archive mode is not allowed by circle policy'));
    }

    const existing = await messageArchiveRepository.findJob(familyId, identityId);
    if (existing) {
      if (existing.writer_device_id !== deviceId) {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'INVALID_STATE' as ErrorCode,
            message: 'Message archive already has a writer device'
          },
          result: { job: toJobResponse(existing) }
        } as ApiResponse);
      }
      return res.json({ status: 'ok', result: { job: toJobResponse(existing) } } as ApiResponse);
    }

    const created = await messageArchiveRepository.createJob({
      familyId,
      ownerIdentityId: identityId,
      writerDeviceId: deviceId,
      wrappedArchiveKey: payload.wrappedArchiveKey,
      encryptedManifest: payload.encryptedManifest ?? null
    });

    return res.json({ status: 'ok', result: { job: toJobResponse(created) } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Message archive job enable error:', error);
    return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Internal server error'));
  }
});

router.post('/job/manifest', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedDevice, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device!.identityId;
    const deviceId = req.device!.deviceId;
    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Family context is missing'));

    const payload = req.signedRequest!.payload as {
      archiveId?: string;
      expectedRevision?: number;
      encryptedManifest?: unknown;
      lastArchivedAt?: string | null;
    };

    if (!payload.archiveId || typeof payload.expectedRevision !== 'number' || !payload.encryptedManifest) {
      return res.status(400).json(err('INVALID_STATE', 'archiveId, expectedRevision and encryptedManifest are required'));
    }

    const updated = await messageArchiveRepository.updateManifest({
      familyId,
      archiveId: payload.archiveId,
      ownerIdentityId: identityId,
      writerDeviceId: deviceId,
      expectedRevision: payload.expectedRevision,
      encryptedManifest: payload.encryptedManifest,
      lastArchivedAt: payload.lastArchivedAt ? new Date(payload.lastArchivedAt) : null
    });

    if (!updated) {
      const current = await messageArchiveRepository.findJob(familyId, identityId);
      if (current && current.writer_device_id !== deviceId) {
        return res.status(403).json(err('FORBIDDEN', 'Only the archive writer device can update the manifest'));
      }
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Archive manifest revision conflict' },
        result: { job: toJobResponse(current) }
      } as ApiResponse);
    }

    return res.json({ status: 'ok', result: { job: toJobResponse(updated) } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Message archive manifest update error:', error);
    return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Internal server error'));
  }
}));

router.post('/job/writer', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device!.identityId;
    const deviceId = req.device!.deviceId;
    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Family context is missing'));

    const payload = req.signedRequest!.payload as { archiveId?: string };
    if (!payload.archiveId) {
      return res.status(400).json(err('INVALID_STATE', 'archiveId is required'));
    }

    const job = await messageArchiveRepository.findJob(familyId, identityId);
    if (!job || job.archive_id !== payload.archiveId) {
      return res.status(404).json(err('NOT_FOUND', 'Archive job not found'));
    }
    if (!job.wrapped_archive_key || !job.encrypted_manifest) {
      return res.status(409).json(err('INVALID_STATE', 'Archive key or manifest is missing'));
    }

    const updated = await messageArchiveRepository.updateWriterDevice({
      familyId,
      archiveId: job.archive_id,
      ownerIdentityId: identityId,
      nextWriterDeviceId: deviceId
    });

    return res.json({ status: 'ok', result: { job: toJobResponse(updated) } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Message archive writer update error:', error);
    return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Internal server error'));
  }
});

router.post('/job/disable', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device!.identityId;
    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Family context is missing'));

    const payload = req.signedRequest!.payload as { archiveId?: string };
    if (!payload.archiveId) {
      return res.status(400).json(err('INVALID_STATE', 'archiveId is required'));
    }

    const disabled = await messageArchiveRepository.disableJob({
      familyId,
      archiveId: payload.archiveId,
      ownerIdentityId: identityId
    });

    return res.json({ status: 'ok', result: { job: toJobResponse(disabled) } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Message archive job disable error:', error);
    return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Internal server error'));
  }
});

router.post('/segments/put', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedDevice, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device!.identityId;
    const deviceId = req.device!.deviceId;
    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Family context is missing'));

    const payload = req.signedRequest!.payload as {
      archiveId?: string;
      periodKey?: string;
      expectedRevision?: number | null;
      periodStartedAt?: string | null;
      periodEndedAt?: string | null;
      messageCount?: number;
      byteSize?: number;
      encryptedSegment?: unknown;
    };

    if (payload.expectedRevision !== null && payload.expectedRevision !== undefined && (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1)) {
      return res.status(400).json(err('INVALID_REQUEST','expectedRevision must be a positive integer or null for creation'));
    }
    const periodKey = String(payload.periodKey || '').trim();
    if (!payload.archiveId || !periodKey || !payload.encryptedSegment) {
      return res.status(400).json(err('INVALID_STATE', 'archiveId, periodKey and encryptedSegment are required'));
    }

    const job = await messageArchiveRepository.findJob(familyId, identityId);
    if (!job || job.archive_id !== payload.archiveId) {
      return res.status(404).json(err('NOT_FOUND', 'Archive job not found'));
    }
    if (job.writer_device_id !== deviceId) {
      return res.status(403).json(err('FORBIDDEN', 'Only the archive writer device can write segments'));
    }
    if (job.status !== 'active') {
      return res.status(409).json(err('INVALID_STATE', 'Archive job is not active'));
    }
    const config = await configService.getFamilyConfig(familyId);
    const policy = getEffectiveMessageArchivePolicy(config);
    if (policy.circlePolicy === 'disabled' || !isMessageArchiveModeAllowed({ requested: job.mode, allowed: policy.circlePolicy })) {
      return res.status(403).json(err('FORBIDDEN', 'Message archive writes are disabled by circle policy'));
    }

    const byteSize = Math.max(0, Math.floor(payload.byteSize ?? 0));
    if (policy.circleMaxBytes !== null) {
      const existingSegment = await messageArchiveRepository.findSegment({
        familyId,
        archiveId: job.archive_id,
        ownerIdentityId: identityId,
        periodKey
      });
      const currentBytes = await messageArchiveRepository.getArchiveByteSize({
        familyId,
        archiveId: job.archive_id,
        ownerIdentityId: identityId
      });
      const projectedBytes = currentBytes - (existingSegment?.byte_size ?? 0) + byteSize;
      if (projectedBytes > policy.circleMaxBytes) {
        return res.status(413).json(err('INVALID_STATE', 'Message archive size limit exceeded'));
      }
    }

    const segment = await messageArchiveRepository.putSegment({
      familyId,
      archiveId: job.archive_id,
      ownerIdentityId: identityId,
      writerDeviceId: deviceId,
      periodKey,
      expectedRevision: typeof payload.expectedRevision === 'number' ? Math.floor(payload.expectedRevision) : null,
      periodStartedAt: payload.periodStartedAt ? new Date(payload.periodStartedAt) : null,
      periodEndedAt: payload.periodEndedAt ? new Date(payload.periodEndedAt) : null,
      messageCount: Math.max(0, Math.floor(payload.messageCount ?? 0)),
      byteSize,
      encryptedSegment: payload.encryptedSegment
    });

    return res.json({
      status: 'ok',
      result: {
        segment: {
          segmentId: segment.segment_id,
          archiveId: segment.archive_id,
          periodKey: segment.period_key,
          state: segment.state,
          revision: segment.revision,
          createdAt: segment.created_at.toISOString(),
          updatedAt: segment.updated_at.toISOString()
        }
      }
    } as ApiResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    const status = message.includes('revision conflict') ? 409 : 500;
    if (status !== 409) {
      routeLogger.error('Message archive segment put error:', error);
    }
    return res.status(status).json(err(status === 409 ? 'INVALID_STATE' : 'INTERNAL_ERROR' as ErrorCode, message));
  }
}));

router.post('/segments/finalize', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedDevice, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device!.identityId;
    const deviceId = req.device!.deviceId;
    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Family context is missing'));

    const payload = req.signedRequest!.payload as {
      archiveId?: string;
      periodKey?: string;
      expectedRevision?: number;
    };
    const periodKey = String(payload.periodKey || '').trim();
    if (!payload.archiveId || !periodKey || typeof payload.expectedRevision !== 'number') {
      return res.status(400).json(err('INVALID_STATE', 'archiveId, periodKey and expectedRevision are required'));
    }

    const job = await messageArchiveRepository.findJob(familyId, identityId);
    if (!job || job.archive_id !== payload.archiveId) {
      return res.status(404).json(err('NOT_FOUND', 'Archive job not found'));
    }
    if (job.writer_device_id !== deviceId) {
      return res.status(403).json(err('FORBIDDEN', 'Only the archive writer device can finalize segments'));
    }

    const segment = await messageArchiveRepository.finalizeSegment({
      familyId,
      archiveId: job.archive_id,
      ownerIdentityId: identityId,
      writerDeviceId: deviceId,
      periodKey,
      expectedRevision: Math.floor(payload.expectedRevision)
    });
    if (!segment) {
      return res.status(409).json(err('INVALID_STATE', 'Archive segment revision conflict'));
    }

    return res.json({
      status: 'ok',
      result: {
        segment: {
          segmentId: segment.segment_id,
          archiveId: segment.archive_id,
          periodKey: segment.period_key,
          state: segment.state,
          revision: segment.revision,
          updatedAt: segment.updated_at.toISOString()
        }
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Message archive segment finalize error:', error);
    return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Internal server error'));
  }
}));

router.post('/segments/list', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device!.identityId;
    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Family context is missing'));

    const payload = req.signedRequest!.payload as {
      archiveId?: string;
      afterPeriodKey?: string | null;
      limit?: number;
    };
    if (!payload.archiveId) {
      return res.status(400).json(err('INVALID_STATE', 'archiveId is required'));
    }

    const job = await messageArchiveRepository.findJob(familyId, identityId);
    if (!job || job.archive_id !== payload.archiveId) {
      return res.status(404).json(err('NOT_FOUND', 'Archive job not found'));
    }

    const segments = await messageArchiveRepository.listSegments({
      familyId,
      archiveId: job.archive_id,
      ownerIdentityId: identityId,
      afterPeriodKey: typeof payload.afterPeriodKey === 'string' ? payload.afterPeriodKey : null,
      limit: normalizeLimit(payload.limit)
    });

    return res.json({
      status: 'ok',
      result: {
        segments: segments.map((segment) => ({
          segmentId: segment.segment_id,
          archiveId: segment.archive_id,
          periodKey: segment.period_key,
          state: segment.state,
          revision: segment.revision,
          periodStartedAt: segment.period_started_at?.toISOString() ?? null,
          periodEndedAt: segment.period_ended_at?.toISOString() ?? null,
          messageCount: segment.message_count,
          byteSize: segment.byte_size,
          encryptedSegment: segment.encrypted_segment,
          createdAt: segment.created_at.toISOString(),
          updatedAt: segment.updated_at.toISOString()
        }))
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Message archive segments list error:', error);
    return res.status(500).json(err('INTERNAL_ERROR' as ErrorCode, 'Internal server error'));
  }
});

export default router;
