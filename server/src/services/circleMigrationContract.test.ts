import {
  canonicalizeCircleMigrationJson,
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
  CIRCLE_MIGRATION_V2_EXPORT_TABLES,
  CIRCLE_MIGRATION_V2_TABLE_CONTRACT,
  isSupportedCircleMigrationContract
} from './circleMigrationContract';
import manifestSchema from './circleMigrationManifestV2.schema.json';
import tableMapping from './circleMigrationTableMappingV2.json';
import canonicalization from './circleMigrationCanonicalizationV2.json';

describe('Circle migration v2 contract', () => {
  it('canonicalizes object keys recursively while preserving array order', () => {
    expect(canonicalizeCircleMigrationJson({
      z: 1,
      nested: { b: true, a: 'first' },
      list: [{ d: 4, c: 3 }]
    })).toBe('{"list":[{"c":3,"d":4}],"nested":{"a":"first","b":true},"z":1}');
  });

  it('keeps transferred and dropped tables disjoint', () => {
    const transferred = new Set([
      ...CIRCLE_MIGRATION_V2_TABLE_CONTRACT.copy,
      ...CIRCLE_MIGRATION_V2_TABLE_CONTRACT.transform,
      ...CIRCLE_MIGRATION_V2_TABLE_CONTRACT.derive
    ]);
    for (const table of CIRCLE_MIGRATION_V2_TABLE_CONTRACT.drop) {
      expect(transferred.has(table)).toBe(false);
    }
  });

  it('requires exact version and fingerprints', () => {
    expect(isSupportedCircleMigrationContract({
      migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
      schemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
      dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT
    })).toBe(true);
    expect(isSupportedCircleMigrationContract({
      migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION + 1,
      schemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
    })).toBe(false);
    expect(isSupportedCircleMigrationContract({
      migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
      schemaFingerprint: 'sha256:other'
    })).toBe(false);
  });

  it('exports every copy/transform table exactly once', () => {
    const expected = new Set([
      ...CIRCLE_MIGRATION_V2_TABLE_CONTRACT.copy,
      ...CIRCLE_MIGRATION_V2_TABLE_CONTRACT.transform
    ]);
    expect(new Set(CIRCLE_MIGRATION_V2_EXPORT_TABLES)).toEqual(expected);
    expect(CIRCLE_MIGRATION_V2_EXPORT_TABLES).toHaveLength(expected.size);
  });

  it('keeps machine-readable artifacts aligned with the executable contract', () => {
    expect(manifestSchema.properties.format.const).toBe('circlus-circle-migration-v2');
    expect(manifestSchema.properties.migrationFormatVersion.const).toBe(CIRCLE_MIGRATION_FORMAT_VERSION);
    expect(tableMapping.actions).toEqual(CIRCLE_MIGRATION_V2_TABLE_CONTRACT);
    expect(tableMapping.fkOrder).toEqual(CIRCLE_MIGRATION_V2_EXPORT_TABLES);
    for (const vector of canonicalization.vectors) {
      expect(canonicalizeCircleMigrationJson(vector.input)).toBe(vector.canonical);
    }
  });
});
