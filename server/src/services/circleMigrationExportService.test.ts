import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getClient } from '../db';
import { CIRCLE_MIGRATION_V2_EXPORT_TABLES } from './circleMigrationContract';
import {
  circleMigrationExportService,
  getCircleMigrationExportDirectory
} from './circleMigrationExportService';

jest.mock('../db', () => ({
  getClient: jest.fn()
}));

describe('Circle migration consistent export package', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'circlus-migration-export-'));
    process.env.VPS_ID = 'source-server';
    process.env.CIRCLE_MIGRATION_EXPORT_DIR = root;
    const cursors = new Map<string, { table: string; fetched: boolean }>();
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          return { rows: CIRCLE_MIGRATION_V2_EXPORT_TABLES.map((table_name) => ({ table_name })) };
        }
        const declare = /^DECLARE\s+(\S+).*?\sFROM\s+(\w+)\s+AS\s+row_data/s.exec(sql);
        if (declare) {
          cursors.set(declare[1]!, { table: declare[2]!, fetched: false });
          return { rows: [] };
        }
        const fetch = /^FETCH FORWARD \d+ FROM (\S+)/.exec(sql);
        if (fetch) {
          const cursor = cursors.get(fetch[1]!);
          if (!cursor || cursor.fetched) return { rows: [] };
          cursor.fetched = true;
          return {
            rows: [{
              row_json: JSON.stringify({
                family_id: '11111111-1111-4111-8111-111111111111',
                exported_from: cursor.table
              })
            }]
          };
        }
        return { rows: [] };
      }),
      release: jest.fn()
    };
    (getClient as jest.Mock).mockResolvedValue(client);
  });

  afterEach(async () => {
    delete process.env.VPS_ID;
    delete process.env.CIRCLE_MIGRATION_EXPORT_DIR;
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('writes every required table from one repeatable-read transaction', async () => {
    const migration = {
      migration_id: 'migjob_test',
      migration_slot_id: 'mslot_test',
      family_id: '11111111-1111-4111-8111-111111111111',
      status: 'exporting',
      freeze_started_at: new Date(),
      preflight_summary: {
        targetMessageTtlHours: 24,
        excludedMessageCountByTargetTtl: 0
      },
      owner_signed_migration_intent: {
        payload: { oldPublicBaseUrl: 'https://source.example' },
        signature: 'signature'
      },
      destination_server_id: 'destination-server',
      destination_service_endpoint: 'https://destination.example',
      destination_public_base_url: 'https://circle.example'
    } as any;

    const result = await circleMigrationExportService.export(migration);
    expect(result.directory).toBe(getCircleMigrationExportDirectory('migjob_test'));
    expect(result.manifest.snapshot.isolation).toBe('repeatable_read_after_write_freeze');
    expect(result.manifest.counts).toEqual(Object.fromEntries(
      CIRCLE_MIGRATION_V2_EXPORT_TABLES.map((table) => [table, 1])
    ));
    for (const table of CIRCLE_MIGRATION_V2_EXPORT_TABLES) {
      await expect(fs.promises.stat(path.join(result.directory, 'db', `${table}.jsonl`)))
        .resolves.toMatchObject({ size: expect.any(Number) });
    }
    await expect(fs.promises.stat(path.join(result.directory, 'manifest.json'))).resolves.toBeDefined();
    await expect(fs.promises.stat(path.join(result.directory, 'checksums.json'))).resolves.toBeDefined();
    expect(result.manifest.tableExports.some((entry) => entry.table === 'attachment_blobs')).toBe(false);
  });
});
