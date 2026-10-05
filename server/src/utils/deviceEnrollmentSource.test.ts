import { admittedDeviceEnrollmentSource } from './deviceEnrollmentSource';

jest.mock('./trustedOrigins', () => ({
  normalizeTrustedOrigin: (raw: string | undefined) => raw || null,
  isTrustedClientOrigin: (origin: string) => origin === 'https://client.circlus.org'
}));

const familyConfig = {} as Parameters<typeof admittedDeviceEnrollmentSource>[0]['familyConfig'];

describe('device enrollment source', () => {
  test('admits a trusted browser origin', () => {
    expect(admittedDeviceEnrollmentSource({
      originHeader: 'https://client.circlus.org', sdkHeader: undefined, bootstrapCommitment: null, familyConfig
    })).toBe('https://client.circlus.org');
  });

  test('rejects an untrusted browser origin even if it claims to be an SDK', () => {
    expect(admittedDeviceEnrollmentSource({
      originHeader: 'https://evil.example', sdkHeader: 'node-v1', bootstrapCommitment: 'committed', familyConfig
    })).toBeNull();
  });

  test('requires both an explicit native marker and a trusted-device QR commitment', () => {
    const base = { originHeader: undefined, familyConfig };
    expect(admittedDeviceEnrollmentSource({ ...base, sdkHeader: 'node-v1', bootstrapCommitment: 'committed' }))
      .toBe('Circlus SDK (Node)');
    expect(admittedDeviceEnrollmentSource({ ...base, sdkHeader: undefined, bootstrapCommitment: 'committed' }))
      .toBeNull();
    expect(admittedDeviceEnrollmentSource({ ...base, sdkHeader: 'node-v1', bootstrapCommitment: null }))
      .toBeNull();
  });
});
