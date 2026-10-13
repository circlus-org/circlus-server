import { query } from '../db';
import {
  outdatedClientProtocols,
  SIGNED_PROTOCOL_RANGES,
  type SignedProtocolRanges,
  type SignedProtocolVersions
} from '../../../shared/protocolVersions';

type DeviceReportRow = {
  client_version: string | null;
  client_protocols: Partial<SignedProtocolVersions> | null;
  last_seen_at: Date | null;
};

export type ClientProtocolReadinessRow = {
  client_version: string;
  not_ready_for: string;
  support_ends: string;
  devices: number;
  last_seen_at: Date | null;
};

/**
 * Active devices whose app does not support the newest version of a signed protocol this
 * server accepts, grouped by build. Such devices stop working once the server raises the
 * protocol's minimum. Devices without a protocol report
 * are listed as not reported: their readiness is unknown.
 */
export function groupClientProtocolReadiness(
  devices: DeviceReportRow[],
  serverRanges: SignedProtocolRanges = SIGNED_PROTOCOL_RANGES
): ClientProtocolReadinessRow[] {
  const groups = new Map<string, ClientProtocolReadinessRow>();
  for (const device of devices) {
    const reported = device.client_protocols !== null;
    const outdated = reported ? outdatedClientProtocols(device.client_protocols, serverRanges) : [];
    if (reported && outdated.length === 0) continue;
    const notReadyFor = reported
      ? outdated.map((entry) => `${entry.name} ${entry.required}`).join(', ')
      : 'not reported';
    const dates = outdated.map((entry) => entry.minRaisesAt).filter((value): value is string => Boolean(value)).sort();
    const supportEnds = reported ? (dates[0] || 'not announced') : '';
    const clientVersion = device.client_version || 'unknown';
    const key = JSON.stringify([clientVersion, notReadyFor]);
    const group = groups.get(key) || {
      client_version: clientVersion, not_ready_for: notReadyFor, support_ends: supportEnds, devices: 0, last_seen_at: null
    };
    group.devices += 1;
    if (device.last_seen_at && (!group.last_seen_at || device.last_seen_at > group.last_seen_at)) {
      group.last_seen_at = device.last_seen_at;
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    (right.last_seen_at?.getTime() ?? 0) - (left.last_seen_at?.getTime() ?? 0));
}

export async function loadClientProtocolReadiness(familyId: string): Promise<ClientProtocolReadinessRow[]> {
  const result = await query<DeviceReportRow>(
    `SELECT client_version, client_protocols, last_seen_at
       FROM devices
      WHERE family_id = $1 AND status = 'active'`,
    [familyId]
  );
  return groupClientProtocolReadiness(result.rows).slice(0, 100);
}
