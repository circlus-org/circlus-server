import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { validate as isUuid } from 'uuid';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import { verifySignature, requireActiveIdentity, requireServerAdmin, getSignedPayload, type AuthRequest } from '../middleware/auth';
import { getRequestHost, normalizeHost } from '../middleware/tenancy';
import {
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FIXED_SCOPES,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
  canonicalizeCircleMigrationJson,
  sha256Fingerprint
} from '../services/circleMigrationContract';
import { CircleMigrationServiceError, requireNormalizedHttpsUrl } from '../services/circleMigrationSlotService';
import { createOpaqueClaimToken, hashClaimToken } from '../utils/claimTokens';
import { validateTenantDomainDns, validateTenantTlsCertificate } from '../utils/tenantDomainValidation';
import { decryptMigrationSecret, encryptMigrationSecret } from '../services/circleMigrationCrypto';
import { getCircleAddressRuntimeConfig, getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

const router: Router = Router();

function normalizeOptionalLimit(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', `${label} must be a positive integer or null`);
  }
  return Math.floor(parsed);
}

function serializeSlot(slot: Awaited<ReturnType<typeof circleMigrationRepository.findSlotById>>) {
  if (!slot) return null;
  return {
    migrationSlotId: slot.migration_slot_id,
    destinationCircleId: slot.destination_circle_id,
    targetPublicBaseUrl: slot.target_public_base_url,
    destinationServiceEndpoint: slot.service_endpoint,
    serverName: slot.server_name,
    status: slot.status,
    expiresAt: slot.expires_at,
    limits: slot.limits,
    policies: slot.settings,
    migrationFormatVersion: slot.migration_format_version,
    schemaFingerprint: slot.destination_schema_fingerprint,
    dataScopeFingerprint: slot.data_scope_fingerprint,
    expectedFamilyId: slot.expected_family_id,
    expectedOwnerIdentityId: slot.expected_owner_identity_id,
    importedFamilyId: slot.imported_family_id,
    failureCode: slot.failure_code,
    failureMessage: slot.failure_message,
    importReport: slot.import_report,
    activationReport: slot.activation_report,
    createdAt: slot.created_at,
    updatedAt: slot.updated_at
  };
}

