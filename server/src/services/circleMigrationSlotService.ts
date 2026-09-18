import { validate as isUuid } from 'uuid';
import type { PublicKey } from '../../../shared/types';
import { createOpaqueClaimToken, hashClaimToken } from '../utils/claimTokens';
import { circleMigrationRepository, type MigrationSlotRecord } from '../db/repositories/circleMigrationRepository';
import { verifySignature } from '../utils/crypto';
import { normalizePublicServerUrl } from '../utils/serverIdentity';
import {
  canonicalizeCircleMigrationJson,
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
  isSupportedCircleMigrationContract,
  sha256Fingerprint
} from './circleMigrationContract';
import {
  createMigrationSession,
  encryptMigrationSecret,
  timingSafeHashEquals,
  validateMigrationPublicKey,
  type MigrationSessionEnvelope
} from './circleMigrationCrypto';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

export class CircleMigrationServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface OwnerSignedMigrationIntent {
  payload: {
    migrationSlotId: string;
    migrationId: string;
    familyId: string;
    ownerIdentityId: string;
    sourceServerId: string;
    destinationServerId: string;
    sourceCircleId: string;
    destinationCircleId: string;
    oldPublicBaseUrl: string;
    targetPublicBaseUrl: string;
    migrationFormatVersion: number;
    sourceSchemaFingerprint: string;
    destinationSchemaFingerprint: string;
    dataScopeFingerprint: string;
    preflightSummaryFingerprint: string;
    dataLossPolicy: {
      dropAttachments: true;
      dropMessageArchive: true;
      dropCallHistory: true;
      dropCallLinks: true;
      dropInvites: true;
      dropSystemEvents: true;
    };
    expiresAt: string;
  };
  signature: string;
}

const BOUND_SLOT_SESSION_GRACE_MS = 48 * 60 * 60 * 1000;

function slotSessionHardExpiry(slot: MigrationSlotRecord): number {
  if (slot.status === 'pending' || slot.status === 'verified' || slot.status === 'revoked' || slot.status === 'expired') {
    return slot.expires_at.getTime();
  }
  return slot.expires_at.getTime() + BOUND_SLOT_SESSION_GRACE_MS;
}

function requireNormalizedHttpsUrl(raw: unknown, label: string): string {
  const normalized = normalizePublicServerUrl(typeof raw === 'string' ? raw : undefined);
  if (!normalized) {
    throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', `${label} must be a valid URL`);
  }
  const url = new URL(normalized);
  const localDevelopment = getServerIdentityRuntimeConfig().nodeEnvironment !== 'production'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  if (url.protocol !== 'https:' && !localDevelopment) {
    throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', `${label} must use HTTPS`);
  }
  return normalized;
}

function validateFixedDataLossPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Record<string, unknown>;
  return (
    policy.dropAttachments === true
    && policy.dropMessageArchive === true
    && policy.dropCallHistory === true
    && policy.dropCallLinks === true
    && policy.dropInvites === true
    && policy.dropSystemEvents === true
  );
}

function requireMigrationPublicKey(
  value: unknown,
  algorithm: 'ed25519' | 'x25519',
  label: string
): { algorithm: 'ed25519' | 'x25519'; value: string } {
  try {
    return validateMigrationPublicKey(value, algorithm, label);
  } catch (error) {
    throw new CircleMigrationServiceError(
      400,
      'INVALID_REQUEST',
      error instanceof Error ? error.message : `${label} is invalid`
    );
  }
}

function validateOwnerIntent(slot: MigrationSlotRecord, intent: OwnerSignedMigrationIntent): void {
  const payload = intent?.payload;
  if (!payload || typeof intent.signature !== 'string' || !intent.signature) {
    throw new CircleMigrationServiceError(400, 'MIGRATION_OWNER_PROOF_INVALID', 'Owner-signed migration intent is required');
  }
  const destinationServerId = getServerIdentityRuntimeConfig().vpsId;
  const expiresAt = Date.parse(payload.expiresAt);
  const matches = (
    payload.migrationSlotId === slot.migration_slot_id
    && payload.migrationId === slot.source_migration_id
    && payload.familyId === slot.expected_family_id
    && payload.ownerIdentityId === slot.expected_owner_identity_id
    && payload.sourceServerId === slot.source_server_id
    && payload.destinationServerId === destinationServerId
    && payload.sourceCircleId === slot.source_circle_id
    && payload.destinationCircleId === slot.destination_circle_id
    && normalizePublicServerUrl(payload.oldPublicBaseUrl) === slot.source_server_url
    && normalizePublicServerUrl(payload.targetPublicBaseUrl) === slot.target_public_base_url
    && payload.migrationFormatVersion === CIRCLE_MIGRATION_FORMAT_VERSION
    && payload.sourceSchemaFingerprint === slot.source_schema_fingerprint
    && payload.destinationSchemaFingerprint === CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
    && payload.dataScopeFingerprint === CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT
    && typeof payload.preflightSummaryFingerprint === 'string'
    && payload.preflightSummaryFingerprint.startsWith('sha256:')
    && validateFixedDataLossPolicy(payload.dataLossPolicy)
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now()
    && expiresAt <= slot.expires_at.getTime()
  );
  if (!matches) {
    throw new CircleMigrationServiceError(400, 'MIGRATION_OWNER_PROOF_INVALID', 'Migration intent does not match the reserved slot');
  }

  const publicKey = slot.owner_identity_public_key as PublicKey | null;
  if (!publicKey || !verifySignature(canonicalizeCircleMigrationJson(payload), intent.signature, publicKey)) {
    throw new CircleMigrationServiceError(401, 'MIGRATION_OWNER_PROOF_INVALID', 'Migration intent signature is invalid');
  }
}

