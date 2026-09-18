import { loadPlatformRecoveryRuntimeConfig } from './platformRecoveryRuntimeConfig';

describe('platform recovery runtime config', () => {
  test('is disabled by default and requires an exact explicit opt-in', () => {
    expect(loadPlatformRecoveryRuntimeConfig({})).toEqual({ enabled: false });
    expect(loadPlatformRecoveryRuntimeConfig({ PLATFORM_RECOVERY_ENABLED: 'TRUE' })).toEqual({ enabled: false });
    expect(loadPlatformRecoveryRuntimeConfig({ PLATFORM_RECOVERY_ENABLED: 'true' })).toEqual({ enabled: true });
  });
});