router.post(
  '/create',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest, res) => {
    try {
      const payload = getSignedPayload<Record<string, unknown>>(req);
      const destinationServiceEndpoint = requireNormalizedHttpsUrl(
        payload.destinationServiceEndpoint,
        'destinationServiceEndpoint'
      );
      const addressMode = String(payload.addressMode || '').trim();
      if (!['shared', 'managed', 'custom'].includes(addressMode)) {
        throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'addressMode must be shared, managed, or custom');
      }
      const serverName = String(payload.serverName || '').trim();
      const idempotencyKey = String(payload.idempotencyKey || '').trim();
      if (!serverName) {
        throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'serverName is required');
      }
      if (!idempotencyKey || idempotencyKey.length > 128) {
        throw new CircleMigrationServiceError(
          400,
          'INVALID_REQUEST',
          'idempotencyKey is required and must not exceed 128 characters'
        );
      }
      if (
        payload.migrationFormatVersion !== undefined
        && payload.migrationFormatVersion !== CIRCLE_MIGRATION_FORMAT_VERSION
      ) {
        throw new CircleMigrationServiceError(409, 'MIGRATION_FORMAT_UNSUPPORTED', 'Migration format version is unsupported');
      }
      if (
        payload.schemaFingerprint !== undefined
        && payload.schemaFingerprint !== CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
      ) {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_SCHEMA_FINGERPRINT_MISMATCH',
          'Requested migration schema fingerprint is unsupported'
        );
      }

      const serviceUrl = new URL(destinationServiceEndpoint);
      const serviceHost = normalizeHost(serviceUrl.host);
      const migrationSlotId = createOpaqueClaimToken('mslot');
      const migrationCode = createOpaqueClaimToken('mig');
      const destinationCircleId = `c_${createOpaqueClaimToken('').replace(/^_/, '').slice(0, 24)}`;
      const wildcardBaseDomain = getCircleAddressRuntimeConfig().managedWildcardBaseDomain || '';
      if (addressMode === 'managed' && !wildcardBaseDomain) {
        throw new CircleMigrationServiceError(409, 'MANAGED_WILDCARD_UNAVAILABLE', 'Managed wildcard addressing is not configured');
      }
      const requestedTarget = addressMode === 'shared'
        ? destinationServiceEndpoint
        : addressMode === 'managed'
          ? `https://${destinationCircleId}.${wildcardBaseDomain}`
          : payload.targetPublicBaseUrl;
      const targetPublicBaseUrl = requireNormalizedHttpsUrl(requestedTarget, 'targetPublicBaseUrl');
      const targetUrl = new URL(targetPublicBaseUrl);
      const targetHost = normalizeHost(targetUrl.host);

      const expectedFamilyIdRaw = String(payload.expectedFamilyId || '').trim();
      if (expectedFamilyIdRaw && !isUuid(expectedFamilyIdRaw)) {
        throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'expectedFamilyId must be a UUID');
      }
      const expectedOwnerIdentityId = String(payload.expectedOwnerIdentityId || '').trim() || null;
      const expiresInHoursRaw = Number(payload.expiresInHours ?? 24);
      if (!Number.isFinite(expiresInHoursRaw) || expiresInHoursRaw < 1 || expiresInHoursRaw > 24 * 7) {
        throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'expiresInHours must be between 1 and 168');
      }

      const rawLimits = (payload.limits && typeof payload.limits === 'object')
        ? payload.limits as Record<string, unknown>
        : {};
      const maxMemberIdentities = normalizeOptionalLimit(rawLimits.maxMemberIdentities, 'maxMemberIdentities');
      const maxTotalIdentities = normalizeOptionalLimit(rawLimits.maxTotalIdentities, 'maxTotalIdentities');
      if (
        maxMemberIdentities !== null
        && maxTotalIdentities !== null
        && maxTotalIdentities < maxMemberIdentities
      ) {
        throw new CircleMigrationServiceError(
          400,
          'INVALID_REQUEST',
          'maxTotalIdentities cannot be lower than maxMemberIdentities'
        );
      }

      const rawPolicies = (payload.policies && typeof payload.policies === 'object')
        ? payload.policies as Record<string, unknown>
        : {};
      const messageTtlHours = normalizeOptionalLimit(rawPolicies.messageTtlHours, 'messageTtlHours');
      if (messageTtlHours !== null && messageTtlHours > 24 * 365) {
        throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'messageTtlHours cannot exceed 8760');
      }
      const messageArchivePolicyAfterActivation = rawPolicies.messageArchivePolicyAfterActivation ?? 'text';
      if (!['disabled', 'text', 'text_with_attachments'].includes(String(messageArchivePolicyAfterActivation))) {
        throw new CircleMigrationServiceError(400, 'INVALID_REQUEST', 'messageArchivePolicyAfterActivation is invalid');
      }
      const normalizedPolicies = {
        messageTtlHours,
        attachmentsEnabledAfterActivation: rawPolicies.attachmentsEnabledAfterActivation !== false,
        messageArchivePolicyAfterActivation: String(messageArchivePolicyAfterActivation)
      };
      const normalizedLimits = {
        maxMemberIdentities,
        maxTotalIdentities
      };
      const requestFingerprint = sha256Fingerprint(canonicalizeCircleMigrationJson({
        targetPublicBaseUrl: addressMode === 'managed' ? null : targetPublicBaseUrl,
        addressMode,
        destinationServiceEndpoint,
        serverName,
        expectedFamilyId: expectedFamilyIdRaw || null,
        expectedOwnerIdentityId,
        expiresInHours: expiresInHoursRaw,
        limits: normalizedLimits,
        policies: normalizedPolicies,
        migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
        schemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
        dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT
      }));

      const existingByIdempotency = await circleMigrationRepository.findSlotByAdminIdempotency(
        req.serverAdmin!.serverAdminId,
        idempotencyKey
      );
      if (existingByIdempotency) {
        if (existingByIdempotency.request_fingerprint !== requestFingerprint) {
          throw new CircleMigrationServiceError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'idempotencyKey is already bound to another migration slot request'
          );
        }
        const recovered = decryptMigrationSecret<{ migrationCode: string }>(
          existingByIdempotency.migration_code_encrypted
        );
        return res.json({
          status: 'ok',
          result: {
            ...serializeSlot(existingByIdempotency),
            migrationCode: recovered.migrationCode,
            acceptedDataScopes: CIRCLE_MIGRATION_FIXED_SCOPES,
            destinationServerId: getServerIdentityRuntimeConfig().vpsId
          }
        });
      }

      const requestHost = getRequestHost(req);
      const serviceDnsValidation = await validateTenantDomainDns(requestHost, serviceHost);
      if (!serviceDnsValidation.ok) {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'MIGRATION_SERVICE_ENDPOINT_INVALID',
            message: 'Destination service endpoint does not point to this server',
            details: serviceDnsValidation
          }
        });
      }
      const serviceTlsValidation = await validateTenantTlsCertificate(serviceUrl);
      if (!serviceTlsValidation.ok) {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'MIGRATION_SERVICE_ENDPOINT_INVALID',
            message: 'Destination service endpoint TLS certificate is unavailable',
            details: serviceTlsValidation
          }
        });
      }

      const usesManagedWildcard = addressMode === 'managed';
      const dnsValidation = usesManagedWildcard
        ? { ok: true as const, expectedIps: [], actualIps: [], reason: 'managed_wildcard' }
        : await validateTenantDomainDns(requestHost, targetHost);
      if (!dnsValidation.ok) {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'MIGRATION_DNS_NOT_READY',
            message: 'Target domain DNS does not point to this server',
            details: dnsValidation
          }
        });
      }
      const tlsValidation = usesManagedWildcard
        ? { ok: true as const, reason: 'managed_wildcard' }
        : await validateTenantTlsCertificate(targetUrl);
      if (!tlsValidation.ok) {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'MIGRATION_TLS_NOT_READY',
            message: 'Target domain TLS certificate is unavailable',
            details: tlsValidation
          }
        });
      }

      const slot = await circleMigrationRepository.createSlot({
        migrationSlotId,
        migrationCodeHash: hashClaimToken(migrationCode),
        migrationCodeEncrypted: encryptMigrationSecret({ migrationCode }),
        destinationCircleId,
        targetPublicBaseUrl,
        targetHost,
        serviceEndpoint: destinationServiceEndpoint,
        serverName,
        createdByServerAdminId: req.serverAdmin!.serverAdminId,
        idempotencyKey,
        requestFingerprint,
        expiresAt: new Date(Date.now() + Math.floor(expiresInHoursRaw * 60 * 60 * 1000)),
        settings: normalizedPolicies,
        limits: normalizedLimits,
        migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
        dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
        destinationSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
        expectedFamilyId: expectedFamilyIdRaw || null,
        expectedOwnerIdentityId
      });

      return res.json({
        status: 'ok',
        result: {
          ...serializeSlot(slot),
          migrationCode,
          acceptedDataScopes: CIRCLE_MIGRATION_FIXED_SCOPES,
          destinationServerId: getServerIdentityRuntimeConfig().vpsId
        }
      });
    } catch (error: any) {
      if (error instanceof CircleMigrationServiceError) {
        return res.status(error.status).json({
          status: 'error',
          error: { code: error.code, message: error.message }
        });
      }
      if (error?.code === '23505') {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'MIGRATION_TARGET_HOST_ALREADY_USED',
            message: 'Target host already has an open migration slot'
          }
        });
      }
      routeLogger.error('Create migration slot error:', error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create migration slot' }
      });
    }
  }
);