class CircleMigrationSlotService {
  async verifySlot(input: {
    migrationSlotId: string;
    migrationId: string;
    migrationCode: string;
    sourceServerUrl: string;
    sourceServerId: string;
    sourceCircleId: string;
    familyId: string;
    ownerIdentityId: string;
    ownerIdentityPublicKey: unknown;
    sourceSessionPublicKey: unknown;
    migrationFormatVersion: unknown;
    sourceSchemaFingerprint: unknown;
    dataScopeFingerprint?: unknown;
  }): Promise<{
    slot: MigrationSlotRecord;
    sessionKeyEnvelope: MigrationSessionEnvelope;
  }> {
    const slot = await circleMigrationRepository.findSlotById(input.migrationSlotId);
    if (!slot) {
      throw new CircleMigrationServiceError(404, 'MIGRATION_SLOT_NOT_FOUND', 'Migration slot not found');
    }
    if (slot.expires_at.getTime() <= Date.now()) {
      await circleMigrationRepository.markSlotExpired(slot.migration_slot_id);
      throw new CircleMigrationServiceError(410, 'MIGRATION_SLOT_EXPIRED', 'Migration slot expired');
    }
    if (slot.status === 'revoked') {
      throw new CircleMigrationServiceError(410, 'MIGRATION_SLOT_REVOKED', 'Migration slot was revoked');
    }
    if (!timingSafeHashEquals(slot.migration_code_hash, input.migrationCode)) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_CODE_INVALID', 'Migration code is invalid');
    }
    if (
      !input.migrationId.trim()
      || !isUuid(input.familyId)
      || !input.ownerIdentityId.trim()
      || !input.sourceServerId.trim()
      || !input.sourceCircleId.trim()
    ) {
      throw new CircleMigrationServiceError(
        400,
        'INVALID_REQUEST',
        'migrationId, familyId, ownerIdentityId, and sourceServerId are required'
      );
    }
    if (!isSupportedCircleMigrationContract({
      migrationFormatVersion: input.migrationFormatVersion,
      schemaFingerprint: input.sourceSchemaFingerprint,
      dataScopeFingerprint: input.dataScopeFingerprint
    })) {
      throw new CircleMigrationServiceError(
        409,
        'MIGRATION_SCHEMA_FINGERPRINT_MISMATCH',
        'Source and destination migration schemas are incompatible'
      );
    }

    const sourceServerUrl = requireNormalizedHttpsUrl(input.sourceServerUrl, 'sourceServerUrl');
    const ownerIdentityPublicKey = requireMigrationPublicKey(
      input.ownerIdentityPublicKey,
      'ed25519',
      'ownerIdentityPublicKey'
    );
    const sourceSessionPublicKey = requireMigrationPublicKey(
      input.sourceSessionPublicKey,
      'x25519',
      'sourceSessionPublicKey'
    );

