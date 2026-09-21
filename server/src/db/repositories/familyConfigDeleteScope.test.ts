const transactionMock = jest.fn();

jest.mock('../index', () => ({
  query: jest.fn(),
  transaction: (...args: unknown[]) => transactionMock(...args)
}));

import { familyConfigRepository } from './familyConfigRepository';

describe('Circle deletion query scope', () => {
  it('scopes every tenant data mutation to the selected family id', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT storage_key FROM attachment_blobs')) {
        return { rows: [{ storage_key: 'family_a/blob.bin' }] };
      }
      if (sql.includes('SELECT storage_key FROM circle_site_publication_assets')) {
        return { rows: [{ storage_key: 'family_a/site.bin' }] };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionMock.mockImplementation(async (run: (client: { query: typeof query }) => unknown) => run({ query }));

    const result = await familyConfigRepository.deleteWithData('family_a');

    expect(result).toEqual({
      attachmentStorageKeys: ['family_a/blob.bin'],
      publicSiteAssetStorageKeys: ['family_a/site.bin']
    });
    for (const [sql, params] of query.mock.calls) {
      expect(params).toEqual(['family_a']);
      if (/^DELETE FROM /m.test(sql)) {
        expect(sql).toMatch(/WHERE family_id = \$1/);
      }
    }
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM family_config WHERE family_id = $1',
      ['family_a']
    );
  });
});
