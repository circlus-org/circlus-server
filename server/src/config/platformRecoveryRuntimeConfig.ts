export type PlatformRecoveryRuntimeConfig = { enabled: boolean };

export function loadPlatformRecoveryRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): PlatformRecoveryRuntimeConfig {
  return { enabled: environment.PLATFORM_RECOVERY_ENABLED === 'true' };
}
