import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IntegrationRuntimeConfig } from '../config/integrationRuntimeConfig';
import { getIntegrationRuntimeConfig } from '../config/serverRuntimeConfig';
import { managedPushConfigurationRepository, type ManagedPushConfigurationRecord } from '../db/repositories/managedPushConfigurationRepository';
import { hashClaimToken } from '../utils/claimTokens';
import { signPushServiceRequest } from '../utils/pushServiceS2S';

type PushConfig = IntegrationRuntimeConfig['push'];
type EncryptedSecret = { v: 1; alg: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };
let managedConfig: PushConfig | undefined;

function encryptionKey(): Buffer {
  const inline = String(process.env.MANAGED_PUSH_CONFIG_ENCRYPTION_KEY || '').trim();
  const file = String(process.env.MANAGED_PUSH_CONFIG_ENCRYPTION_KEY_FILE || '').trim();
  const encoded = inline || (file ? fs.readFileSync(file, 'utf8').trim() : '');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('MANAGED_PUSH_CONFIG_ENCRYPTION_KEY(_FILE) must contain a base64-encoded 32-byte key');
  return key;
}

function encryptSecret(secretBase64: string): EncryptedSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secretBase64, 'utf8'), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function decryptSecret(value: unknown): string {
  const encrypted = value as Partial<EncryptedSecret> | null;
  if (!encrypted || encrypted.v !== 1 || encrypted.alg !== 'aes-256-gcm' || !encrypted.iv || !encrypted.tag || !encrypted.ciphertext) {
    throw new Error('Managed push secret has an unsupported encrypted format');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function fromRecord(record: ManagedPushConfigurationRecord): PushConfig {
  if (record.state === 'disabled') return { relayDeliveryEnabled: false, serviceUrl: null, clientId: null, keyId: 'k1', sharedSecretBase64: null };
  return { relayDeliveryEnabled: true, serviceUrl: record.service_url, clientId: record.client_id, keyId: record.key_id || 'k1', sharedSecretBase64: decryptSecret(record.encrypted_shared_secret) };
}

export async function initializeManagedPushConfiguration(): Promise<void> {
  const record = await managedPushConfigurationRepository.getConfiguration();
  managedConfig = record ? fromRecord(record) : undefined;
}

/** A DB row always wins. A disabled row deliberately prevents env fallback. */
export function getEffectivePushConfiguration(): PushConfig {
  return managedConfig === undefined ? getIntegrationRuntimeConfig().push : managedConfig;
}

function normalizeInstallInput(input: { serviceUrl: unknown; clientId: unknown; keyId: unknown; sharedSecret: unknown }) {
  const serviceUrl = String(input.serviceUrl || '').trim().replace(/\/+$/, '');
  const clientId = String(input.clientId || '').trim();
  const keyId = String(input.keyId || '').trim();
  const sharedSecret = String(input.sharedSecret || '').trim();
  let parsed: URL;
  try { parsed = new URL(serviceUrl); } catch { throw new Error('INVALID_SERVICE_URL'); }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))) throw new Error('INVALID_SERVICE_URL');
  if (!/^[A-Za-z0-9._:-]{3,160}$/.test(clientId)) throw new Error('INVALID_CLIENT_ID');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId)) throw new Error('INVALID_KEY_ID');
  const decoded = Buffer.from(sharedSecret, 'base64');
  if (decoded.length < 32 || decoded.toString('base64').replace(/=+$/, '') !== sharedSecret.replace(/=+$/, '')) throw new Error('INVALID_SHARED_SECRET');
  return { serviceUrl, clientId, keyId, sharedSecret };
}

function fingerprint(input: ReturnType<typeof normalizeInstallInput>): string {
  return crypto.createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

export async function preflightManagedPushInstallation(claimToken: string) {
  const claim = await managedPushConfigurationRepository.findClaimByTokenHash(hashClaimToken(claimToken));
  if (!claim) throw new Error('INSTALL_CLAIM_INVALID');
  if (claim.status !== 'pending') throw new Error(claim.status === 'consumed' ? 'INSTALL_CLAIM_ALREADY_USED' : 'INSTALL_CLAIM_INVALID');
  if (claim.expires_at.getTime() <= Date.now()) throw new Error('INSTALL_CLAIM_EXPIRED');
  return { claimId: claim.claim_id, serverUrl: claim.server_url, expiresAt: claim.expires_at.toISOString() };
}

export async function installManagedPushConfiguration(params: { claimToken: string; provisionRequestId: string; serviceUrl: unknown; clientId: unknown; keyId: unknown; sharedSecret: unknown }) {
  const normalized = normalizeInstallInput(params);
  const result = await managedPushConfigurationRepository.install({
    tokenHash: hashClaimToken(params.claimToken), provisionRequestId: params.provisionRequestId,
    fingerprint: fingerprint(normalized), serviceUrl: normalized.serviceUrl, clientId: normalized.clientId,
    keyId: normalized.keyId, encryptedSharedSecret: encryptSecret(normalized.sharedSecret)
  });
  managedConfig = fromRecord(result.configuration);
  return { repeated: result.repeated, configuration: getManagedPushConfigurationStatus() };
}

export async function disableManagedPushConfiguration(params: { claimToken: string; provisionRequestId: string; serviceUrl: unknown; clientId: unknown; keyId: unknown; sharedSecret: unknown }) {
  const normalized = normalizeInstallInput(params);
  const record = await managedPushConfigurationRepository.disable({
    tokenHash: hashClaimToken(params.claimToken),
    provisionRequestId: params.provisionRequestId,
    fingerprint: fingerprint(normalized)
  });
  managedConfig = fromRecord(record);
  return getManagedPushConfigurationStatus();
}

export function getManagedPushConfigurationStatus() {
  const config = getEffectivePushConfiguration();
  return { configured: !!(config.relayDeliveryEnabled && config.serviceUrl && config.clientId && config.sharedSecretBase64), source: managedConfig === undefined ? 'environment' as const : 'database' as const, serviceUrl: config.serviceUrl, clientId: config.clientId, keyId: config.keyId };
}

export async function verifyEffectivePushConfiguration(): Promise<{ ok: true }> {
  const config = getEffectivePushConfiguration();
  if (!config.serviceUrl || !config.clientId || !config.sharedSecretBase64) throw new Error('PUSH_NOT_CONFIGURED');
  const path = '/api/push/auth/check';
  const body = '{}';
  const response = await fetch(`${config.serviceUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signPushServiceRequest({ method: 'POST', path, body, config }) }, body, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`PUSH_AUTH_CHECK_FAILED:${response.status}`);
  return { ok: true };
}
