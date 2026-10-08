import { getEffectiveTrustedClientOrigins, isTrustedClientOrigin, normalizeTrustedOrigin, parseTrustedOriginsList } from './trustedOrigins';

const IOS_ORIGIN = 'org.circlus.client://app';

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
      IOS_ORIGIN,
      'https://app.example.com',
      'https://test.example.com',
      'https://custom.example.com'
    ]);
    expect(isTrustedClientOrigin('https://web.circlus.org', config)).toBe(true);
    expect(isTrustedClientOrigin('https://custom.example.com', config)).toBe(true);
    expect(isTrustedClientOrigin('https://unknown.example.com', config)).toBe(false);
  });

  test('trusts only the official clients when no additional origins are configured', () => {
    delete process.env.TRUSTED_CLIENT_ORIGINS;

    expect(getEffectiveTrustedClientOrigins(null)).toEqual(['https://web.circlus.org', IOS_ORIGIN]);
    expect(isTrustedClientOrigin('https://web.circlus.org', null)).toBe(true);
    expect(isTrustedClientOrigin(IOS_ORIGIN, null)).toBe(true);
    expect(isTrustedClientOrigin('https://ru.circlus.org', null)).toBe(false);
    expect(isTrustedClientOrigin('https://eu.circlus.org', null)).toBe(false);
  });

  test('accepts exactly the iOS bundled client among non-HTTP origins', () => {
    expect(normalizeTrustedOrigin(IOS_ORIGIN)).toBe(IOS_ORIGIN);
    expect(normalizeTrustedOrigin('ORG.CIRCLUS.CLIENT://APP/')).toBe(IOS_ORIGIN);
    expect(normalizeTrustedOrigin('org.circlus.client://other')).toBeNull();
    expect(normalizeTrustedOrigin('org.circlus.client://app:8080')).toBeNull();
    expect(normalizeTrustedOrigin('org.circlus.client://user@app')).toBeNull();
    expect(normalizeTrustedOrigin('circlus://app')).toBeNull();
    expect(normalizeTrustedOrigin('capacitor://localhost')).toBeNull();
    expect(normalizeTrustedOrigin('file:///index.html')).toBeNull();
  });

  test('an operator cannot add other custom-scheme origins', () => {
    process.env.TRUSTED_CLIENT_ORIGINS = 'circlus://app,ionic://localhost';
    expect(getEffectiveTrustedClientOrigins(null)).toEqual(['https://web.circlus.org', IOS_ORIGIN]);
    const config = { extra_trusted_client_origins: ['capacitor://localhost'] } as any;
    expect(isTrustedClientOrigin('capacitor://localhost', config)).toBe(false);
  });
});
