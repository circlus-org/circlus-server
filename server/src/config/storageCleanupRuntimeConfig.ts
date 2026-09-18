import path from 'node:path';
import {
  bodyLimitSetting,
  byteSizeInBytes,
  integerSetting,
  resolvedPath
} from './runtimeConfigParsing';

export type StorageRuntimeConfig = {
  attachments: {
    rootDir: string;
    tmpDir: string;
    maxHttpBody: string;
    maxHttpBodyBytes: number;
    maxConcurrentUploads: number;
    reservationTtlMs: number;
    minFreeDiskBytes: number;
  };
  publicSite: { rootDir: string; assetsDir: string; assetsTmpDir: string };
};

export type CleanupRuntimeConfig = {
  messageTtlHours: number;
  publicSiteAssetReadyTtlHours: number;
  systemEventTtlHours: number;
  callHistoryTtlHours: number;
  callHistoryHeartbeatTimeoutMs: number;
  callHistoryHeartbeatSweepMs: number;
  inviteCleanupIntervalHours: number;
};

export function loadStorageRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): StorageRuntimeConfig {
  const attachmentRoot = resolvedPath(
    environment,
    'ATTACHMENTS_STORAGE_DIR',
    path.resolve(process.cwd(), 'server-data', 'attachments')
  );
  const publicSiteAssetsRoot = resolvedPath(
    environment,
    'PUBLIC_SITE_ASSETS_DIR',
    path.resolve(process.cwd(), 'server-data', 'public-site-assets')
  );
  const maxHttpBody = bodyLimitSetting(environment, 'ATTACHMENTS_MAX_HTTP_BODY', '250mb');
  return {
    attachments: {
      rootDir: attachmentRoot,
      tmpDir: resolvedPath(environment, 'ATTACHMENTS_TMP_DIR', path.join(attachmentRoot, '_tmp')),
      maxHttpBody,
      maxHttpBodyBytes: byteSizeInBytes(maxHttpBody),
      maxConcurrentUploads: integerSetting({
        environment, key: 'ATTACHMENTS_MAX_CONCURRENT_UPLOADS', defaultValue: 2, min: 1, max: 1_000
      }),
      reservationTtlMs: integerSetting({
        environment,
        key: 'ATTACHMENTS_RESERVATION_TTL_MS',
        defaultValue: 15 * 60 * 1000,
        min: 60_000,
        max: 24 * 60 * 60 * 1000
      }),
      minFreeDiskBytes: integerSetting({
        environment,
        key: 'ATTACHMENTS_MIN_FREE_DISK_BYTES',
        defaultValue: 256 * 1024 * 1024,
        min: 0,
        max: Number.MAX_SAFE_INTEGER
      })
    },
    publicSite: {
      rootDir: resolvedPath(
        environment,
        'PUBLIC_SITE_STORAGE_DIR',
        path.resolve(process.cwd(), 'server-data', 'sites')
      ),
      assetsDir: publicSiteAssetsRoot,
      assetsTmpDir: resolvedPath(
        environment,
        'PUBLIC_SITE_ASSETS_TMP_DIR',
        path.join(publicSiteAssetsRoot, '_tmp')
      )
    }
  };
}

export function loadCleanupRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): CleanupRuntimeConfig {
  return {
    messageTtlHours: integerSetting({
      environment, key: 'MESSAGE_TTL_HOURS', defaultValue: 24, min: 1, max: 10 * 365 * 24
    }),
    publicSiteAssetReadyTtlHours: integerSetting({
      environment, key: 'PUBLIC_SITE_ASSET_READY_TTL_HOURS', defaultValue: 24, min: 1, max: 10 * 365 * 24
    }),
    systemEventTtlHours: integerSetting({
      environment, key: 'SYSTEM_EVENT_TTL_HOURS', defaultValue: 168, min: 1, max: 10 * 365 * 24
    }),
    callHistoryTtlHours: integerSetting({
      environment, key: 'CALL_HISTORY_TTL_HOURS', defaultValue: 72, min: 1, max: 10 * 365 * 24
    }),
    callHistoryHeartbeatTimeoutMs: integerSetting({
      environment,
      key: 'CALL_HISTORY_HEARTBEAT_TIMEOUT_MS',
      defaultValue: 45_000,
      min: 15_000,
      max: 60 * 60 * 1000
    }),
    callHistoryHeartbeatSweepMs: integerSetting({
      environment,
      key: 'CALL_HISTORY_HEARTBEAT_SWEEP_MS',
      defaultValue: 60_000,
      min: 15_000,
      max: 60 * 60 * 1000
    }),
    inviteCleanupIntervalHours: integerSetting({
      environment, key: 'INVITE_CLEANUP_INTERVAL_HOURS', defaultValue: 24, min: 1, max: 365 * 24
    })
  };
}
