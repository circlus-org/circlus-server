import fs from 'fs';
import path from 'path';
import type {
  AuthorizedServerConfig,
  IceServiceConfig,
  PublicTurnClusterConfig,
  TurnClusterAuthConfig,
  TurnClusterConfig
} from './types';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonObject;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const result = value.map((entry, index) => requireString(entry, `${field}[${index}]`));
  if (result.length === 0) throw new Error(`${field} must not be empty`);
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates`);
  return result;
}

function parseStatus(value: unknown, field: string): 'active' | 'disabled' {
  const status = value === undefined ? 'active' : String(value);
  if (status !== 'active' && status !== 'disabled') {
    throw new Error(`${field} must be active or disabled`);
  }
  return status;
}

function parseOwnership(value: unknown, field: string): 'local' | 'external' {
  const ownership = value === undefined ? 'external' : String(value);
  if (ownership !== 'local' && ownership !== 'external') {
    throw new Error(`${field} must be local or external`);
  }
  return ownership;
}

function parseTtlSeconds(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new Error(`${field} must be an integer between 60 and 86400`);
  }
  return ttl;
}

function resolveSecretFile(configPath: string, value: unknown, field: string): string {
  const configuredPath = requireString(value, field);
  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(path.dirname(configPath), configuredPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    throw new Error(`${field} is not readable: ${resolvedPath}`);
  }
  if (!stat.isFile()) throw new Error(`${field} must reference a regular file`);
  const secret = fs.readFileSync(resolvedPath, 'utf8').trim();
  if (!secret) throw new Error(`${field} must reference a non-empty file`);
  return secret;
}

function resolveSecret(params: {
  source: JsonObject;
  inlineField: string;
  fileField: string;
  configPath: string;
  field: string;
}): string {
  if (params.source[params.fileField] !== undefined) {
    return resolveSecretFile(
      params.configPath,
      params.source[params.fileField],
      `${params.field}.${params.fileField}`
    );
  }
  return requireString(params.source[params.inlineField], `${params.field}.${params.inlineField}`);
}

function validateClusterId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`${field} contains unsupported characters`);
  }
  return id;
}

function validateTurnUrls(value: unknown, field: string): string[] {
  const urls = requireStringArray(value, field);
  for (const url of urls) {
    if (!/^turns?:[^\s]+$/i.test(url)) {
      throw new Error(`${field} entries must use turn: or turns:`);
    }
  }
  return urls;
}

function validateStunUrls(value: unknown): string[] {
  if (value === undefined) return [];
  const urls = requireStringArray(value, 'stunUrls');
  for (const url of urls) {
    if (!/^stuns?:[^\s]+$/i.test(url)) {
      throw new Error('stunUrls entries must use stun: or stuns:');
    }
  }
  return urls;
}

function parseClusterAuth(rawCluster: JsonObject, configPath: string, field: string): TurnClusterAuthConfig {
  const auth = asObject(rawCluster.auth, `${field}.auth`);
  const mode = requireString(auth.mode, `${field}.auth.mode`);
  if (mode === 'turn-rest-secret') {
    return {
      mode,
      secret: resolveSecret({
        source: auth,
        inlineField: 'secret',
        fileField: 'secretFile',
        configPath,
        field: `${field}.auth`
      }),
      ttlSeconds: parseTtlSeconds(auth.ttlSeconds, `${field}.auth.ttlSeconds`)
    };
  }
  if (mode === 'static-credentials') {
    return {
      mode,
      username: requireString(auth.username, `${field}.auth.username`),
      credential: resolveSecret({
        source: auth,
        inlineField: 'credential',
        fileField: 'credentialFile',
        configPath,
        field: `${field}.auth`
      })
    };
  }
  throw new Error(`${field}.auth.mode is unsupported`);
}

function validateConfig(raw: unknown, configPath: string): IceServiceConfig {
  const value = asObject(raw, 'ICE config');
  const schemaVersion = Number(value.schemaVersion);
  if (schemaVersion !== 1) {
    throw new Error('schemaVersion must be 1');
  }

  const turnClusters = Array.isArray(value.turnClusters) ? value.turnClusters.map((entry, index): TurnClusterConfig => {
    const cluster = asObject(entry, `turnClusters[${index}]`);
    const id = validateClusterId(cluster.id, `turnClusters[${index}].id`);
    return {
      id,
      displayName: optionalString(cluster.displayName, `turnClusters[${index}].displayName`) || id,
      status: parseStatus(cluster.status, `turnClusters[${index}].status`),
      ownership: parseOwnership(cluster.ownership, `turnClusters[${index}].ownership`),
      location: optionalString(cluster.location, `turnClusters[${index}].location`),
      urls: validateTurnUrls(cluster.urls, `turnClusters[${index}].urls`),
      auth: parseClusterAuth(cluster, configPath, `turnClusters[${index}]`)
    };
  }) : [];
  if (turnClusters.length === 0) throw new Error('turnClusters must not be empty');
  if (new Set(turnClusters.map((cluster) => cluster.id)).size !== turnClusters.length) {
    throw new Error('turnClusters ids must be unique');
  }
  const clusterIds = new Set(turnClusters.map((cluster) => cluster.id));

  const authorizedServers = Array.isArray(value.authorizedServers) ? value.authorizedServers.map((entry, index): AuthorizedServerConfig => {
    const server = asObject(entry, `authorizedServers[${index}]`);
    const serverId = requireString(server.serverId, `authorizedServers[${index}].serverId`);
    const keyId = requireString(server.keyId, `authorizedServers[${index}].keyId`);
    const defaultTurnClusterId = validateClusterId(
      server.defaultTurnClusterId,
      `authorizedServers[${index}].defaultTurnClusterId`
    );
    const allowedTurnClusterIds = server.allowedTurnClusterIds === undefined
      ? [defaultTurnClusterId]
      : requireStringArray(server.allowedTurnClusterIds, `authorizedServers[${index}].allowedTurnClusterIds`)
          .map((id, allowedIndex) => validateClusterId(id, `authorizedServers[${index}].allowedTurnClusterIds[${allowedIndex}]`));
    if (!allowedTurnClusterIds.includes(defaultTurnClusterId)) {
      throw new Error(`authorizedServers[${index}].allowedTurnClusterIds must include defaultTurnClusterId`);
    }
    for (const clusterId of allowedTurnClusterIds) {
      if (!clusterIds.has(clusterId)) {
        throw new Error(`authorizedServers[${index}] references unknown TURN cluster: ${clusterId}`);
      }
    }
    const sharedSecret = resolveSecret({
      source: server,
      inlineField: 's2sSharedSecret',
      fileField: 's2sSharedSecretFile',
      configPath,
      field: `authorizedServers[${index}]`
    });
    if (Buffer.from(sharedSecret, 'base64').length < 16) {
      throw new Error(`authorizedServers[${index}] S2S secret must encode at least 16 bytes`);
    }
    return {
      serverId,
      keyId,
      status: parseStatus(server.status, `authorizedServers[${index}].status`),
      s2sSharedSecret: sharedSecret,
      defaultTurnClusterId,
      allowedTurnClusterIds
    };
  }) : [];
  if (authorizedServers.length === 0) throw new Error('authorizedServers must not be empty');
  const serverKeys = authorizedServers.map((server) => `${server.serverId}\n${server.keyId}`);
  if (new Set(serverKeys).size !== serverKeys.length) {
    throw new Error('authorizedServers serverId/keyId pairs must be unique');
  }

  return {
    schemaVersion,
    defaultTtlSeconds: parseTtlSeconds(value.defaultTtlSeconds, 'defaultTtlSeconds') || 3600,
    stunUrls: validateStunUrls(value.stunUrls),
    turnClusters,
    authorizedServers
  };
}

function safeConfigForLog(config: IceServiceConfig): unknown {
  return {
    schemaVersion: config.schemaVersion,
    defaultTtlSeconds: config.defaultTtlSeconds,
    stunUrls: config.stunUrls,
    turnClusters: config.turnClusters.map((cluster) => ({
      id: cluster.id,
      displayName: cluster.displayName,
      status: cluster.status,
      ownership: cluster.ownership,
      location: cluster.location,
      urls: cluster.urls,
      auth: {
        mode: cluster.auth.mode,
        secretConfigured: true,
        ...(cluster.auth.mode === 'turn-rest-secret' && cluster.auth.ttlSeconds
          ? { ttlSeconds: cluster.auth.ttlSeconds }
          : {})
      }
    })),
    authorizedServers: config.authorizedServers.map((server) => ({
      serverId: server.serverId,
      keyId: server.keyId,
      status: server.status,
      defaultTurnClusterId: server.defaultTurnClusterId,
      allowedTurnClusterIds: server.allowedTurnClusterIds,
      s2sSecretConfigured: true
    }))
  };
}

export class ConfigRepository {
  private config: IceServiceConfig;
  private readonly configPath: string;
  private rawConfig: JsonObject;

  private constructor(config: IceServiceConfig, rawConfig: JsonObject, configPath: string) {
    this.config = config;
    this.rawConfig = rawConfig;
    this.configPath = configPath;
  }

  static load(configPath: string): ConfigRepository {
    const resolved = path.resolve(configPath);
    const fileContent = fs.readFileSync(resolved, 'utf8');
    const raw = asObject(JSON.parse(fileContent) as unknown, 'ICE config');
    const config = validateConfig(raw, resolved);
    console.log(`[ICE][config] loading from: ${resolved}`);
    console.log(`[ICE][config] loaded config: ${JSON.stringify(safeConfigForLog(config))}`);
    return new ConfigRepository(config, raw, resolved);
  }

  getStunUrls(): string[] {
    return this.config.stunUrls || [];
  }

  getDefaultTtlSeconds(): number {
    return Math.max(60, Math.min(86400, Number(this.config.defaultTtlSeconds || 3600)));
  }

  getCredentialTtlSeconds(cluster: TurnClusterConfig): number | undefined {
    if (cluster.auth.mode !== 'turn-rest-secret') return undefined;
    return cluster.auth.ttlSeconds || this.getDefaultTtlSeconds();
  }

  getAuthorizedServer(serverId: string, keyId: string): AuthorizedServerConfig | null {
    return this.config.authorizedServers.find((server) => server.serverId === serverId && server.keyId === keyId) || null;
  }

  getTurnCluster(clusterId: string): TurnClusterConfig | null {
    return this.config.turnClusters.find((cluster) => cluster.id === clusterId) || null;
  }

  listAllowedTurnClusters(server: AuthorizedServerConfig): PublicTurnClusterConfig[] {
    const allowed = new Set(server.allowedTurnClusterIds);
    return this.config.turnClusters
      .filter((cluster) => allowed.has(cluster.id))
      .map((cluster) => ({
        id: cluster.id,
        displayName: cluster.displayName,
        status: cluster.status || 'active',
        ownership: cluster.ownership,
        ...(cluster.location ? { location: cluster.location } : {}),
        urls: cluster.urls.slice(),
        authMode: cluster.auth.mode
      }));
  }

  listAuthorizedServers(): AuthorizedServerConfig[] {
    return this.config.authorizedServers.slice();
  }

  addOrUpdateAuthorizedServer(server: AuthorizedServerConfig): void {
    const rawServers = Array.isArray(this.rawConfig.authorizedServers)
      ? this.rawConfig.authorizedServers.slice()
      : [];
    const replacement = {
      serverId: server.serverId,
      keyId: server.keyId,
      status: server.status || 'active',
      s2sSharedSecret: server.s2sSharedSecret,
      defaultTurnClusterId: server.defaultTurnClusterId,
      allowedTurnClusterIds: server.allowedTurnClusterIds
    };
    const idx = rawServers.findIndex((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const raw = entry as JsonObject;
      return raw.serverId === server.serverId && raw.keyId === server.keyId;
    });
    if (idx >= 0) rawServers[idx] = replacement;
    else rawServers.push(replacement);

    const nextRaw: JsonObject = { ...this.rawConfig, authorizedServers: rawServers };
    const nextConfig = validateConfig(nextRaw, this.configPath);
    fs.writeFileSync(this.configPath, JSON.stringify(nextRaw, null, 2), 'utf8');
    this.rawConfig = nextRaw;
    this.config = nextConfig;
  }
}
