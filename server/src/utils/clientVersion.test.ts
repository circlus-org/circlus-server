import { normalizeClientVersion } from './clientVersion';

describe('normalizeClientVersion', () => {
  test('keeps a well-formed client build', () => {
    expect(normalizeClientVersion(' ios 1.0 (12) web 2026.10.07-abc ')).toBe('ios 1.0 (12) web 2026.10.07-abc');
    expect(normalizeClientVersion('web 2026.10.07-abc123')).toBe('web 2026.10.07-abc123');
  });

  test('drops missing, oversized and unexpected values', () => {
    expect(normalizeClientVersion(undefined)).toBeNull();
    expect(normalizeClientVersion('')).toBeNull();
    expect(normalizeClientVersion('x'.repeat(81))).toBeNull();
    expect(normalizeClientVersion('web <script>')).toBeNull();
    expect(normalizeClientVersion('web\n1.0')).toBeNull();
  });
});