    if (slot.status === 'verified' && slot.migration_code_consumed_at) {
      const sameBinding = (
        slot.expected_family_id === input.familyId
        && slot.expected_owner_identity_id === input.ownerIdentityId
        && slot.source_migration_id === input.migrationId
        && slot.source_server_id === input.sourceServerId
        && slot.source_server_url === sourceServerUrl
        && slot.source_circle_id === input.sourceCircleId
        && slot.owner_identity_public_key?.algorithm === ownerIdentityPublicKey.algorithm
        && slot.owner_identity_public_key?.value === ownerIdentityPublicKey.value
        && slot.source_session_public_key?.algorithm === sourceSessionPublicKey.algorithm
        && slot.source_session_public_key?.value === sourceSessionPublicKey.value
        && slot.source_schema_fingerprint === input.sourceSchemaFingerprint
        && typeof slot.session_key_envelope === 'string'
      );
      if (!sameBinding) {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_SOURCE_FORBIDDEN',
          'Migration slot is already bound to a different source request'
        );
      }
      const storedEnvelope = slot.session_key_envelope;
      if (typeof storedEnvelope !== 'string') {
        throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration session envelope is missing');
      }
      return {
        slot,
        sessionKeyEnvelope: JSON.parse(storedEnvelope) as MigrationSessionEnvelope
      };
    }
    if (slot.status !== 'pending' || slot.migration_code_consumed_at) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration slot is ${slot.status}`);
    }

    const session = createMigrationSession(sourceSessionPublicKey.value);
    const sessionExpiresAt = new Date(Math.min(
      slot.expires_at.getTime(),
      Date.now() + 30 * 60 * 1000
    ));
    const updated = await circleMigrationRepository.updateSlotVerification({
      migrationSlotId: slot.migration_slot_id,
      expectedStatus: 'pending',
      expectedFamilyId: input.familyId,
      expectedOwnerIdentityId: input.ownerIdentityId,
      sourceMigrationId: input.migrationId,
      sourceServerId: input.sourceServerId,
      sourceServerUrl,
      sourceCircleId: input.sourceCircleId,
      sourceSessionPublicKey,
      ownerIdentityPublicKey,
      sourceSchemaFingerprint: String(input.sourceSchemaFingerprint),
      sessionTokenHash: session.tokenHash,
      sessionKeyHash: session.sessionKeyHash,
      sessionKeyEncrypted: encryptMigrationSecret({ sessionKey: session.sessionKey }),
      sessionKeyEnvelope: JSON.stringify(session.envelope),
      sessionExpiresAt
    });
    if (!updated) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration slot was changed concurrently or is bound to another Circle');
    }

    return {
      slot: updated,
      sessionKeyEnvelope: session.envelope
    };
  }

  async authenticateSession(migrationSlotId: string, sessionToken: string): Promise<MigrationSlotRecord> {
    const slot = await circleMigrationRepository.findSlotById(migrationSlotId);
    if (!slot) {
      throw new CircleMigrationServiceError(404, 'MIGRATION_SLOT_NOT_FOUND', 'Migration slot not found');
    }
    if (
      !slot.session_expires_at
      || slot.session_expires_at.getTime() <= Date.now()
      || !timingSafeHashEquals(slot.session_token_hash, sessionToken)
    ) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session is invalid or expired');
    }
    return slot;
  }

  async reserveSlot(input: {
    migrationSlotId: string;
    sessionToken: string;
    familyId: string;
    preflightSummary: Record<string, unknown>;
    ownerSignedMigrationIntent: OwnerSignedMigrationIntent;
  }): Promise<MigrationSlotRecord> {
    const slot = await this.authenticateSession(input.migrationSlotId, input.sessionToken);
    if (
      slot.status === 'reserved'
      && slot.expected_family_id === input.familyId
      && slot.owner_signed_migration_intent
      && canonicalizeCircleMigrationJson(slot.owner_signed_migration_intent)
        === canonicalizeCircleMigrationJson(input.ownerSignedMigrationIntent)
    ) {
      return slot;
    }
    if (slot.status !== 'verified') {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration slot is ${slot.status}`);
    }
    if (slot.expected_family_id !== input.familyId) {
      throw new CircleMigrationServiceError(409, 'MIGRATION_SOURCE_FORBIDDEN', 'Migration slot is bound to another Circle');
    }
    const previewFingerprint = sha256Fingerprint(
      canonicalizeCircleMigrationJson(input.preflightSummary)
    );
    if (input.ownerSignedMigrationIntent?.payload?.preflightSummaryFingerprint !== previewFingerprint) {
      throw new CircleMigrationServiceError(
        400,
        'MIGRATION_OWNER_PROOF_INVALID',
        'Owner-signed intent does not match the preflight summary'
      );
    }
    validateOwnerIntent(slot, input.ownerSignedMigrationIntent);
    const reserved = await circleMigrationRepository.reserveSlot({
      migrationSlotId: slot.migration_slot_id,
      familyId: input.familyId,
      ownerSignedMigrationIntent: input.ownerSignedMigrationIntent as unknown as Record<string, unknown>
    });
    if (!reserved) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration slot could not be reserved');
    }
    return reserved;
  }

  async refreshSession(input: {
    migrationSlotId: string;
    sessionKey: string;
  }): Promise<{ slot: MigrationSlotRecord; sessionToken: string }> {
    const slot = await circleMigrationRepository.findSlotById(input.migrationSlotId);
    if (!slot) {
      throw new CircleMigrationServiceError(404, 'MIGRATION_SLOT_NOT_FOUND', 'Migration slot not found');
    }
    if (
      slotSessionHardExpiry(slot) <= Date.now()
      || ['revoked', 'expired'].includes(slot.status)
      || !timingSafeHashEquals(slot.session_key_hash, input.sessionKey)
    ) {
      throw new CircleMigrationServiceError(401, 'MIGRATION_SESSION_EXPIRED', 'Migration session cannot be refreshed');
    }
    const sessionToken = createOpaqueClaimToken('msess');
    const sessionExpiresAt = new Date(Math.min(
      slotSessionHardExpiry(slot),
      Date.now() + 30 * 60 * 1000
    ));
    const updated = await circleMigrationRepository.refreshSlotSession({
      migrationSlotId: slot.migration_slot_id,
      sessionTokenHash: hashClaimToken(sessionToken),
      sessionExpiresAt
    });
    if (!updated) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration session could not be refreshed');
    }
    return { slot: updated, sessionToken };
  }
}

export const circleMigrationSlotService = new CircleMigrationSlotService();
export { requireNormalizedHttpsUrl };
