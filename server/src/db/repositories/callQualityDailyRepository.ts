import { pool } from '../index';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNASSIGNED_CLUSTER_ID = '__unassigned__';

function utcDayStart(timestampMs: number): number {
  return Math.floor(timestampMs / DAY_MS) * DAY_MS;
}

const REFRESH_DAY_SQL = `
  WITH source_reports AS (
    SELECT
      family_id,
      call_session_id,
      COALESCE(NULLIF(LEFT(media_quality_summary->>'turnClusterId', 128), ''), $3) AS turn_cluster_id,
      media_quality_summary AS quality
    FROM call_client_diagnostics
    WHERE family_id = $1
      AND recorded_at >= $2
      AND recorded_at < $2 + ${DAY_MS}
      AND media_quality_summary IS NOT NULL
  ),
  normalized_reports AS (
    SELECT
      family_id,
      call_session_id,
      turn_cluster_id,
      quality->>'usedRelay' = 'true' AS used_relay,
      jsonb_typeof(quality->'bytesSent') = 'number'
        OR jsonb_typeof(quality->'bytesReceived') = 'number' AS has_traffic,
      CASE WHEN jsonb_typeof(quality->'sampleCount') = 'number'
        THEN FLOOR(LEAST(9007199254740991::numeric, GREATEST(0, (quality->>'sampleCount')::numeric)))::bigint ELSE 0 END AS sample_count,
      CASE WHEN jsonb_typeof(quality->'reconnectCount') = 'number'
        THEN FLOOR(LEAST(9007199254740991::numeric, GREATEST(0, (quality->>'reconnectCount')::numeric)))::bigint ELSE 0 END AS reconnect_count,
      CASE WHEN jsonb_typeof(quality#>'{rttMs,average}') = 'number'
        THEN (quality#>>'{rttMs,average}')::double precision END AS rtt_average_ms,
      CASE WHEN jsonb_typeof(quality#>'{rttMs,maximum}') = 'number'
        THEN (quality#>>'{rttMs,maximum}')::double precision END AS rtt_maximum_ms,
      CASE WHEN jsonb_typeof(quality#>'{jitterMs,average}') = 'number'
        THEN (quality#>>'{jitterMs,average}')::double precision END AS jitter_average_ms,
      CASE WHEN jsonb_typeof(quality#>'{jitterMs,maximum}') = 'number'
        THEN (quality#>>'{jitterMs,maximum}')::double precision END AS jitter_maximum_ms,
      CASE WHEN jsonb_typeof(quality#>'{packetLoss,lost}') = 'number'
        THEN FLOOR(LEAST(9007199254740991::numeric, GREATEST(0, (quality#>>'{packetLoss,lost}')::numeric)))::bigint ELSE 0 END AS packets_lost,
      CASE WHEN jsonb_typeof(quality#>'{packetLoss,received}') = 'number'
        THEN FLOOR(LEAST(9007199254740991::numeric, GREATEST(0, (quality#>>'{packetLoss,received}')::numeric)))::bigint ELSE 0 END AS packets_received,
      CASE WHEN jsonb_typeof(quality#>'{bitrateKbps,outboundAverage}') = 'number'
        THEN (quality#>>'{bitrateKbps,outboundAverage}')::double precision END AS outbound_bitrate_average_kbps,
      CASE WHEN jsonb_typeof(quality#>'{bitrateKbps,inboundAverage}') = 'number'
        THEN (quality#>>'{bitrateKbps,inboundAverage}')::double precision END AS inbound_bitrate_average_kbps,
      CASE WHEN jsonb_typeof(quality->'bytesSent') = 'number'
        THEN FLOOR(LEAST(9007199254740991::numeric, GREATEST(0, (quality->>'bytesSent')::numeric)))::bigint ELSE 0 END AS media_bytes_sent,
      CASE WHEN jsonb_typeof(quality->'bytesReceived') = 'number'
        THEN FLOOR(LEAST(9007199254740991::numeric, GREATEST(0, (quality->>'bytesReceived')::numeric)))::bigint ELSE 0 END AS media_bytes_received,
      CASE WHEN jsonb_typeof(quality#>'{video,freezeCount}') = 'number'
        THEN FLOOR(LEAST(9007199254740991::numeric, GREATEST(0, (quality#>>'{video,freezeCount}')::numeric)))::bigint ELSE 0 END AS freeze_count
    FROM source_reports
  ),
  report_aggregates AS (
    SELECT
      family_id,
      turn_cluster_id,
      COUNT(*)::integer AS reports_count,
      COUNT(*) FILTER (WHERE used_relay)::integer AS relay_reports_count,
      COALESCE(SUM(sample_count) FILTER (WHERE used_relay), 0)::bigint AS sample_count,
      COALESCE(SUM(reconnect_count) FILTER (WHERE used_relay), 0)::bigint AS reconnect_count,
      COUNT(*) FILTER (WHERE used_relay AND reconnect_count > 0)::integer AS reconnecting_reports_count,
      COUNT(rtt_average_ms) FILTER (WHERE used_relay)::integer AS rtt_reports_count,
      AVG(rtt_average_ms) FILTER (WHERE used_relay) AS rtt_average_ms,
      MAX(rtt_maximum_ms) FILTER (WHERE used_relay) AS rtt_maximum_ms,
      COUNT(jitter_average_ms) FILTER (WHERE used_relay)::integer AS jitter_reports_count,
      AVG(jitter_average_ms) FILTER (WHERE used_relay) AS jitter_average_ms,
      MAX(jitter_maximum_ms) FILTER (WHERE used_relay) AS jitter_maximum_ms,
      COALESCE(SUM(packets_lost) FILTER (WHERE used_relay), 0)::bigint AS packets_lost,
      COALESCE(SUM(packets_received) FILTER (WHERE used_relay), 0)::bigint AS packets_received,
      COUNT(outbound_bitrate_average_kbps) FILTER (WHERE used_relay)::integer AS outbound_bitrate_reports_count,
      AVG(outbound_bitrate_average_kbps) FILTER (WHERE used_relay) AS outbound_bitrate_average_kbps,
      COUNT(inbound_bitrate_average_kbps) FILTER (WHERE used_relay)::integer AS inbound_bitrate_reports_count,
      AVG(inbound_bitrate_average_kbps) FILTER (WHERE used_relay) AS inbound_bitrate_average_kbps,
      COUNT(*) FILTER (WHERE has_traffic)::integer AS traffic_reports_count,
      COUNT(*) FILTER (WHERE used_relay AND has_traffic)::integer AS relay_traffic_reports_count,
      COALESCE(SUM(media_bytes_sent) FILTER (WHERE has_traffic), 0)::bigint AS media_bytes_sent,
      COALESCE(SUM(media_bytes_received) FILTER (WHERE has_traffic), 0)::bigint AS media_bytes_received,
      COALESCE(SUM(media_bytes_sent) FILTER (WHERE used_relay AND has_traffic), 0)::bigint AS relay_media_bytes_sent,
      COALESCE(SUM(media_bytes_received) FILTER (WHERE used_relay AND has_traffic), 0)::bigint AS relay_media_bytes_received,
      COALESCE(SUM(freeze_count) FILTER (WHERE used_relay), 0)::bigint AS freeze_count,
      COUNT(*) FILTER (WHERE used_relay AND freeze_count > 0)::integer AS reports_with_freezes_count
    FROM normalized_reports
    GROUP BY family_id, turn_cluster_id
  ),
  per_call AS (
    SELECT
      family_id,
      turn_cluster_id,
      call_session_id,
      COUNT(*) AS report_count,
      BOOL_OR(used_relay) AS used_relay
    FROM normalized_reports
    GROUP BY family_id, turn_cluster_id, call_session_id
  ),
  call_aggregates AS (
    SELECT
      family_id,
      turn_cluster_id,
      COUNT(*)::integer AS calls_count,
      COUNT(*) FILTER (WHERE report_count >= 2)::integer AS two_sided_calls_count,
      COUNT(*) FILTER (WHERE used_relay)::integer AS relay_calls_count
    FROM per_call
    GROUP BY family_id, turn_cluster_id
  )
  INSERT INTO call_quality_daily (
    family_id, day_start_ms, turn_cluster_id,
    calls_count, reports_count, two_sided_calls_count,
    relay_calls_count, relay_reports_count, sample_count,
    reconnect_count, reconnecting_reports_count,
    rtt_reports_count, rtt_average_ms, rtt_maximum_ms,
    jitter_reports_count, jitter_average_ms, jitter_maximum_ms,
    packets_lost, packets_received,
    outbound_bitrate_reports_count, outbound_bitrate_average_kbps,
    inbound_bitrate_reports_count, inbound_bitrate_average_kbps,
    traffic_reports_count, relay_traffic_reports_count,
    media_bytes_sent, media_bytes_received,
    relay_media_bytes_sent, relay_media_bytes_received,
    freeze_count, reports_with_freezes_count, updated_at
  )
  SELECT
    reports.family_id, $2, reports.turn_cluster_id,
    calls.calls_count, reports.reports_count, calls.two_sided_calls_count,
    calls.relay_calls_count, reports.relay_reports_count, reports.sample_count,
    reports.reconnect_count, reports.reconnecting_reports_count,
    reports.rtt_reports_count, reports.rtt_average_ms, reports.rtt_maximum_ms,
    reports.jitter_reports_count, reports.jitter_average_ms, reports.jitter_maximum_ms,
    reports.packets_lost, reports.packets_received,
    reports.outbound_bitrate_reports_count, reports.outbound_bitrate_average_kbps,
    reports.inbound_bitrate_reports_count, reports.inbound_bitrate_average_kbps,
    reports.traffic_reports_count, reports.relay_traffic_reports_count,
    reports.media_bytes_sent, reports.media_bytes_received,
    reports.relay_media_bytes_sent, reports.relay_media_bytes_received,
    reports.freeze_count, reports.reports_with_freezes_count, $4
  FROM report_aggregates reports
  JOIN call_aggregates calls
    ON calls.family_id = reports.family_id
   AND calls.turn_cluster_id = reports.turn_cluster_id
`;

