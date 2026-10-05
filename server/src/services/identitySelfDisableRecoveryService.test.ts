import { query } from '../db';
import { getSelfDisableStatus } from './identitySelfDisableRecoveryService';

jest.mock('../db', () => ({ query: jest.fn() }));

describe('self-disable recovery', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports a committed self-removal even after the old devices are revoked', async () => {
    (query as jest.Mock).mockResolvedValue({ rows: [{ status: 'disabled', signer_id: 'old', state_id: 'state-1' }] });
    expect(await getSelfDisableStatus('family', 'old')).toEqual({ disabled: true, selfDisabled: true, membershipStateId: 'state-1' });
  });

  it('does not report an owner block as voluntary self-disable', async () => {
    (query as jest.Mock).mockResolvedValue({ rows: [{ status: 'disabled', signer_id: 'owner', state_id: 'state-2' }] });
    expect(await getSelfDisableStatus('family', 'old')).toEqual({ disabled: true, selfDisabled: false, membershipStateId: 'state-2' });
  });
});
