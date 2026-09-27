import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadCallRuntimeConfig,
  loadCircleMigrationRuntimeConfig,
  loadCleanupRuntimeConfig,
  loadFeaturePolicyRuntimeConfig,
  loadHttpRuntimeConfig,
  loadIntegrationRuntimeConfig,
  loadRateLimitRuntimeConfig,
  loadPublicAccessRuntimeConfig,
  loadSecurityRuntimeConfig,
  loadServerRuntimeConfig,
  loadStorageRuntimeConfig,
  parseTrustProxySetting,
  ServerConfigurationError
} from './serverRuntimeConfig';

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', VPS_ID: 'test-vps', ...overrides };
}

describe('server runtime config', () => {
  it('keeps the public config entry point as a compact acyclic aggregator', () => {
    const configRoot = path.resolve(process.cwd(), 'src', 'config');
    const aggregator = fs.readFileSync(path.join(configRoot, 'serverRuntimeConfig.ts'), 'utf8');
    expect(aggregator.split('\n').length).toBeLessThan(300);

    const domainModules = [
      'callRuntimeConfig.ts',
      'circleMigrationRuntimeConfig.ts',
      'cliRuntimeConfig.ts',
      'featurePolicyRuntimeConfig.ts',
      'integrationRuntimeConfig.ts',
      'loggingRuntimeConfig.ts',
      'publicAccessRuntimeConfig.ts',
      'rateLimitRuntimeConfig.ts',
      'securityHttpRuntimeConfig.ts',
      'storageCleanupRuntimeConfig.ts'
    ];
    for (const moduleName of domainModules) {
      const source = fs.readFileSync(path.join(configRoot, moduleName), 'utf8');
      expect(source).not.toContain("from './serverRuntimeConfig'");
    }
  });

  it('loads documented development defaults into a typed object', () => {
    expect(loadServerRuntimeConfig(environment())).toEqual({
      nodeEnvironment: 'test',
      databaseUrl: 'postgresql://localhost:5432/family_messenger',
      vpsId: 'test-vps',
      port: 3000,
      trustProxy: false,
      security: {
        nonceWindowMs: 300_000,
        maxTimestampDriftMs: 60_000,
        allowInsecureHttp: true,
        trustForwardedHost: false
      },
      http: {
        jsonBodyLimits: {
          default: '1mb',
          messageArchive: '2mb',
          vault: '8mb'
        },
        globalRateLimit: {
          windowMs: 60_000,
          max: 600
        }
      },
      webSocket: {
        limits: {
          maxOutgoingMessages: 256,
          maxGlobalOutgoingMessages: 8192,

          maxUnregisteredConnections: 64,
          maxConnections: 256, softMaxConnections: 192,
          maxConnectionsPerIp: 128,
          handshakeTimeoutMs: 10000,
          registrationTimeoutMs: 30000,
          maxQueuedMessages: 128,
          maxQueuedBytes: 4194304,
          maxUnregisteredMessages: 8,
          maxUnregisteredBytes: 262144,
          maxGlobalQueuedMessages: 4096,
          maxGlobalQueuedBytes: 33554432,
          maxOutgoingBytes: 8388608,
          maxGlobalOutgoingBytes: 67108864
        },
        path: '/ws',
        heartbeatIntervalMs: 30_000,
        maxPayloadBytes: 1024 * 1024,
        maxSyncBatch: 100,
        callHistorySyncBatch: 200,
        systemEventSyncBatch: 200,
        presenceTouchIntervalMs: 30_000,
        rateLimit: {
          general: 50,
          callSignaling: 200,
          callEnd: 300
        }
      },
      calls: {
        ringTimeoutMs: 65_000,
        signalingRecoveryGraceMs: 120_000,
        cancellationDeliveredGraceMs: 3_000,
        cancellationNoDeliveryFallbackMs: 10_000,
        pushRepeatIntervalMs: 5_000,
        pushRepeatMaxAttempts: 1,
        signalingDiagnostics: false,
        iceDiagnostics: false,
        httpSignaling: {
          maxSessions: 512, maxSessionsPerIp: 128, maxQueueBytes: 4194304, maxGlobalBytes: 33554432,
          sessionTtlMs: 900_000,
          maxPollMs: 10_000,
          maxQueue: 500
        }
      },
      integrations: {
        ice: {
          serviceUrl: null,
          vpsId: 'test-vps',
          keyId: 'k1',
          sharedSecretBase64: null,
          subjectIdSecretBase64: null,
          timeoutMs: 3_000
        },
        push: {
          relayDeliveryEnabled: false,
          serviceUrl: null,
          clientId: null,
          keyId: 'k1',
          sharedSecretBase64: null
        },
        mobileCalls: {
          actionSecret: null
        }
      },
      storage: {
        attachments: {
          rootDir: path.resolve(process.cwd(), 'server-data', 'attachments'),
          tmpDir: path.resolve(process.cwd(), 'server-data', 'attachments', '_tmp'),
          maxHttpBody: '250mb',
          maxHttpBodyBytes: 250 * 1024 * 1024,
          maxConcurrentUploads: 2,
          reservationTtlMs: 900_000,
          minFreeDiskBytes: 256 * 1024 * 1024
        },
        publicSite: {
          rootDir: path.resolve(process.cwd(), 'server-data', 'sites'),
          assetsDir: path.resolve(process.cwd(), 'server-data', 'public-site-assets'),
          assetsTmpDir: path.resolve(
            process.cwd(),
            'server-data',
            'public-site-assets',
            '_tmp'
          )
        }
      },
      cleanup: {
        messageTtlHours: 24,
        publicSiteAssetReadyTtlHours: 24,
        systemEventTtlHours: 168,
        callHistoryTtlHours: 72,
        callHistoryHeartbeatTimeoutMs: 45_000,
        callHistoryHeartbeatSweepMs: 60_000,
        inviteCleanupIntervalHours: 24
      },
      circleMigration: {
        secretKeyBase64: null,
        exportDir: path.resolve(process.cwd(), 'server-data', 'circle-migrations'),
        importDir: path.resolve(process.cwd(), 'server-data', 'circle-migration-imports'),
        httpTimeoutMs: 10_000,
        freezeDrainTimeoutMs: 60_000
      },
      rateLimits: {
        communicationIdentity: { windowMs: 60_000, readMax: 600, writeMax: 240 },
        auth: {
          windowMs: 60_000,
          checkInviteMax: 30,
          registerMax: 10,
          registerDeviceMax: 20,
          identityEncryptedKeyMax: 30
        },
        circleMigration: {
          verify: { windowMs: 60_000, max: 10 },
          session: { windowMs: 60_000, max: 120 }
        },
        config: {
          windowMs: 60_000,
          iceServersMax: 120,
          turnCredentialsMax: 60,
          serverNameMax: 120,
          capabilitiesMax: 120
        },
        deviceEnrollments: {
          windowMs: 60_000,
          createMax: 20,
          payloadMax: 60
        },
        groupChats: { windowMs: 60_000, max: 240 },
        hostProvisioning: { windowMs: 60_000, max: 10 },
        identities: { windowMs: 60_000, directoryMax: 60, avatarUploadMax: 10 },
        links: { windowMs: 60_000, max: 60 },
        messages: { windowMs: 60_000, max: 240 },
        push: {
          windowMs: 60_000,
          vapidKeyMax: 120,
          mutationsMax: 120
        },
        temporaryAccess: {
          windowMs: 60_000,
          contactCreateMax: 20
        }
      },
      featurePolicies: {
        presence: { onlineWindowSeconds: 75 },
        callLinks: { ttlHours: 72 },
        deviceEnrollments: { reservationTtlMs: 600_000, payloadTtlMs: 600_000 },
        messages: { maxCiphertextBytes: 16_384 },
        groupChats: {
          titleMaxLength: 120,
          createParticipantsMax: 64,
          addParticipantsBatchMax: 32,
          messageMaxBytes: 16_384,
          messagesListMaxLimit: 500
        },
        temporaryAccess: { trustedRequestTtlMs: 600_000, renewalRequestTtlMs: 600_000 }
      },
      publicAccess: {
        appOpenUrl: 'https://web.circlus.org/open',
        publicSiteProductUrl: 'https://circlus.org',
        blockedPublicSiteDomainSuffixes: ['space.circlus.org'],
        trustedClientOrigins: ['https://web.circlus.org'],
        tenantValidation: { dnsCheck: true, tlsCheck: true, tlsTimeoutMs: 5_000 }
      },
      logging: {
        level: 'silent',
        format: 'pretty'
      },
      largeJsonRequestLogThresholdBytes: 100 * 1024,
      shutdownGracePeriodMs: 30_000
    });
  });

  it('requires an explicit database URL in production', () => {
    expect(() => loadServerRuntimeConfig(environment({ NODE_ENV: 'production' })))
      .toThrow('DATABASE_URL is required in production');
  });

  it('requires a stable VPS identifier in every environment', () => {
    expect(() => loadServerRuntimeConfig({ NODE_ENV: 'test' }))
      .toThrow('VPS_ID is required');
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['WS_HEARTBEAT_INTERVAL_MS', 'fast'],
    ['WS_MAX_PAYLOAD_BYTES', '100'],
    ['SHUTDOWN_GRACE_PERIOD_MS', '-1']
  ])('rejects invalid %s=%s instead of silently changing behavior', (key, value) => {
    expect(() => loadServerRuntimeConfig(environment({ [key]: value })))
      .toThrow(ServerConfigurationError);
  });

  it('validates URL-like settings used during startup', () => {
    expect(() => loadServerRuntimeConfig(environment({ DATABASE_URL: 'mysql://localhost/db' })))
      .toThrow('DATABASE_URL must use a postgres:// or postgresql:// URL');
    expect(() => loadServerRuntimeConfig(environment({ WS_PATH: 'ws' })))
      .toThrow('WS_PATH must be an absolute URL path');
  });

  it('normalizes trust proxy without enabling unrestricted true', () => {
    expect(parseTrustProxySetting(undefined)).toBe(false);
    expect(parseTrustProxySetting('off')).toBe(false);
    expect(parseTrustProxySetting('true')).toBe(1);
    expect(parseTrustProxySetting('2')).toBe(2);
    expect(parseTrustProxySetting('loopback')).toBe('loopback');
  });

  it('loads security settings with production-safe defaults and strict booleans', () => {
    expect(loadSecurityRuntimeConfig(environment({
      NODE_ENV: 'production',
      SECURITY_ALLOW_INSECURE_HTTP: 'false',
      TENANCY_TRUST_FORWARDED_HOST: 'yes'
    }))).toEqual({
      nonceWindowMs: 300_000,
      maxTimestampDriftMs: 60_000,
      allowInsecureHttp: false,
      trustForwardedHost: true
    });
    expect(() => loadSecurityRuntimeConfig(environment({
      SECURITY_ALLOW_INSECURE_HTTP: 'sometimes'
    }))).toThrow('SECURITY_ALLOW_INSECURE_HTTP must be a boolean');
  });

  it('validates HTTP body limits and global rate limits', () => {
    expect(loadHttpRuntimeConfig(environment({
      API_JSON_LIMIT: '1536kb',
      RATE_LIMIT_GLOBAL_MAX: '900'
    }))).toMatchObject({
      jsonBodyLimits: { default: '1536kb' },
      globalRateLimit: { max: 900 }
    });
    expect(() => loadHttpRuntimeConfig(environment({ API_JSON_LIMIT: 'large' })))
      .toThrow('API_JSON_LIMIT must be a byte size');
  });

  it('loads and bounds call, presence, and HTTP signaling settings', () => {
    expect(loadCallRuntimeConfig(environment({
      CALL_RING_TIMEOUT_MS: '70000',
      CALL_SIGNALING_RECOVERY_GRACE_MS: '45000',
      CALL_SIGNALING_DIAGNOSTICS: 'true',
      HTTP_CALL_SIGNALING_MAX_QUEUE: '750'
    }))).toMatchObject({
      webSocket: { presenceTouchIntervalMs: 30_000 },
      calls: {
        ringTimeoutMs: 70_000,
        signalingRecoveryGraceMs: 45_000,
        signalingDiagnostics: true,
        httpSignaling: { maxQueue: 750 }
      }
    });
    expect(() => loadCallRuntimeConfig(environment({
      CALL_SIGNALING_RECOVERY_GRACE_MS: '9999'
    }))).toThrow('CALL_SIGNALING_RECOVERY_GRACE_MS must be between 10000 and 300000');
    expect(() => loadCallRuntimeConfig(environment({
      PRESENCE_WS_TOUCH_INTERVAL_MS: '1000'
    }))).toThrow('PRESENCE_WS_TOUCH_INTERVAL_MS must be between 15000 and 120000');
  });

  it('validates conditional ICE and push-service configuration', () => {
    const secret = Buffer.alloc(32, 7).toString('base64');
    expect(() => loadIntegrationRuntimeConfig(environment({
      ICE_CONFIG_SERVICE_URL: 'https://ice.example.test'
    }))).toThrow('ICE_CONFIG_SHARED_SECRET is required');
    expect(() => loadIntegrationRuntimeConfig(environment({
      ENABLE_RELAY_DELIVERY: 'true'
    }))).toThrow('PUSH_SERVICE_URL is required');
    expect(() => loadIntegrationRuntimeConfig(environment({
      PUSH_SERVICE_URL: 'https://push.example.test'
    }))).toThrow('PUSH_SERVICE_CLIENT_ID is required');

    expect(loadIntegrationRuntimeConfig(environment({
      ICE_CONFIG_SERVICE_URL: 'https://ice.example.test/',
      ICE_CONFIG_SHARED_SECRET: secret,
      PUSH_SERVICE_URL: 'https://push.example.test/',
      PUSH_SERVICE_CLIENT_ID: 'server-1',
      PUSH_SERVICE_SHARED_SECRET: secret,
      ENABLE_RELAY_DELIVERY: 'true',
      MOBILE_CALL_ACTION_SECRET: 'm'.repeat(32)
    }))).toMatchObject({
      ice: {
        serviceUrl: 'https://ice.example.test',
        vpsId: 'test-vps',
        sharedSecretBase64: secret,
        subjectIdSecretBase64: secret
      },
      push: {
        relayDeliveryEnabled: true,
        serviceUrl: 'https://push.example.test',
        clientId: 'server-1',
        sharedSecretBase64: secret
      },
      mobileCalls: { actionSecret: 'm'.repeat(32) }
    });
  });

  it('loads ICE base64 secrets from Docker-style secret files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'circlus-runtime-secret-'));
    const secretPath = path.join(directory, 'ice-s2s.secret');
    const secret = Buffer.alloc(32, 11).toString('base64');
    fs.writeFileSync(secretPath, `${secret}\n`, 'utf8');

    expect(loadIntegrationRuntimeConfig(environment({
      ICE_CONFIG_SERVICE_URL: 'http://ice-config-service:3090',
      ICE_CONFIG_SHARED_SECRET_FILE: secretPath
    })).ice).toMatchObject({
      sharedSecretBase64: secret,
      subjectIdSecretBase64: secret
    });
    expect(() => loadIntegrationRuntimeConfig(environment({
      ICE_CONFIG_SHARED_SECRET: secret,
      ICE_CONFIG_SHARED_SECRET_FILE: secretPath
    }))).toThrow('ICE_CONFIG_SHARED_SECRET and ICE_CONFIG_SHARED_SECRET_FILE cannot both be configured');
  });

  it('rejects malformed or weak integration secrets', () => {
    expect(() => loadIntegrationRuntimeConfig(environment({
      ICE_CONFIG_SHARED_SECRET: 'not-base64'
    }))).toThrow('ICE_CONFIG_SHARED_SECRET must be valid base64');
    expect(() => loadIntegrationRuntimeConfig(environment({
      PUSH_SERVICE_SHARED_SECRET: Buffer.alloc(8).toString('base64')
    }))).toThrow('PUSH_SERVICE_SHARED_SECRET must encode at least 32 random bytes');
    expect(() => loadIntegrationRuntimeConfig(environment({
      MOBILE_CALL_ACTION_SECRET: 'short'
    }))).toThrow('MOBILE_CALL_ACTION_SECRET must contain at least 32 bytes');
  });

  it('resolves and validates storage settings', () => {
    expect(loadStorageRuntimeConfig(environment({
      ATTACHMENTS_STORAGE_DIR: './custom-attachments',
      ATTACHMENTS_MAX_HTTP_BODY: '100b',
      ATTACHMENTS_MAX_CONCURRENT_UPLOADS: '4'
    }))).toMatchObject({
      attachments: {
        rootDir: path.resolve(process.cwd(), 'custom-attachments'),
        tmpDir: path.resolve(process.cwd(), 'custom-attachments', '_tmp'),
        maxHttpBody: '100b',
        maxHttpBodyBytes: 100,
        maxConcurrentUploads: 4
      }
    });
    expect(() => loadStorageRuntimeConfig(environment({
      ATTACHMENTS_RESERVATION_TTL_MS: '1000'
    }))).toThrow('ATTACHMENTS_RESERVATION_TTL_MS must be between 60000');
  });

  it('bounds cleanup retention and scheduler settings', () => {
    expect(loadCleanupRuntimeConfig(environment({
      MESSAGE_TTL_HOURS: '48',
      CALL_HISTORY_HEARTBEAT_SWEEP_MS: '30000'
    }))).toMatchObject({
      messageTtlHours: 48,
      callHistoryHeartbeatSweepMs: 30_000
    });
    expect(() => loadCleanupRuntimeConfig(environment({
      CALL_HISTORY_HEARTBEAT_TIMEOUT_MS: '1000'
    }))).toThrow('CALL_HISTORY_HEARTBEAT_TIMEOUT_MS must be between 15000');
  });

  it('loads Circle migration paths, timeouts, and an exact 32-byte key', () => {
    const secret = Buffer.alloc(32, 11).toString('base64');
    expect(loadCircleMigrationRuntimeConfig(environment({
      CIRCLE_MIGRATION_SECRET_KEY_BASE64: secret,
      CIRCLE_MIGRATION_EXPORT_DIR: './exports',
      CIRCLE_MIGRATION_IMPORT_DIR: './imports',
      CIRCLE_MIGRATION_HTTP_TIMEOUT_MS: '15000'
    }))).toEqual({
      secretKeyBase64: secret,
      exportDir: path.resolve(process.cwd(), 'exports'),
      importDir: path.resolve(process.cwd(), 'imports'),
      httpTimeoutMs: 15_000,
      freezeDrainTimeoutMs: 60_000
    });
    expect(() => loadCircleMigrationRuntimeConfig(environment({
      CIRCLE_MIGRATION_SECRET_KEY_BASE64: Buffer.alloc(33).toString('base64')
    }))).toThrow('CIRCLE_MIGRATION_SECRET_KEY_BASE64 must encode exactly 32 random bytes');
  });

  it('loads and bounds route rate limits in one typed section', () => {
    expect(loadRateLimitRuntimeConfig(environment({
      RATE_LIMIT_AUTH_REGISTER_MAX: '15',
      RATE_LIMIT_GROUP_CHATS_MAX: '300',
      RATE_LIMIT_IDENTITIES_AVATAR_UPLOAD_MAX: '12'
    }))).toMatchObject({
      auth: { registerMax: 15 },
      groupChats: { max: 300 },
      identities: { avatarUploadMax: 12 }
    });
    expect(() => loadRateLimitRuntimeConfig(environment({
      RATE_LIMIT_MESSAGES_WINDOW_MS: '999'
    }))).toThrow('RATE_LIMIT_MESSAGES_WINDOW_MS must be between 1000');
  });

  it('loads feature policies and preserves the shared message-size fallback', () => {
    expect(loadFeaturePolicyRuntimeConfig(environment({
      MAX_MESSAGE_BYTES: '32768',
      DEVICE_ENROLLMENT_TTL_MS: '900000',
      PRESENCE_ONLINE_WINDOW_SECONDS: '90'
    }))).toMatchObject({
      presence: { onlineWindowSeconds: 90 },
      deviceEnrollments: { reservationTtlMs: 900_000 },
      messages: { maxCiphertextBytes: 32_768 },
      groupChats: { messageMaxBytes: 32_768 }
    });
    expect(() => loadFeaturePolicyRuntimeConfig(environment({
      TEMPORARY_RENEWAL_REQUEST_TTL_MS: 'invalid'
    }))).toThrow('TEMPORARY_RENEWAL_REQUEST_TTL_MS must be an integer');
  });

  it('normalizes public access policy and validates its URLs and switches', () => {
    expect(loadPublicAccessRuntimeConfig(environment({
      TRUSTED_CLIENT_ORIGINS: 'https://APP.example.com/path,invalid',
      CIRCLUS_PUBLIC_SITE_BLOCKED_DOMAIN_SUFFIXES: ' SPACE.example.com.,space.example.com ',
      SERVER_ADMIN_TENANT_DNS_CHECK: 'false',
      SERVER_ADMIN_TENANT_TLS_TIMEOUT_MS: '8000'
    }))).toEqual({
      appOpenUrl: 'https://web.circlus.org/open',
      publicSiteProductUrl: 'https://circlus.org',
      blockedPublicSiteDomainSuffixes: ['space.example.com'],
      trustedClientOrigins: ['https://web.circlus.org', 'https://app.example.com'],
      tenantValidation: { dnsCheck: false, tlsCheck: true, tlsTimeoutMs: 8_000 }
    });
    expect(() => loadPublicAccessRuntimeConfig(environment({
      CIRCLUS_APP_OPEN_URL: 'javascript:alert(1)'
    }))).toThrow('CIRCLUS_APP_OPEN_URL must be an absolute http(s) URL');
  });

  it('keeps direct environment access out of migrated runtime modules', () => {
    const migratedModules = [
      'src/index.ts',
      'src/middleware/auth.ts',
      'src/middleware/security.ts',
      'src/middleware/tenancy.ts',
      'src/ws/callHandler.ts',
      'src/services/iceServersService.ts',
      'src/utils/iceConfigServiceS2S.ts',
      'src/utils/push.ts',
      'src/utils/pushServiceS2S.ts',
      'src/utils/mobileCallActionToken.ts',
      'src/utils/mobileCallBootstrapToken.ts',
      'src/services/attachmentStorageService.ts',
      'src/services/publicSiteAssetStorageService.ts',
      'src/services/publicSiteGeneratorService.ts',
      'src/services/uploadStreamService.ts',
      'src/utils/attachmentHttpBodyLimit.ts',
      'src/routes/attachments.ts',
      'src/routes/circleSite.ts',
      'src/routes/auth.ts',
      'src/routes/callLinks.ts',
      'src/routes/circleMigration.ts',
      'src/routes/circleMigrationAdmin.ts',
      'src/routes/config.ts',
      'src/routes/deviceEnrollments.ts',
      'src/routes/groupChats.ts',
      'src/routes/groupChatsValidation.ts',
      'src/routes/hostProvisioning.ts',
      'src/routes/identities.ts',
      'src/routes/links.ts',
      'src/routes/messages.ts',
      'src/routes/push.ts',
      'src/routes/inspectorSupport.ts',
      'src/routes/server.ts',
      'src/routes/serverAdminMigrationSlots.ts',
      'src/routes/temporaryAccess.ts',
      'src/middleware/circleMigrationFreeze.ts',
      'src/services/circleMigrationActivationService.ts',
      'src/services/circleMigrationCrypto.ts',
      'src/services/circleMigrationCutoverService.ts',
      'src/services/circleMigrationExportService.ts',
      'src/services/circleMigrationHttpClient.ts',
      'src/services/circleMigrationImportService.ts',
      'src/services/circleMigrationPreflightService.ts',
      'src/services/circleMigrationScheduleService.ts',
      'src/services/circleMigrationSlotService.ts',
      'src/services/directMessages.ts',
      'src/utils/publicSiteDomainPolicy.ts',
      'src/utils/tenantDomainValidation.ts',
      'src/utils/trustedOrigins.ts',
      'src/utils/cleanup.ts',
      'src/db/repositories/callHistoryRepository.ts',
      'src/db/repositories/circleMigrationRepository.ts',
      'src/db/repositories/identityRepository.ts',
      'src/db/repositories/systemEventRepository.ts'
    ];
    for (const modulePath of migratedModules) {
      const source = fs.readFileSync(path.resolve(process.cwd(), modulePath), 'utf8');
      expect(source).not.toContain('process.env');
    }
  });
});
