import { pool, query } from '../index';
import { CircleInspectorRepository } from './circleInspectorRepository';

jest.mock('../index', () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() }
}));

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    request_id: 'cir_request',
    family_id: null,
    request_token_hash: 'request-hash',
    viewer_label: 'Laptop',
    status: 'pending',
    approved_by_identity_id: null,
    approved_by_device_id: null,
    created_at: 100,
    expires_at: 1_000,
    approved_at: null,
    ...overrides
  };
}

describe('CircleInspectorRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a VPS-scoped request without choosing a Circle', async () => {
    (query as jest.Mock).mockResolvedValue({ rows: [requestRow()] });

    const result = await new CircleInspectorRepository().createUnboundRequest({
      requestTokenHash: 'request-hash',
      viewerLabel: 'Laptop',
      now: 100,
      expiresAt: 1_000
    });

    expect(result.family_id).toBeNull();
    const [sql, values] = (query as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('request_id, family_id');
    expect(values).toHaveLength(5);
  });

  it('atomically binds an unbound pending request to the approving Circle', async () => {
    const clientQuery = jest.fn(async (sql: string) => {
      if (sql.includes('UPDATE circle_inspector_requests')) {
        return { rows: [requestRow({ family_id: 'family-1', status: 'approved', approved_at: 200 })] };
      }
      if (sql.includes('UPDATE circle_inspector_sessions')) return { rows: [] };
      if (sql.includes('INSERT INTO circle_inspector_sessions')) {
        return { rows: [{
          session_id: 'cis_session',
          family_id: 'family-1',
          request_id: 'cir_request',
          session_token_hash: 'session-hash',
          session_token_handoff: 'cis_plaintext',
          approved_by_identity_id: 'owner-1',
          approved_by_device_id: 'device-1',
          created_at: 200,
          expires_at: 800,
          last_used_at: null,
          revoked_at: null,
          revoked_by_identity_id: null
        }] };
      }
      return { rows: [] };
    });
    (pool.connect as jest.Mock).mockResolvedValue({ query: clientQuery, release: jest.fn() });

    const result = await new CircleInspectorRepository().approveRequest({
      familyId: 'family-1',
      requestId: 'cir_request',
      requestTokenHash: 'request-hash',
      approvedByIdentityId: 'owner-1',
      approvedByDeviceId: 'device-1',
      sessionTokenHash: 'session-hash',
      sessionTokenHandoff: 'cis_plaintext',
      now: 200,
      sessionExpiresAt: 800
    });

    const approvalCall = clientQuery.mock.calls.find(([sql]) => sql.includes('UPDATE circle_inspector_requests'));
    expect(approvalCall?.[0]).toContain('family_id = $1');
    expect(approvalCall?.[0]).toContain('WHERE family_id IS NULL');
    expect(approvalCall?.[1]?.[0]).toBe('family-1');
    expect(result?.request.family_id).toBe('family-1');
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');

    const insertCall = clientQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO circle_inspector_sessions'));
    expect(insertCall?.[1]).toContain('cis_plaintext');
    // A session record must never carry the plaintext pickup value.
    expect(result?.session).not.toHaveProperty('session_token_handoff');
  });

  it('hands the session token over exactly once', async () => {
    (query as jest.Mock).mockResolvedValue({ rows: [{ session_token_handoff: 'cis_plaintext' }] });

    const repository = new CircleInspectorRepository();
    await expect(repository.consumeSessionTokenHandoff('cir_request', 500)).resolves.toBe('cis_plaintext');

    const [sql, values] = (query as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('SET session_token_handoff = NULL');
    expect(sql).toContain('session_token_handoff IS NOT NULL');
    expect(sql).toContain('revoked_at IS NULL');
    expect(sql).toContain('expires_at > $2');
    expect(sql).toContain('RETURNING pickup.session_token_handoff');
    expect(values).toEqual(['cir_request', 500]);
  });

  it('returns no token once the handoff was already collected', async () => {
    (query as jest.Mock).mockResolvedValue({ rows: [] });

    await expect(new CircleInspectorRepository().consumeSessionTokenHandoff('cir_request', 500))
      .resolves.toBeNull();
  });
});
