import type { CallSessionId, IdentityId } from '@shared/types';
import { callIceDiagnosticsRepository, type CallIceDiagnosticsEntry } from '../db/repositories';
import { serverLogger } from '../utils/logger';

const logger = serverLogger.child({ subsystem: 'call_ice_diagnostics' });

type ParsedIceCandidateForLog = {
  candidateType: 'host' | 'srflx' | 'relay' | 'prflx' | 'unknown';
  protocol: 'udp' | 'tcp' | 'unknown';
  address?: string;
  port?: number;
};

type IdentityIceStats = {
  total: number;
  relay: number;
  srflx: number;
  host: number;
  prflx: number;
  tcp: number;
  udp: number;
  unknownType: number;
  unknownProtocol: number;
  last?: ParsedIceCandidateForLog;
};

type CallIceStats = {
  createdAtMs: number;
  byIdentity: Map<IdentityId, IdentityIceStats>;
};

const callIceStats = new Map<CallSessionId, CallIceStats>();

function parseIceCandidateForLog(candidate: any): ParsedIceCandidateForLog {
  const raw = typeof candidate?.candidate === 'string' ? candidate.candidate : '';

  const typeMatch = raw.match(/ typ ([a-z0-9]+)/i);
  const protocolMatch = raw.match(/^candidate:[^\s]+\s+\d+\s+(udp|tcp)\s+/i);
  const addressMatch = raw.match(/^candidate:[^\s]+\s+\d+\s+(?:udp|tcp)\s+\d+\s+([^\s]+)\s+(\d+)/i);

  const rawType = (typeMatch?.[1] || '').toLowerCase();
  const rawProtocol = (protocolMatch?.[1] || '').toLowerCase();

  const candidateType: ParsedIceCandidateForLog['candidateType'] =
    rawType === 'relay' || rawType === 'srflx' || rawType === 'host' || rawType === 'prflx'
      ? rawType
      : 'unknown';

  const protocol: ParsedIceCandidateForLog['protocol'] =
    rawProtocol === 'udp' || rawProtocol === 'tcp'
      ? rawProtocol
      : 'unknown';

  const address = addressMatch?.[1];
  const parsedPort = Number.parseInt(addressMatch?.[2] || '', 10);
  const port = Number.isFinite(parsedPort) ? parsedPort : undefined;

  return { candidateType, protocol, address, port };
}

export function ensureCallIceStats(callSessionId: CallSessionId): CallIceStats {
  const existing = callIceStats.get(callSessionId);
  if (existing) return existing;

  const created: CallIceStats = {
    createdAtMs: Date.now(),
    byIdentity: new Map<IdentityId, IdentityIceStats>()
  };
  callIceStats.set(callSessionId, created);
  return created;
}

/** Snapshot the current per-identity ICE stats for a call without clearing them. */
function snapshotCallIceStats(callSessionId: CallSessionId): CallIceDiagnosticsEntry[] {
  const stats = callIceStats.get(callSessionId);
  if (!stats) return [];
  return Array.from(stats.byIdentity.entries()).map(([identityId, s]) => ({
    identityId,
    total: s.total,
    relay: s.relay,
    srflx: s.srflx,
    host: s.host,
    prflx: s.prflx,
    udp: s.udp,
    tcp: s.tcp
  }));
}

/**
 * Persist the call's ICE candidate summary (one row per participant) and
 * clear the in-memory stats. Safe to call from multiple call-end code paths:
 * the in-memory map is cleared atomically with the snapshot, so only the
 * first caller for a given callSessionId actually has data to write.
 *
 * Best-effort: diagnostics are never allowed to break call teardown.
 */
export async function persistAndClearCallIceStats(params: {
  familyId: string;
  callSessionId: CallSessionId;
}): Promise<void> {
  const entries = snapshotCallIceStats(params.callSessionId);
  callIceStats.delete(params.callSessionId);
  if (entries.length === 0) return;

  try {
    await callIceDiagnosticsRepository.save({
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      entries
    });
  } catch (error) {
    logger.warn('call_ice_diagnostics_persist_failed', {
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      participantCount: entries.length,
      error
    });
  }
}

export function recordCallIceCandidate(params: {
  callSessionId: CallSessionId;
  identityId: IdentityId;
  candidate: any;
}): { entry: IdentityIceStats; parsed: ParsedIceCandidateForLog } {
  const stats = ensureCallIceStats(params.callSessionId);
  const parsed = parseIceCandidateForLog(params.candidate);

  const existing = stats.byIdentity.get(params.identityId) || {
    total: 0,
    relay: 0,
    srflx: 0,
    host: 0,
    prflx: 0,
    tcp: 0,
    udp: 0,
    unknownType: 0,
    unknownProtocol: 0
  };

  existing.total += 1;
  existing.last = parsed;

  if (parsed.candidateType === 'relay') existing.relay += 1;
  else if (parsed.candidateType === 'srflx') existing.srflx += 1;
  else if (parsed.candidateType === 'host') existing.host += 1;
  else if (parsed.candidateType === 'prflx') existing.prflx += 1;
  else existing.unknownType += 1;

  if (parsed.protocol === 'udp') existing.udp += 1;
  else if (parsed.protocol === 'tcp') existing.tcp += 1;
  else existing.unknownProtocol += 1;

  stats.byIdentity.set(params.identityId, existing);

  return { entry: existing, parsed };
}

export function summarizeCallIceStats(callSessionId: CallSessionId): string {
  const stats = callIceStats.get(callSessionId);
  if (!stats) return 'iceStats=none';

  const ageMs = Date.now() - stats.createdAtMs;
  const participants = Array.from(stats.byIdentity.entries())
    .map(([identityId, s]) => `${identityId}:total=${s.total},relay=${s.relay},srflx=${s.srflx},host=${s.host},prflx=${s.prflx},udp=${s.udp},tcp=${s.tcp}`)
    .join(' | ');

  return `iceStatsAgeMs=${ageMs} ${participants || 'participants=0'}`;
}
