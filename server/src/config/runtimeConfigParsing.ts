import fs from 'node:fs';
import path from 'node:path';

export type NodeEnvironment = 'development' | 'test' | 'production';
export type TrustProxySetting = false | number | string;

export class ServerConfigurationError extends Error {
  constructor(readonly key: string, message: string) {
    super(`Invalid server configuration: ${key} ${message}`);
    this.name = 'ServerConfigurationError';
  }
}

export function optionalString(environment: NodeJS.ProcessEnv, key: string): string | null {
  const value = environment[key]?.trim();
  return value ? value : null;
}

export function requiredString(environment: NodeJS.ProcessEnv, key: string): string {
  const value = optionalString(environment, key);
  if (!value) throw new ServerConfigurationError(key, 'is required');
  return value;
}

export function integerSetting(params: {
  environment: NodeJS.ProcessEnv;
  key: string;
  defaultValue: number;
  min: number;
  max: number;
}): number {
  const raw = optionalString(params.environment, params.key);
  if (raw === null) return params.defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new ServerConfigurationError(params.key, 'must be an integer');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < params.min || parsed > params.max) {
    throw new ServerConfigurationError(
      params.key,
      `must be between ${params.min} and ${params.max}`
    );
  }
  return parsed;
}

export function rateLimitWindow(
  environment: NodeJS.ProcessEnv,
  key: string,
  defaultValue = 60_000
): number {
  return integerSetting({
    environment,
    key,
    defaultValue,
    min: 1_000,
    max: 24 * 60 * 60 * 1000
  });
}

export function rateLimitMax(
  environment: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number
): number {
  return integerSetting({
    environment,
    key,
    defaultValue,
    min: 1,
    max: 1_000_000
  });
}

export function booleanSetting(params: {
  environment: NodeJS.ProcessEnv;
  key: string;
  defaultValue: boolean;
}): boolean {
  const raw = optionalString(params.environment, params.key);
  if (raw === null) return params.defaultValue;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ServerConfigurationError(params.key, 'must be a boolean');
}

export function byteSizeInBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(value);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multiplier = unit === 'gb'
    ? 1024 ** 3
    : unit === 'mb'
      ? 1024 ** 2
      : unit === 'kb'
        ? 1024
        : 1;
  return Math.floor(amount * multiplier);
}

export function bodyLimitSetting(
  environment: NodeJS.ProcessEnv,
  key: string,
  defaultValue: string
): string {
  const value = optionalString(environment, key) || defaultValue;
  if (!/^\d+(?:\.\d+)?(?:b|kb|mb|gb)?$/i.test(value) || byteSizeInBytes(value) <= 0) {
    throw new ServerConfigurationError(
      key,
      'must be a byte size such as 512kb, 2mb, or 1048576'
    );
  }
  return value;
}

export function optionalHttpUrl(environment: NodeJS.ProcessEnv, key: string): string | null {
  const value = optionalString(environment, key);
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServerConfigurationError(key, 'must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServerConfigurationError(key, 'must be an absolute http(s) URL');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function httpUrlSetting(
  environment: NodeJS.ProcessEnv,
  key: string,
  defaultValue: string
): string {
  const value = optionalString(environment, key) || defaultValue;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServerConfigurationError(key, 'must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServerConfigurationError(key, 'must be an absolute http(s) URL');
  }
  return value;
}

export function optionalBase64Secret(
  environment: NodeJS.ProcessEnv,
  key: string
): string | null {
  const inlineValue = optionalString(environment, key);
  const filePath = optionalString(environment, `${key}_FILE`);
  if (inlineValue && filePath) {
    throw new ServerConfigurationError(key, `and ${key}_FILE cannot both be configured`);
  }
  let fileValue: string | null = null;
  if (filePath) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
      fileValue = fs.readFileSync(filePath, 'utf8').trim() || null;
    } catch {
      throw new ServerConfigurationError(`${key}_FILE`, 'must reference a readable file');
    }
    if (!stat.isFile() || !fileValue) {
      throw new ServerConfigurationError(`${key}_FILE`, 'must reference a non-empty regular file');
    }
  }
  const value = inlineValue || fileValue;
  if (!value) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new ServerConfigurationError(key, 'must be valid base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < 32 || decoded.toString('base64') !== value) {
    throw new ServerConfigurationError(key, 'must encode at least 32 random bytes');
  }
  return value;
}

export function optionalFixedBase64Secret(
  environment: NodeJS.ProcessEnv,
  key: string,
  bytes: number
): string | null {
  const value = optionalString(environment, key);
  if (!value) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new ServerConfigurationError(key, 'must be valid base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) {
    throw new ServerConfigurationError(key, `must encode exactly ${bytes} random bytes`);
  }
  return value;
}

export function resolvedPath(
  environment: NodeJS.ProcessEnv,
  key: string,
  defaultValue: string
): string {
  return path.resolve(optionalString(environment, key) || defaultValue);
}

export function parseTrustProxySetting(rawValue: string | undefined): TrustProxySetting {
  const trimmed = rawValue?.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (normalized === 'true') return 1;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return trimmed;
}

export function nodeEnvironment(environment: NodeJS.ProcessEnv): NodeEnvironment {
  const value = optionalString(environment, 'NODE_ENV') || 'development';
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new ServerConfigurationError(
    'NODE_ENV',
    'must be one of development, test, or production'
  );
}

export function databaseUrl(environment: NodeJS.ProcessEnv, mode: NodeEnvironment): string {
  const value = optionalString(environment, 'DATABASE_URL');
  if (!value) {
    if (mode === 'production') {
      throw new ServerConfigurationError('DATABASE_URL', 'is required in production');
    }
    return 'postgresql://localhost:5432/family_messenger';
  }
  if (!/^postgres(?:ql)?:\/\//i.test(value)) {
    throw new ServerConfigurationError(
      'DATABASE_URL',
      'must use a postgres:// or postgresql:// URL'
    );
  }
  return value;
}

export function webSocketPath(environment: NodeJS.ProcessEnv): string {
  const value = optionalString(environment, 'WS_PATH') || '/ws';
  if (!value.startsWith('/') || value.includes('?') || value.includes('#')) {
    throw new ServerConfigurationError(
      'WS_PATH',
      'must be an absolute URL path without query or fragment'
    );
  }
  return value;
}
