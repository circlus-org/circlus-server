import { pool } from '../index';
import type { DeviceId } from '@shared/types';

import type {
  FindByPushIdResult,
  CreatePushSubscriptionParams,
  UpdatePushSubscriptionParams,
} from './pushSubscriptionRepository.queries';

import {
  findByPushId,
  findByDeviceAndEndpoint,
  findByDeviceId,
  findActiveByDeviceId,
  createPushSubscription,
  updatePushSubscription,
  updatePushStatus,
  deletePushSubscription,
} from './pushSubscriptionRepository.queries';

export class PushSubscriptionRepository {
  /**
   * Find push subscription by push_id
   */
  async findByPushId(familyId: string, pushId: string): Promise<FindByPushIdResult | null> {
    const results = await findByPushId.run({ familyId, pushId }, pool);
    return results[0] || null;
  }

  /**
   * Find push subscription by device and endpoint
   */
  async findByDeviceAndEndpoint(
    familyId: string,
    deviceId: DeviceId,
    endpoint: string
  ): Promise<FindByPushIdResult | null> {
    const results = await findByDeviceAndEndpoint.run({ familyId, deviceId, endpoint }, pool);
    return results[0] || null;
  }

  /**
   * Find all push subscriptions for a device
   */
  async findByDeviceId(familyId: string, deviceId: DeviceId): Promise<FindByPushIdResult[]> {
    return await findByDeviceId.run({ familyId, deviceId }, pool);
  }

  /**
   * Find active push subscriptions for a device
   */
  async findActiveByDeviceId(familyId: string, deviceId: DeviceId): Promise<FindByPushIdResult[]> {
    return await findActiveByDeviceId.run({ familyId, deviceId }, pool);
  }

  /**
   * Create new push subscription
   */
  async create(data: {
    familyId: string;
    pushId: string;
    deviceId: DeviceId;
    endpoint: string;
    keysP256dh: string;
    keysAuth: string;
    deliveryMethod: 'direct' | 'relay';
    relayToken: string | null;
    pushEncryptionPublicKey: string;
  }): Promise<FindByPushIdResult> {
    const params: CreatePushSubscriptionParams & { familyId: string } = {
      familyId: data.familyId,
      pushId: data.pushId,
      deviceId: data.deviceId,
      endpoint: data.endpoint,
      keysP256dh: data.keysP256dh,
      keysAuth: data.keysAuth,
      deliveryMethod: data.deliveryMethod,
      relayToken: data.relayToken,
      pushEncryptionPublicKey: data.pushEncryptionPublicKey,
    };
    const results = await createPushSubscription.run(params, pool);
    return results[0];
  }

  /**
   * Update push subscription keys
   */
  async updateSubscription(
    familyId: string,
    pushId: string,
    keysP256dh: string,
    keysAuth: string,
    deliveryMethod: 'direct' | 'relay',
    relayToken: string | null,
    pushEncryptionPublicKey: string
  ): Promise<void> {
    const params: UpdatePushSubscriptionParams & { familyId: string } = {
      familyId,
      pushId,
      keysP256dh,
      keysAuth,
      deliveryMethod,
      relayToken,
      pushEncryptionPublicKey
    };
    await updatePushSubscription.run(params, pool);
  }

  /**
   * Update push subscription status
   */
  async updateStatus(
    familyId: string,
    pushId: string,
    status: 'active' | 'disabled' | 'invalid'
  ): Promise<void> {
    await updatePushStatus.run({ familyId, pushId, status }, pool);
  }

  /**
   * Update push encryption public key for a subscription.
   */
  async updatePushEncryptionKey(familyId: string, pushId: string, pushEncryptionPublicKey: string): Promise<void> {
    await pool.query(
      `UPDATE push_subscriptions
       SET push_encryption_public_key = $1, updated_at = NOW()
       WHERE family_id = $2 AND push_id = $3`,
      [pushEncryptionPublicKey, familyId, pushId]
    );
  }

  /**
   * Delete push subscription
   */
  async delete(familyId: string, pushId: string): Promise<void> {
    await deletePushSubscription.run({ familyId, pushId }, pool);
  }
}

export const pushSubscriptionRepository = new PushSubscriptionRepository();
