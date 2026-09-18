import { getEffectiveTrustedClientOrigins, isTrustedClientOrigin, normalizeTrustedOrigin, parseTrustedOriginsList } from './trustedOrigins';

describe('trustedOrigins', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('normalizes canonical origin form', () => {
    expect(normalizeTrustedOrigin(' https://App.Example.com/path?q=1 ')).toBe('https://app.example.com');
    expect(normalizeTrustedOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeTrustedOrigin('')).toBeNull();
  });

  test('parses env list and removes invalid entries and duplicates', () => {
    expect(parseTrustedOriginsList('https://app.example.com, https://APP.example.com ,notaurl')).toEqual([
      'https://app.example.com'
    ]);
  });

  test('combines global env and family trusted origins', () => {
    process.env.TRUSTED_CLIENT_ORIGINS = 'https://app.example.com,https://test.example.com';

    const config = {
      extra_trusted_client_origins: ['https://custom.example.com', 'https://APP.example.com']
    } as any;

    expect(getEffectiveTrustedClientOrigins(config)).toEqual([
      'https://web.circlus.org',
      'https://app.example.com',
      'https://test.example.com',
      'https://custom.example.com'
    ]);
    expect(isTrustedClientOrigin('https://web.circlus.org', config)).toBe(true);
    expect(isTrustedClientOrigin('https://custom.example.com', config)).toBe(true);
    expect(isTrustedClientOrigin('https://unknown.example.com', config)).toBe(false);
  });

  test('trusts only the official web client when no additional origins are configured', () => {
    delete process.env.TRUSTED_CLIENT_ORIGINS;

    expect(getEffectiveTrustedClientOrigins(null)).toEqual(['https://web.circlus.org']);
    expect(isTrustedClientOrigin('https://web.circlus.org', null)).toBe(true);
    expect(isTrustedClientOrigin('https://ru.circlus.org', null)).toBe(false);
    expect(isTrustedClientOrigin('https://eu.circlus.org', null)).toBe(false);
  });
});
