import {
  booleanSetting,
  integerSetting,
  optionalBase64Secret,
  optionalHttpUrl,
  optionalString,
  ServerConfigurationError
} from './runtimeConfigParsing';

export type IntegrationRuntimeConfig = {
  ice: {
    serviceUrl: string | null;
    vpsId: string;
    keyId: string;
    sharedSecretBase64: string | null;
    subjectIdSecretBase64: string | null;
    timeoutMs: number;
  };
  push: {
    relayDeliveryEnabled: boolean;
    serviceUrl: string | null;
    clientId: string | null;
    keyId: string;
    sharedSecretBase64: string | null;
  };
  mobileCalls: { actionSecret: string | null };
};

export function loadIntegrationRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): IntegrationRuntimeConfig {
  const iceServiceUrl = optionalHttpUrl(environment, 'ICE_CONFIG_SERVICE_URL');
  const iceServerId = optionalString(environment, 'ICE_CONFIG_SERVER_ID')
    || optionalString(environment, 'VPS_ID')
    || '';
  const iceSecret = optionalBase64Secret(environment, 'ICE_CONFIG_SHARED_SECRET');
  const iceSubjectIdSecret = optionalBase64Secret(environment, 'ICE_SUBJECT_ID_SECRET')
    || iceSecret;
  if (iceServiceUrl && !iceServerId) {
    throw new ServerConfigurationError(
      'ICE_CONFIG_SERVER_ID',
      'or VPS_ID is required when ICE_CONFIG_SERVICE_URL is configured'
    );
  }
  if (iceServiceUrl && !iceSecret) {
    throw new ServerConfigurationError(
      'ICE_CONFIG_SHARED_SECRET',
      'is required when ICE_CONFIG_SERVICE_URL is configured'
    );
  }

  const relayDeliveryEnabled = booleanSetting({
    environment, key: 'ENABLE_RELAY_DELIVERY', defaultValue: false
  });
  const pushServiceUrl = optionalHttpUrl(environment, 'PUSH_SERVICE_URL');
  if (relayDeliveryEnabled && !pushServiceUrl) {
    throw new ServerConfigurationError(
      'PUSH_SERVICE_URL',
      'is required when ENABLE_RELAY_DELIVERY is enabled'
    );
  }
  const pushClientId = optionalString(environment, 'PUSH_SERVICE_CLIENT_ID');
  const pushSecret = optionalBase64Secret(environment, 'PUSH_SERVICE_SHARED_SECRET');
  if (pushServiceUrl && !pushClientId) {
    throw new ServerConfigurationError(
      'PUSH_SERVICE_CLIENT_ID',
      'is required when PUSH_SERVICE_URL is configured'
    );
  }
  if (pushServiceUrl && !pushSecret) {
    throw new ServerConfigurationError(
      'PUSH_SERVICE_SHARED_SECRET',
      'is required when PUSH_SERVICE_URL is configured'
    );
  }

  const mobileCallActionSecret = optionalString(environment, 'MOBILE_CALL_ACTION_SECRET');
  if (mobileCallActionSecret && Buffer.byteLength(mobileCallActionSecret, 'utf8') < 32) {
    throw new ServerConfigurationError(
      'MOBILE_CALL_ACTION_SECRET',
      'must contain at least 32 bytes when configured'
    );
  }

  return {
    ice: {
      serviceUrl: iceServiceUrl,
      vpsId: iceServerId,
      keyId: optionalString(environment, 'ICE_CONFIG_KEY_ID') || 'k1',
      sharedSecretBase64: iceSecret,
      subjectIdSecretBase64: iceSubjectIdSecret,
      timeoutMs: integerSetting({
        environment, key: 'ICE_CONFIG_TIMEOUT_MS', defaultValue: 3_000, min: 500, max: 60_000
      })
    },
    push: {
      relayDeliveryEnabled,
      serviceUrl: pushServiceUrl,
      clientId: pushClientId,
      keyId: optionalString(environment, 'PUSH_SERVICE_KEY_ID') || 'k1',
      sharedSecretBase64: pushSecret
    },
    mobileCalls: { actionSecret: mobileCallActionSecret }
  };
}
