jest.mock('../db', () => ({
  pool: { query: jest.fn() },
  transaction: jest.fn(async work => work({})),
  inTransactionContext: jest.fn(async (_client, work) => work())
}));
import { pool, transaction } from '../db';
import { callAdmissionJournal } from './callAdmissionJournal';
const scope = { familyId: 'family-a', callSessionId: 'call-a', initiatorIdentityId: 'caller', initiatorDeviceId: 'device-a', targetIdentityId: 'peer' };
beforeEach(() => { jest.clearAllMocks(); (pool.query as jest.Mock).mockResolvedValue({ rows: [], rowCount: 0 }); });
it('retains durable cancellation across repeated offer attempts without calling create', async () => {
  (pool.query as jest.Mock).mockImplementation(async sql => ({ rows: sql.includes('SELECT phase') ? [{ phase: 'cancelled' }] : [], rowCount: 0 }));
  const create = jest.fn();
  expect(await callAdmissionJournal.create(scope, create)).toBe(false);
  expect(await callAdmissionJournal.create(scope, create)).toBe(false);
  expect(create).not.toHaveBeenCalled();
  expect((pool.query as jest.Mock).mock.calls.some(([sql]) => /DELETE/.test(sql))).toBe(false);
});
it('creates the offered route and session within one locked transaction', async () => {
  const create = jest.fn(async () => { expect(transaction).toHaveBeenCalledTimes(1); });
  expect(await callAdmissionJournal.create(scope, create)).toBe(true);
  expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['family-a', 'call-a']);
  expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("'offered'"), Object.values(scope));
  expect(create).toHaveBeenCalledTimes(1);
});
it('does not ACK a concurrent appearance of the call row as an early cancellation', async () => {
  (pool.query as jest.Mock).mockImplementation(async sql => ({ rows: [], rowCount: sql.includes('FROM call_sessions') ? 1 : 0 }));
  expect(await callAdmissionJournal.cancelBeforeOffer(scope, 'bdb85e64-b01d-4647-9e2d-2654adf10a59')).toBe(false);
  expect((pool.query as jest.Mock).mock.calls.some(([sql]) => /INSERT/.test(sql))).toBe(false);
});
it('propagates storage failure instead of completing an in-memory cancellation', async () => {
  (pool.query as jest.Mock).mockImplementation(async sql => {
    if (sql.includes('INSERT')) throw new Error('storage unavailable');
    return { rows: [], rowCount: 0 };
  });
  await expect(callAdmissionJournal.cancelBeforeOffer(scope, 'bdb85e64-b01d-4647-9e2d-2654adf10a59')).rejects.toThrow('storage unavailable');
});
it.each(Object.keys(scope))('requires explicit %s before database access', async key => {
  await expect(callAdmissionJournal.create({ ...scope, [key]: '' }, jest.fn())).rejects.toThrow('CALL_ADMISSION_SCOPE_REQUIRED');
  expect(pool.query).not.toHaveBeenCalled();
});
