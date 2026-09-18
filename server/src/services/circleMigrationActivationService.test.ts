import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  canonicalizeCircleMigrationJson,
  sha256Fingerprint
} from './circleMigrationContract';
import {
  CIRCLE_MIGRATION_BRIDGE_RETENTION_MS,
  validateCutoverConfirmationAgainstBinding
} from './circleMigrationActivationService';

describe('Circle migration owner cutover proof', () => {
  const owner = nacl.sign.keyPair();
  const manifest = { format: 'test', familyId: 'family' };
  const binding = {
    migrationSlotId: 'mslot_test',
    migrationId: 'migjob_test',
    familyId: '11111111-1111-4111-8111-111111111111',
    ownerIdentityId: 'owner_1',
    sourceServerId: 'source-server',
    destinationServerId: 'destination-server',
    sourceCircleId: 'circle_source_1234567890',
    destinationCircleId: 'circle_destination_123456',
    oldPublicBaseUrl: 'https://old.example',
    targetPublicBaseUrl: 'https://new.example',
    manifest,
    ownerPublicKey: {
      algorithm: 'ed25519' as const,
      value: encodeBase64(owner.publicKey)
    }
  };

  function confirmation(overrides: Record<string, unknown> = {}) {
    const movedAt = Date.now();
    const payload = {
      migrationSlotId: binding.migrationSlotId,
      migrationId: binding.migrationId,
      familyId: binding.familyId,
      ownerIdentityId: binding.ownerIdentityId,
      sourceServerId: binding.sourceServerId,
      destinationServerId: binding.destinationServerId,
      sourceCircleId: binding.sourceCircleId,
      destinationCircleId: binding.destinationCircleId,
      oldPublicBaseUrl: binding.oldPublicBaseUrl,
      targetPublicBaseUrl: binding.targetPublicBaseUrl,
      activationMode: 'new_domain',
      manifestFingerprint: sha256Fingerprint(canonicalizeCircleMigrationJson(manifest)),
      movedAt: new Date(movedAt).toISOString(),
      bridgeExpiresAt: new Date(movedAt + CIRCLE_MIGRATION_BRIDGE_RETENTION_MS).toISOString(),
      ...overrides
    };
    return {
      payload,
      signature: encodeBase64(nacl.sign.detached(
        Buffer.from(canonicalizeCircleMigrationJson(payload), 'utf8'),
        owner.secretKey
      ))
    } as any;
  }

  it('accepts a fresh proof bound to the exact manifest and servers', () => {
    expect(() => validateCutoverConfirmationAgainstBinding(
      binding,
      confirmation()
    )).not.toThrow();
  });

  it('rejects a proof replayed for another destination', () => {
    expect(() => validateCutoverConfirmationAgainstBinding(
      binding,
      confirmation({ destinationServerId: 'attacker' })
    )).toThrow(expect.objectContaining({ code: 'MIGRATION_OWNER_PROOF_INVALID' }));
  });

  it('rejects a bridge window different from the fixed retention period', () => {
    expect(() => validateCutoverConfirmationAgainstBinding(
      binding,
      confirmation({ bridgeExpiresAt: new Date(Date.now() + 10_000).toISOString() })
    )).toThrow(expect.objectContaining({ code: 'MIGRATION_OWNER_PROOF_INVALID' }));
  });
});
