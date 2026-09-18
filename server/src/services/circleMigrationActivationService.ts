import type { PublicKey } from '../../../shared/types';
import type { MigrationSlotRecord } from '../db/repositories/circleMigrationRepository';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import { verifySignature } from '../utils/crypto';
import { validateTenantDomainDns, validateTenantTlsCertificate } from '../utils/tenantDomainValidation';
import { isBlockedManagedHost } from '../utils/publicSiteDomainPolicy';
import {
  canonicalizeCircleMigrationJson,
  sha256Fingerprint
} from './circleMigrationContract';
import { publicSiteGeneratorService } from './publicSiteGeneratorService';
import { CircleMigrationServiceError } from './circleMigrationSlotService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

export const CIRCLE_MIGRATION_BRIDGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CUTOVER_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface OwnerSignedCutoverConfirmation {
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
    activationMode: 'new_domain';
    manifestFingerprint: string;
    movedAt: string;
    bridgeExpiresAt: string;
  };
  signature: string;
}

const CUTOVER_PAYLOAD_KEYS = [
  'migrationSlotId',
  'migrationId',
  'familyId',
  'ownerIdentityId',
  'sourceServerId',
  'destinationServerId',
  'sourceCircleId',
  'destinationCircleId',
  'oldPublicBaseUrl',
  'targetPublicBaseUrl',
  'activationMode',
  'manifestFingerprint',
  'movedAt',
  'bridgeExpiresAt'
].sort();

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export interface CutoverConfirmationBinding {
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
  manifest: Record<string, unknown>;
  ownerPublicKey: PublicKey;
}

export function validateCutoverConfirmationAgainstBinding(
  binding: CutoverConfirmationBinding,
  confirmation: OwnerSignedCutoverConfirmation,
  options: { requireFresh: boolean } = { requireFresh: true }
): void {
  const payload = confirmation?.payload;
  if (
    !payload
    || typeof confirmation.signature !== 'string'
    || !confirmation.signature
    || JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(CUTOVER_PAYLOAD_KEYS)
  ) {
    throw new CircleMigrationServiceError(
      400,
      'MIGRATION_OWNER_PROOF_INVALID',
      'Owner-signed cutover confirmation is required'
    );
  }
  const movedAt = Date.parse(payload.movedAt);
  const bridgeExpiresAt = Date.parse(payload.bridgeExpiresAt);
  const now = Date.now();
  const expectedManifestFingerprint = sha256Fingerprint(
    canonicalizeCircleMigrationJson(binding.manifest)
  );
  const matches = (
    payload.migrationSlotId === binding.migrationSlotId
    && payload.migrationId === binding.migrationId
    && payload.familyId === binding.familyId
    && payload.ownerIdentityId === binding.ownerIdentityId
    && payload.sourceServerId === binding.sourceServerId
    && payload.destinationServerId === binding.destinationServerId
    && payload.sourceCircleId === binding.sourceCircleId
    && payload.destinationCircleId === binding.destinationCircleId
    && normalizedOrigin(payload.oldPublicBaseUrl) === normalizedOrigin(binding.oldPublicBaseUrl)
    && normalizedOrigin(payload.targetPublicBaseUrl) === normalizedOrigin(binding.targetPublicBaseUrl)
    && payload.activationMode === 'new_domain'
    && payload.manifestFingerprint === expectedManifestFingerprint
    && Number.isFinite(movedAt)
    && Number.isFinite(bridgeExpiresAt)
    && bridgeExpiresAt - movedAt === CIRCLE_MIGRATION_BRIDGE_RETENTION_MS
    && (!options.requireFresh || Math.abs(now - movedAt) <= CUTOVER_CLOCK_SKEW_MS)
    && bridgeExpiresAt > now
  );
  if (!matches) {
    throw new CircleMigrationServiceError(
      400,
      'MIGRATION_OWNER_PROOF_INVALID',
      'Cutover confirmation does not match the imported Circle'
    );
  }
  if (
    !verifySignature(
      canonicalizeCircleMigrationJson(payload),
      confirmation.signature,
      binding.ownerPublicKey
    )
  ) {
    throw new CircleMigrationServiceError(
      401,
      'MIGRATION_OWNER_PROOF_INVALID',
      'Cutover confirmation signature is invalid'
    );
  }
}

