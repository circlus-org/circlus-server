const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock('../index', () => ({
  pool: {
    connect: (...args: unknown[]) => mockPoolConnect(...args),
    query: (...args: unknown[]) => mockPoolQuery(...args)
  }
}));

import { CallQualityDailyRepository } from './callQualityDailyRepository';

describe('CallQualityDailyRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease
    });
  });

  it('rebuilds one UTC day atomically without persisting participant or call ids', async () => {
    const repository = new CallQualityDailyRepository();
    const timestamp = Date.UTC(2026, 7, 21, 16, 30);
    const dayStart = Date.UTC(2026, 7, 21);

    await repository.refreshDay('family-1', timestamp, 12345);

    expect(mockClientQuery.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      'DELETE FROM call_quality_daily WHERE family_id = $1 AND day_start_ms = $2',
      expect.stringContaining('INSERT INTO call_quality_daily'),
      'COMMIT'
    ]);
    const aggregateSql = String(mockClientQuery.mock.calls[3][0]);
    expect(aggregateSql).toContain('FILTER (WHERE used_relay)');
    expect(aggregateSql).toContain('traffic_reports_count');
    expect(aggregateSql).toContain('media_bytes_sent');
    expect(aggregateSql).toContain('relay_media_bytes_received');
    expect(aggregateSql).toContain('FILTER (WHERE used_relay AND has_traffic)');
    expect(aggregateSql).not.toMatch(/INSERT INTO call_quality_daily[\s\S]*call_session_id/);
    expect(mockClientQuery.mock.calls[3][1]).toEqual([
      'family-1',
      dayStart,
      '__unassigned__',
      12345
    ]);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the connection after a failed rebuild', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValueOnce({ rows: [] });
    const repository = new CallQualityDailyRepository();

    await expect(repository.refreshDay('family-1', Date.UTC(2026, 7, 21)))
      .rejects.toThrow('delete failed');

    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('refreshes each recent family/day bucket so cleanup cannot erase the only source', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        { family_id: 'family-1', day_start_ms: String(Date.UTC(2026, 7, 20)) },
        { family_id: 'family-1', day_start_ms: String(Date.UTC(2026, 7, 21)) }
      ]
    });
    const repository = new CallQualityDailyRepository();
    const refreshDay = jest.spyOn(repository, 'refreshDay').mockResolvedValue(undefined);

    await repository.refreshRecent(Date.UTC(2026, 7, 21, 18), 4);

    expect(refreshDay).toHaveBeenCalledTimes(2);
    expect(refreshDay).toHaveBeenNthCalledWith(
      1,
      'family-1',
      Date.UTC(2026, 7, 20),
      Date.UTC(2026, 7, 21, 18)
    );
  });
});
