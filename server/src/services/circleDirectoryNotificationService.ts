import type { IdentityId, WSCircleDirectoryChangedData } from '@shared/types';
import { query } from '../db';
import { sendToIdentityWs } from '../ws/wsGateway';
import { routeLogger } from '../utils/routeLogger';

export async function notifyCircleDirectoryChanged(
  familyId: string,
  reason: WSCircleDirectoryChangedData['reason']
): Promise<void> {
  try {
    const result = await query<{ identity_id: IdentityId }>(
      `SELECT identity_id FROM identities WHERE family_id = $1 AND status = 'active'`,
      [familyId]
    );
    const changedAt = Date.now();
    const message = {
      type: 'circle:directory-changed',
      data: { reason, changedAt } satisfies WSCircleDirectoryChangedData,
      timestamp: changedAt,
    };
    for (const row of result.rows) {
      sendToIdentityWs(familyId, row.identity_id, message);
    }
  } catch (error) {
    // HTTP state remains authoritative. Clients also compare a lightweight
    // directory head after reconnect, so a missed wake-up is recoverable.
    routeLogger.warn('Circle directory realtime notification failed:', error);
  }
}
