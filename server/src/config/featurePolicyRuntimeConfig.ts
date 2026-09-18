import { integerSetting } from './runtimeConfigParsing';

export type FeaturePolicyRuntimeConfig = {
  presence: { onlineWindowSeconds: number };
  callLinks: { ttlHours: number };
  deviceEnrollments: { reservationTtlMs: number; payloadTtlMs: number };
  messages: { maxCiphertextBytes: number };
  groupChats: {
    titleMaxLength: number;
    createParticipantsMax: number;
    addParticipantsBatchMax: number;
    messageMaxBytes: number;
    messagesListMaxLimit: number;
  };
  temporaryAccess: { trustedRequestTtlMs: number; renewalRequestTtlMs: number };
};

export function loadFeaturePolicyRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): FeaturePolicyRuntimeConfig {
  const maxCiphertextBytes = integerSetting({
    environment, key: 'MAX_MESSAGE_BYTES', defaultValue: 16_384, min: 1_024, max: 10 * 1024 * 1024
  });
  return {
    presence: {
      onlineWindowSeconds: integerSetting({
        environment, key: 'PRESENCE_ONLINE_WINDOW_SECONDS', defaultValue: 75, min: 30, max: 300
      })
    },
    callLinks: {
      ttlHours: integerSetting({
        environment, key: 'CALL_LINK_TTL_HOURS', defaultValue: 72, min: 1, max: 365 * 24
      })
    },
    deviceEnrollments: {
      reservationTtlMs: integerSetting({
        environment,
        key: 'DEVICE_ENROLLMENT_TTL_MS',
        defaultValue: 600_000,
        min: 60_000,
        max: 24 * 60 * 60 * 1000
      }),
      payloadTtlMs: integerSetting({
        environment,
        key: 'DEVICE_ENROLLMENT_PAYLOAD_TTL_MS',
        defaultValue: 600_000,
        min: 60_000,
        max: 24 * 60 * 60 * 1000
      })
    },
    messages: { maxCiphertextBytes },
    groupChats: {
      titleMaxLength: integerSetting({
        environment, key: 'GROUP_CHAT_TITLE_MAX_LEN', defaultValue: 120, min: 1, max: 10_000
      }),
      createParticipantsMax: integerSetting({
        environment, key: 'GROUP_CHAT_CREATE_PARTICIPANTS_MAX', defaultValue: 64, min: 1, max: 10_000
      }),
      addParticipantsBatchMax: integerSetting({
        environment, key: 'GROUP_CHAT_ADD_BATCH_MAX', defaultValue: 32, min: 1, max: 10_000
      }),
      messageMaxBytes: integerSetting({
        environment,
        key: 'GROUP_CHAT_MESSAGE_MAX_BYTES',
        defaultValue: maxCiphertextBytes,
        min: 1_024,
        max: 10 * 1024 * 1024
      }),
      messagesListMaxLimit: integerSetting({
        environment, key: 'GROUP_CHAT_MESSAGES_LIST_MAX_LIMIT', defaultValue: 500, min: 1, max: 10_000
      })
    },
    temporaryAccess: {
      trustedRequestTtlMs: integerSetting({
        environment,
        key: 'TEMPORARY_TRUSTED_ACCESS_REQUEST_TTL_MS',
        defaultValue: 600_000,
        min: 60_000,
        max: 24 * 60 * 60 * 1000
      }),
      renewalRequestTtlMs: integerSetting({
        environment,
        key: 'TEMPORARY_RENEWAL_REQUEST_TTL_MS',
        defaultValue: 600_000,
        min: 60_000,
        max: 24 * 60 * 60 * 1000
      })
    }
  };
}
