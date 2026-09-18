import type { DBFamilyConfig } from '../db/types';

export type MessageArchivePolicyMode = 'disabled' | 'text' | 'text_with_attachments';

const MODE_RANK: Record<MessageArchivePolicyMode, number> = {
  disabled: 0,
  text: 1,
  text_with_attachments: 2
};

export function normalizeMessageArchivePolicyMode(value: unknown): MessageArchivePolicyMode {
  return value === 'disabled' || value === 'text_with_attachments' || value === 'text'
    ? value
    : 'text';
}

export function isMessageArchiveModeAllowed(params: {
  requested: MessageArchivePolicyMode;
  allowed: MessageArchivePolicyMode;
}): boolean {
  return MODE_RANK[params.requested] <= MODE_RANK[params.allowed];
}

export function getEffectiveMessageArchivePolicy(config: DBFamilyConfig | null | undefined): {
  serverPolicy: MessageArchivePolicyMode;
  serverMaxBytes: number | null;
  circlePolicy: MessageArchivePolicyMode;
  circleMaxBytes: number | null;
} {
  const serverPolicy = normalizeMessageArchivePolicyMode(config?.message_archive_server_policy);
  const rawCirclePolicy = normalizeMessageArchivePolicyMode(config?.message_archive_circle_policy);
  const circlePolicy = isMessageArchiveModeAllowed({ requested: rawCirclePolicy, allowed: serverPolicy })
    ? rawCirclePolicy
    : serverPolicy;

  const rawServerMaxBytes = typeof config?.message_archive_server_max_bytes === 'number'
    ? config.message_archive_server_max_bytes
    : config?.message_archive_server_max_bytes
      ? Number(config.message_archive_server_max_bytes)
      : null;
  const rawCircleMaxBytes = typeof config?.message_archive_circle_max_bytes === 'number'
    ? config.message_archive_circle_max_bytes
    : config?.message_archive_circle_max_bytes
      ? Number(config.message_archive_circle_max_bytes)
      : null;
  const serverMaxBytes = Number.isFinite(rawServerMaxBytes) && rawServerMaxBytes !== null && rawServerMaxBytes > 0
    ? Math.floor(rawServerMaxBytes)
    : null;
  const normalizedCircleMaxBytes = Number.isFinite(rawCircleMaxBytes) && rawCircleMaxBytes !== null && rawCircleMaxBytes > 0
    ? Math.floor(rawCircleMaxBytes)
    : null;
  const circleMaxBytes = serverMaxBytes !== null && normalizedCircleMaxBytes !== null
    ? Math.min(serverMaxBytes, normalizedCircleMaxBytes)
    : normalizedCircleMaxBytes ?? serverMaxBytes ?? null;

  return {
    serverPolicy,
    serverMaxBytes,
    circlePolicy,
    circleMaxBytes
  };
}
