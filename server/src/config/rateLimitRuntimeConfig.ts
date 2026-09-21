import { rateLimitMax, rateLimitWindow } from './runtimeConfigParsing';

export type RateLimitRuntimeConfig = {
  communicationIdentity: { windowMs: number; readMax: number; writeMax: number };
  auth: {
    windowMs: number;
    checkInviteMax: number;
    registerMax: number;
    registerDeviceMax: number;
    identityEncryptedKeyMax: number;
  };
  circleMigration: {
    verify: { windowMs: number; max: number };
    session: { windowMs: number; max: number };
  };
  config: {
    windowMs: number;
    iceServersMax: number;
    turnCredentialsMax: number;
    serverNameMax: number;
    capabilitiesMax: number;
  };
  deviceEnrollments: { windowMs: number; createMax: number; payloadMax: number };
  groupChats: { windowMs: number; max: number };
  hostProvisioning: { windowMs: number; max: number };
  identities: { windowMs: number; directoryMax: number; avatarUploadMax: number };
  links: { windowMs: number; max: number };
  messages: { windowMs: number; max: number };
  push: { windowMs: number; vapidKeyMax: number; mutationsMax: number };
  temporaryAccess: { windowMs: number; contactCreateMax: number };
};

export function loadRateLimitRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): RateLimitRuntimeConfig {
  return {
    communicationIdentity: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_COMMUNICATION_IDENTITY_WINDOW_MS'),
      readMax: rateLimitMax(environment, 'RATE_LIMIT_COMMUNICATION_IDENTITY_READ_MAX', 600),
      writeMax: rateLimitMax(environment, 'RATE_LIMIT_COMMUNICATION_IDENTITY_WRITE_MAX', 240)
    },
    auth: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_AUTH_WINDOW_MS'),
      checkInviteMax: rateLimitMax(environment, 'RATE_LIMIT_AUTH_CHECK_INVITE_MAX', 30),
      registerMax: rateLimitMax(environment, 'RATE_LIMIT_AUTH_REGISTER_MAX', 10),
      registerDeviceMax: rateLimitMax(environment, 'RATE_LIMIT_AUTH_REGISTER_DEVICE_MAX', 20),
      identityEncryptedKeyMax: rateLimitMax(environment, 'RATE_LIMIT_AUTH_IDENTITY_ENCRYPTED_KEY_MAX', 30)
    },
    circleMigration: {
      verify: {
        windowMs: rateLimitWindow(environment, 'RATE_LIMIT_MIGRATION_VERIFY_WINDOW_MS'),
        max: rateLimitMax(environment, 'RATE_LIMIT_MIGRATION_VERIFY_MAX', 10)
      },
      session: {
        windowMs: rateLimitWindow(environment, 'RATE_LIMIT_MIGRATION_SESSION_WINDOW_MS'),
        max: rateLimitMax(environment, 'RATE_LIMIT_MIGRATION_SESSION_MAX', 120)
      }
    },
    config: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_CONFIG_WINDOW_MS'),
      iceServersMax: rateLimitMax(environment, 'RATE_LIMIT_CONFIG_ICE_SERVERS_MAX', 120),
      turnCredentialsMax: rateLimitMax(environment, 'RATE_LIMIT_CONFIG_TURN_CREDENTIALS_MAX', 60),
      serverNameMax: rateLimitMax(environment, 'RATE_LIMIT_CONFIG_SERVER_NAME_MAX', 120),
      capabilitiesMax: rateLimitMax(environment, 'RATE_LIMIT_CONFIG_CAPABILITIES_MAX', 120)
    },
    deviceEnrollments: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_DEVICE_ENROLLMENTS_WINDOW_MS'),
      createMax: rateLimitMax(environment, 'RATE_LIMIT_DEVICE_ENROLLMENTS_CREATE_MAX', 20),
      payloadMax: rateLimitMax(environment, 'RATE_LIMIT_DEVICE_ENROLLMENTS_PAYLOAD_MAX', 60)
    },
    groupChats: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_GROUP_CHATS_WINDOW_MS'),
      max: rateLimitMax(environment, 'RATE_LIMIT_GROUP_CHATS_MAX', 240)
    },
    hostProvisioning: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_HOST_PROVISIONING_WINDOW_MS'),
      max: rateLimitMax(environment, 'RATE_LIMIT_HOST_PROVISIONING_MAX', 10)
    },
    identities: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_IDENTITIES_WINDOW_MS'),
      directoryMax: rateLimitMax(environment, 'RATE_LIMIT_IDENTITIES_DIRECTORY_MAX', 60),
      avatarUploadMax: rateLimitMax(environment, 'RATE_LIMIT_IDENTITIES_AVATAR_UPLOAD_MAX', 10)
    },
    links: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_LINK_RESOLVE_WINDOW_MS'),
      max: rateLimitMax(environment, 'RATE_LIMIT_LINK_RESOLVE_MAX', 60)
    },
    messages: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_MESSAGES_WINDOW_MS'),
      max: rateLimitMax(environment, 'RATE_LIMIT_MESSAGES_MAX', 240)
    },
    push: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_PUSH_WINDOW_MS'),
      vapidKeyMax: rateLimitMax(environment, 'RATE_LIMIT_PUSH_VAPID_KEY_MAX', 120),
      mutationsMax: rateLimitMax(environment, 'RATE_LIMIT_PUSH_MUTATIONS_MAX', 120)
    },
    temporaryAccess: {
      windowMs: rateLimitWindow(environment, 'RATE_LIMIT_TEMPORARY_ACCESS_WINDOW_MS'),
      contactCreateMax: rateLimitMax(environment, 'RATE_LIMIT_TEMPORARY_CONTACT_CREATE_MAX', 20)
    }
  };
}
