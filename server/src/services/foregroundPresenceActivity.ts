import { identityRepository } from '../db/repositories';
import { getRequestLogger } from '../middleware/requestContext';

const FOREGROUND_ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FOREGROUND_ACTIVITY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function normalizeForegroundActivityAt(
  activityAt: unknown,
  now = Date.now()
): Date | null {
  const timestamp = Number(activityAt);
  if (!Number.isFinite(timestamp)) return null;
  if (timestamp < now - FOREGROUND_ACTIVITY_MAX_AGE_MS) return null;
  if (timestamp > now + FOREGROUND_ACTIVITY_MAX_FUTURE_SKEW_MS) return null;
  return new Date(Math.min(timestamp, now));
}

/** Records signed foreground evidence without making message delivery depend on
 * the auxiliary presence write. Retries preserve the original activity time. */
export async function recordForegroundMessageActivity(params: {
  familyId: string;
  identityId: string;
  activityAt: unknown;
}): Promise<void> {
  const activityAt = normalizeForegroundActivityAt(params.activityAt);
  if (!activityAt) return;
  try {
    await identityRepository.touchForegroundPresenceAt(
      params.familyId,
      params.identityId,
      activityAt
    );
  } catch (error) {
    getRequestLogger({ subsystem: 'foreground_presence' }).warn(
      'foreground_message_activity_write_failed',
      { identityId: params.identityId, error }
    );
  }
}
