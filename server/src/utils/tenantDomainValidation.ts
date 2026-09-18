import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { normalizeHost } from '../middleware/tenancy';
import {
  getPublicAccessRuntimeConfig,
  getServerIdentityRuntimeConfig
} from '../config/serverRuntimeConfig';

export type TenantDnsValidationResult =
  | { ok: true }
  | { ok: false; expectedIps: string[]; actualIps: string[]; reason: 'missing' | 'mismatch' };

export type TenantTlsValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

function isLocalhostHost(host: string): boolean {
  const normalized = normalizeHost(host).replace(/^\[(.*)\]$/, '$1');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

async function resolveHostIps(host: string): Promise<string[]> {
  const normalized = normalizeHost(host).replace(/^\[(.*)\]$/, '$1');
  if (!normalized) return [];
  if (net.isIP(normalized)) return [normalized];
  const records = await lookup(normalized, { all: true, verbatim: true });
  return Array.from(new Set(records.map((record) => record.address))).sort();
}

export async function validateTenantDomainDns(
  requestHost: string | null,
  tenantHost: string
): Promise<TenantDnsValidationResult> {
  if (!getPublicAccessRuntimeConfig().tenantValidation.dnsCheck) {
    return { ok: true };
  }
  if (getServerIdentityRuntimeConfig().nodeEnvironment === 'test' || !requestHost || isLocalhostHost(requestHost) || isLocalhostHost(tenantHost)) {
    return { ok: true };
  }

  let expectedIps: string[] = [];
  let actualIps: string[] = [];
  try {
    expectedIps = await resolveHostIps(requestHost);
  } catch {
    return { ok: true };
  }
  try {
    actualIps = await resolveHostIps(tenantHost);
  } catch {
    actualIps = [];
  }

  if (expectedIps.length === 0) {
    return { ok: true };
  }
  if (actualIps.length === 0) {
    return { ok: false, expectedIps, actualIps, reason: 'missing' };
  }

  const expected = new Set(expectedIps);
  if (actualIps.some((ip) => expected.has(ip))) {
    return { ok: true };
  }
  return { ok: false, expectedIps, actualIps, reason: 'mismatch' };
}

export function validateTenantTlsCertificate(url: URL): Promise<TenantTlsValidationResult> {
  const runtimeConfig = getPublicAccessRuntimeConfig().tenantValidation;
  if (!runtimeConfig.tlsCheck) {
    return Promise.resolve({ ok: true });
  }
  if (getServerIdentityRuntimeConfig().nodeEnvironment === 'test' || url.protocol !== 'https:' || isLocalhostHost(url.hostname)) {
    return Promise.resolve({ ok: true });
  }

  return new Promise((resolve) => {
    const socket = tls.connect({
      host: url.hostname,
      port: url.port ? Number(url.port) : 443,
      servername: url.hostname,
      rejectUnauthorized: true,
      timeout: runtimeConfig.tlsTimeoutMs
    });

    socket.once('secureConnect', () => {
      socket.end();
      resolve({ ok: true });
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    socket.once('error', (error) => {
      socket.destroy();
      resolve({ ok: false, reason: error.message || 'tls_error' });
    });
  });
}