export class CallQualityDailyRepository {
  async refreshDay(familyId: string, timestampMs: number, nowMs = Date.now()): Promise<void> {
    const dayStartMs = utcDayStart(timestampMs);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [familyId, String(dayStartMs)]
      );
      await client.query(
        'DELETE FROM call_quality_daily WHERE family_id = $1 AND day_start_ms = $2',
        [familyId, dayStartMs]
      );
      await client.query(REFRESH_DAY_SQL, [familyId, dayStartMs, UNASSIGNED_CLUSTER_ID, nowMs]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshRecent(nowMs = Date.now(), lookbackDays = 4): Promise<void> {
    const cutoff = utcDayStart(nowMs - Math.max(1, lookbackDays) * DAY_MS);
    const result = await pool.query<{ family_id: string; day_start_ms: string | number }>(
      `SELECT DISTINCT family_id,
              FLOOR(recorded_at::numeric / $2) * $2 AS day_start_ms
       FROM call_client_diagnostics
       WHERE media_quality_summary IS NOT NULL AND recorded_at >= $1
       ORDER BY family_id, day_start_ms`,
      [cutoff, DAY_MS]
    );
    for (const row of result.rows) {
      await this.refreshDay(row.family_id, Number(row.day_start_ms), nowMs);
    }
  }
}

export const callQualityDailyRepository = new CallQualityDailyRepository();
