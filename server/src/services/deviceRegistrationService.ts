import type {
  DeviceId,
  DeviceRegistrationAttestation,
  IdentityId,
  PublicKey
} from '../../../shared/types';
import { transaction } from '../db';
import { deviceRepository, trustedDeviceRekeyRepository } from '../db/repositories';
import { requestTrustedDeviceRekeyProcessing } from './trustedDeviceRekeyService';

export async function registerIdentityDevice(params: {
  familyId: string;
  identityId: IdentityId;
  deviceId: DeviceId;
  devicePublicKey: PublicKey;
  deviceEncryptionPublicKey?: PublicKey;
  registrationAttestation: DeviceRegistrationAttestation | null;
  label: string | null;
  webOrigin: string | null;
  encryptedPhysicalDeviceId: unknown | null;
}) {
  const outcome = await transaction(async (client) => {
    const identityResult = await client.query<{ identity_id: string; status: string; role?: string }>(
      `SELECT identity_id, status, role
         FROM identities
        WHERE family_id = $1 AND identity_id = $2
        FOR UPDATE`,
      [params.familyId, params.identityId]
    );
    if (identityResult.rows[0]?.status !== 'active') {
      throw new DeviceRegistrationError('Identity is not active');
    }
    if (identityResult.rows[0]?.role === 'guest') {
      const registration = await client.query(
        `SELECT registration_id FROM direct_guest_registrations
          WHERE family_id = $1 AND guest_identity_id = $2 AND status = 'active'
          FOR SHARE`,
        [params.familyId, params.identityId]
      );
      if (!registration.rows.length) throw new DeviceRegistrationError('Guest access is no longer active');
    }
    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM devices
        WHERE family_id = $1 AND identity_id = $2`,
      [params.familyId, params.identityId]
    );
    const existingDeviceCount = Number(countResult.rows[0]?.count || 0);
    const device = await deviceRepository.create({
      familyId: params.familyId,
      deviceId: params.deviceId,
      identityId: params.identityId,
      publicKeyAlgorithm: params.devicePublicKey.algorithm,
      publicKeyValue: params.devicePublicKey.value,
      encryptionPublicKeyAlgorithm: params.deviceEncryptionPublicKey?.algorithm === 'x25519'
        ? 'x25519'
        : null,
      encryptionPublicKeyValue: params.deviceEncryptionPublicKey?.value || null,
      registrationAttestation: params.registrationAttestation,
      label: params.label,
      webOrigin: params.webOrigin,
      encryptedPhysicalDeviceId: params.encryptedPhysicalDeviceId
    }, client);
    const rekey = existingDeviceCount > 0
      ? await trustedDeviceRekeyRepository.enqueue(client, {
          familyId: params.familyId,
          identityId: params.identityId,
          deviceId: params.deviceId,
          reason: 'device_added'
        })
      : null;
    return { device, rekey };
  });

  if (outcome.rekey?.status === 'pending') requestTrustedDeviceRekeyProcessing();
  return outcome;
}

export class DeviceRegistrationError extends Error {}
