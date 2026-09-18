import type { PoolClient } from 'pg';
import { CircleSitePublicationAssetRepository } from './circleSitePublicationAssetRepository';

function clientWithRows(...rows: unknown[][]): PoolClient {
  return {
    query: jest.fn().mockImplementation(() => Promise.resolve({ rows: rows.shift() || [] })),
  } as unknown as PoolClient;
}

describe('CircleSitePublicationAssetRepository.replaceForPublication', () => {
  const input = {
    familyId: 'family_1',
    publicationId: 'publication_1',
    sourceChannelPostId: 'channel_post_1',
    uploaderIdentityId: 'identity_1',
    assetIds: [] as string[],
  };

  test('an empty desired set deletes every previously published asset and releases quota', async () => {
    const client = clientWithRows([{ size_bytes: 17 }], []);
    const repository = new CircleSitePublicationAssetRepository();

    await expect(repository.replaceForPublication(input, client)).resolves.toEqual([]);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect((client.query as jest.Mock).mock.calls[0][0]).toContain(
      'NOT (asset_id = ANY($3::text[]))'
    );
    expect((client.query as jest.Mock).mock.calls[0][1]).toEqual([
      'family_1',
      'publication_1',
      [],
    ]);
    expect((client.query as jest.Mock).mock.calls[1][1]).toEqual(['family_1', 17]);
  });

  test('does not alter the previous set when any requested asset is unavailable', async () => {
    const client = clientWithRows([]);
    const repository = new CircleSitePublicationAssetRepository();

    await expect(repository.replaceForPublication({
      ...input,
      assetIds: ['missing-image'],
    }, client)).resolves.toBeNull();

    expect(client.query).toHaveBeenCalledTimes(1);
    expect((client.query as jest.Mock).mock.calls[0][0]).toContain(
      "kind IN ('image', 'download')"
    );
  });
});