export function validateOwnerSignedCutoverConfirmation(
  slot: MigrationSlotRecord,
  confirmation: OwnerSignedCutoverConfirmation,
  options: { requireFresh: boolean } = { requireFresh: true }
): void {
  if (
    !slot.source_migration_id
    || !slot.expected_family_id
    || !slot.expected_owner_identity_id
    || !slot.source_server_id
    || !slot.source_circle_id
    || !slot.source_server_url
    || !slot.import_manifest
    || !slot.owner_identity_public_key
  ) {
    throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration slot binding is incomplete');
  }
  validateCutoverConfirmationAgainstBinding({
    migrationSlotId: slot.migration_slot_id,
    migrationId: slot.source_migration_id,
    familyId: slot.expected_family_id,
    ownerIdentityId: slot.expected_owner_identity_id,
    sourceServerId: slot.source_server_id,
    destinationServerId: getServerIdentityRuntimeConfig().vpsId,
    sourceCircleId: slot.source_circle_id,
    destinationCircleId: slot.destination_circle_id,
    oldPublicBaseUrl: slot.source_server_url,
    targetPublicBaseUrl: slot.target_public_base_url,
    manifest: slot.import_manifest,
    ownerPublicKey: slot.owner_identity_public_key as unknown as PublicKey
  }, confirmation, options);
}

class CircleMigrationActivationService {
  async activate(input: {
    slot: MigrationSlotRecord;
    serviceRequestHost: string | null;
    confirmation: OwnerSignedCutoverConfirmation;
  }): Promise<MigrationSlotRecord> {
    let slot = input.slot;
    if (slot.status === 'active') {
      if (
        slot.owner_signed_cutover_confirmation
        && canonicalizeCircleMigrationJson(slot.owner_signed_cutover_confirmation)
          === canonicalizeCircleMigrationJson(input.confirmation)
      ) {
        return slot;
      }
      throw new CircleMigrationServiceError(409, 'MIGRATION_OWNER_PROOF_INVALID', 'Migration is already active with another proof');
    }
    if (
      !['waiting_cutover', 'activating', 'failed'].includes(slot.status)
      || !slot.imported_family_id
      || !slot.import_manifest
    ) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration slot is ${slot.status}`);
    }
    const storedConfirmation = slot.owner_signed_cutover_confirmation;
    if (
      storedConfirmation
      && canonicalizeCircleMigrationJson(storedConfirmation)
        !== canonicalizeCircleMigrationJson(input.confirmation)
    ) {
      throw new CircleMigrationServiceError(
        409,
        'MIGRATION_OWNER_PROOF_INVALID',
        'Activation retry uses another cutover confirmation'
      );
    }
    validateOwnerSignedCutoverConfirmation(slot, input.confirmation, {
      requireFresh: !storedConfirmation
    });

    if (slot.status !== 'activating') {
      const activating = await circleMigrationRepository.beginSlotActivation({
        migrationSlotId: slot.migration_slot_id,
        ownerSignedCutoverConfirmation: input.confirmation as unknown as Record<string, unknown>
      });
      if (!activating) {
        throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration slot changed concurrently before activation');
      }
      slot = activating;
    }
    const importedFamilyId = slot.imported_family_id;
    if (!importedFamilyId) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Imported Circle id is missing');
    }

    try {
      const targetUrl = new URL(slot.target_public_base_url);
      const dns = await validateTenantDomainDns(input.serviceRequestHost, slot.target_host);
      if (!dns.ok) {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_DNS_NOT_READY',
          'Target domain no longer points to the destination server'
        );
      }
      const tls = await validateTenantTlsCertificate(targetUrl);
      if (!tls.ok) {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_TLS_NOT_READY',
          'Target domain TLS certificate is unavailable'
        );
      }
      const siteConfig = await publicSiteGeneratorService.getResolvedSiteConfig(importedFamilyId);
      if (siteConfig.enabled && isBlockedManagedHost(slot.target_host)) {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_PUBLIC_SITE_DOMAIN_BLOCKED',
          'Target domain does not allow Public Circle Site publishing'
        );
      }
      const siteReport = await publicSiteGeneratorService.regeneratePendingMigrationSite(
        importedFamilyId,
        slot.target_public_base_url,
        slot.target_host
      );
      const activationReport = {
        status: 'active',
        activatedAt: new Date().toISOString(),
        familyId: importedFamilyId,
        targetPublicBaseUrl: slot.target_public_base_url,
        manifestFingerprint: input.confirmation.payload.manifestFingerprint,
        publicSite: siteReport
      };
      const active = await circleMigrationRepository.completeSlotActivation({
        migrationSlotId: slot.migration_slot_id,
        familyId: importedFamilyId,
        activationReport
      });
      if (!active) {
        throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration slot changed concurrently during activation');
      }
      return active;
    } catch (error) {
      await circleMigrationRepository.transitionSlot(
        slot.migration_slot_id,
        'activating',
        'failed',
        {
          code: error instanceof CircleMigrationServiceError
            ? error.code
            : 'MIGRATION_ACTIVATION_FAILED',
          message: error instanceof Error ? error.message : 'Circle activation failed'
        }
      ).catch(() => undefined);
      throw error;
    }
  }
}

export const circleMigrationActivationService = new CircleMigrationActivationService();
