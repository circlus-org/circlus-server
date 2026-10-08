import type { IdentityId, WSDirectGuestPermissionsChangedData, WSPresenceVisibilityChangedData } from '@shared/types';
import { afterCommit, query } from '../db';
import { sendToIdentityWs } from '../ws/wsGateway';
import { routeLogger } from '../utils/routeLogger';

// These events only wake connected clients: HTTP state remains authoritative and
// clients keep polling it, so a missed or delayed hint costs latency, not correctness.
// They are sent after the surrounding transaction commits, so a woken client reads the change.

/** Notify the identities allowed to read this identity's presence (see POST /status/get). */
export function notifyPresenceVisibilityChanged(familyId: string, identityId: IdentityId): void {
  afterCommit(() => { void sendPresenceVisibilityChanged(familyId, identityId); });
}

async function sendPresenceVisibilityChanged(familyId: string, identityId: IdentityId): Promise<void> {
  try {
    const result = await query<{ identity_id: IdentityId }>(
      `SELECT identity_id FROM identities
        WHERE family_id = $1 AND status = 'active' AND role IN ('owner', 'member')
       UNION
       SELECT CASE WHEN host_identity_id = $2 THEN guest_identity_id ELSE host_identity_id END
         FROM direct_guest_registrations
        WHERE family_id = $1 AND status = 'active' AND (host_identity_id = $2 OR guest_identity_id = $2)`,
      [familyId, identityId]
    );
    const changedAt = Date.now();
    const message = {
      type: 'presence:visibility-changed',
      data: { identityId, changedAt } satisfies WSPresenceVisibilityChangedData,
      timestamp: changedAt,
    };
    for (const row of result.rows) {
      sendToIdentityWs(familyId, row.identity_id, message);
    }
  } catch (error) {
    routeLogger.warn('Presence visibility realtime notification failed:', error);
  }
}

export function notifyDirectGuestPermissionsChanged(
  familyId: string,
  registration: { registrationId: string; hostIdentityId: IdentityId; guestIdentityId: IdentityId }
): void {
  afterCommit(() => sendDirectGuestPermissionsChanged(familyId, registration));
}

function sendDirectGuestPermissionsChanged(
  familyId: string,
  registration: { registrationId: string; hostIdentityId: IdentityId; guestIdentityId: IdentityId }
): void {
  const changedAt = Date.now();
  const message = {
    type: 'direct-guest:permissions-changed',
    data: { ...registration, changedAt } satisfies WSDirectGuestPermissionsChangedData,
    timestamp: changedAt,
  };
  for (const identityId of new Set([registration.hostIdentityId, registration.guestIdentityId])) {
    try {
      sendToIdentityWs(familyId, identityId, message);
    } catch (error) {
      routeLogger.warn('Guest permissions realtime notification failed:', error);
    }
  }
}
