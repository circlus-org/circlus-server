import type { PublicKey } from '../../../shared/types';
import { transaction } from '../db';
import { deviceEnrollmentRepository } from '../db/repositories/deviceEnrollmentRepository';
import { temporaryDeviceRepository } from '../db/repositories';

export type DeviceEnrollmentChatAccessGrant = {
  chatId: string;
  chatType: 'group' | 'direct';
  epoch: number;
  envelopeCiphertext: string;
  publisherIdentityId: string;
  publisherEncPublicKeyAlgo: string;
  publisherEncPublicKeyValue: string;
};

export class DeviceEnrollmentApprovalConflict extends Error {}

export async function approveDeviceEnrollment(params: {
  familyId: string;
  enrollmentId: string;
  approvingIdentityId: string;
  approvingDeviceId: string;
  accessMode: 'temporary' | 'full_circle';
  temporaryDeviceId: string;
  temporaryDevicePublicKey: PublicKey;
  temporaryDeviceEncryptionPublicKey?: PublicKey;
  encryptedTemporaryMembership: string;
  cipher: string;
  accessExpiresAt: Date;
  payloadExpiresAt: Date;
  approvalSenderPublicKey?: PublicKey;
  canCall: boolean;
  chatAccess: DeviceEnrollmentChatAccessGrant[];
  approvalAttestation?: {
    payload: string;
    signature: string;
    approvingDevicePublicKey: string;
  };
}) {
  return transaction(async (client) => {
    if (params.accessMode === 'temporary') {
      await temporaryDeviceRepository.createOrRefresh({
        familyId: params.familyId,
        deviceId: params.temporaryDeviceId,
        identityId: params.approvingIdentityId,
        publicKeyAlgorithm: params.temporaryDevicePublicKey.algorithm,
        publicKeyValue: params.temporaryDevicePublicKey.value,
        encryptionPublicKeyAlgorithm: params.temporaryDeviceEncryptionPublicKey?.algorithm === 'x25519'
          ? 'x25519'
          : null,
        encryptionPublicKeyValue: params.temporaryDeviceEncryptionPublicKey?.value || null,
        approvedByDeviceId: params.approvingDeviceId,
        expiresAt: params.accessExpiresAt
      }, client);
      await temporaryDeviceRepository.setCallCapability(
        params.familyId,
        params.temporaryDeviceId,
        params.canCall,
        client
      );
      if (params.approvalAttestation) {
        await temporaryDeviceRepository.storeApprovalAttestation(
          params.familyId,
          params.temporaryDeviceId,
          params.approvalAttestation,
          client
        );
      }
      if (params.chatAccess.length > 0) {
        await temporaryDeviceRepository.storeChatAccess(
          params.familyId,
          params.temporaryDeviceId,
          params.chatAccess.map(({ chatId, chatType }) => ({ chatId, chatType })),
          client
        );
        for (const grant of params.chatAccess) {
          if (grant.chatType === 'group') {
            await temporaryDeviceRepository.upsertGroupChatKeyEnvelope({
              temporaryDeviceId: params.temporaryDeviceId,
              familyId: params.familyId,
              chatId: grant.chatId,
              epoch: grant.epoch,
              envelopeCiphertext: grant.envelopeCiphertext,
              publisherIdentityId: grant.publisherIdentityId,
              publisherEncPublicKeyAlgo: grant.publisherEncPublicKeyAlgo,
              publisherEncPublicKeyValue: grant.publisherEncPublicKeyValue
            }, client);
          } else {
            await temporaryDeviceRepository.upsertDirectChatKeyEnvelope({
              temporaryDeviceId: params.temporaryDeviceId,
              familyId: params.familyId,
              directChatId: grant.chatId,
              epoch: grant.epoch,
              envelopeCiphertext: grant.envelopeCiphertext,
              publisherIdentityId: grant.publisherIdentityId,
              publisherEncPublicKeyAlgo: grant.publisherEncPublicKeyAlgo,
              publisherEncPublicKeyValue: grant.publisherEncPublicKeyValue
            }, client);
          }
        }
      }
    }

    const transitioned = await deviceEnrollmentRepository.markApproved({
      familyId: params.familyId,
      enrollmentId: params.enrollmentId,
      approvedByDeviceId: params.approvingDeviceId,
      temporaryDeviceId: params.temporaryDeviceId,
      temporaryDevicePublicKeyAlgorithm: params.temporaryDevicePublicKey.algorithm,
      temporaryDevicePublicKeyValue: params.temporaryDevicePublicKey.value,
      temporaryDeviceEncryptionPublicKeyAlgorithm: params.temporaryDeviceEncryptionPublicKey?.algorithm === 'x25519'
        ? 'x25519'
        : null,
      temporaryDeviceEncryptionPublicKeyValue: params.temporaryDeviceEncryptionPublicKey?.value || null,
      encryptedTemporaryMembership: params.encryptedTemporaryMembership,
      cipher: params.cipher,
      expiresAt: params.accessExpiresAt.toISOString(),
      accessMode: params.accessMode,
      payloadExpiresAt: params.payloadExpiresAt,
      approvalSenderPublicKeyAlgorithm: params.approvalSenderPublicKey?.algorithm === 'ed25519'
        ? 'ed25519'
        : null,
      approvalSenderPublicKeyValue: params.approvalSenderPublicKey?.value || null
    }, client);
    if (!transitioned) {
      throw new DeviceEnrollmentApprovalConflict('Enrollment state changed while completing');
    }
    return transitioned;
  });
}