router.post(
  '/list',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest, res) => {
    try {
      const payload = getSignedPayload<{ limit?: number }>(req);
      const slots = await circleMigrationRepository.listSlots(payload.limit);
      return res.json({
        status: 'ok',
        result: { slots: slots.map(serializeSlot) }
      });
    } catch (error) {
      routeLogger.error('List migration slots error:', error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list migration slots' }
      });
    }
  }
);

router.post(
  '/:migrationSlotId/revoke',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest, res) => {
    try {
      const migrationSlotId = String(req.params.migrationSlotId || '').trim();
      const current = await circleMigrationRepository.findSlotById(migrationSlotId);
      if (!current) {
        throw new CircleMigrationServiceError(404, 'MIGRATION_SLOT_NOT_FOUND', 'Migration slot not found');
      }
      if (current.status === 'revoked') {
        return res.json({ status: 'ok', result: serializeSlot(current) });
      }
      if (current.status !== 'pending' && current.status !== 'verified') {
        throw new CircleMigrationServiceError(
          409,
          'INVALID_STATE',
          `Migration slot cannot be revoked from ${current.status}`
        );
      }
      const revoked = await circleMigrationRepository.transitionSlot(
        migrationSlotId,
        current.status,
        'revoked'
      );
      if (!revoked) {
        throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration slot changed concurrently');
      }
      return res.json({ status: 'ok', result: serializeSlot(revoked) });
    } catch (error) {
      if (error instanceof CircleMigrationServiceError) {
        return res.status(error.status).json({
          status: 'error',
          error: { code: error.code, message: error.message }
        });
      }
      routeLogger.error('Revoke migration slot error:', error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke migration slot' }
      });
    }
  }
);

export default router;
