import { query as dbQuery } from '../index';

export type NativeMessagePreviewMode = 'off' | 'after_unlock' | 'always';

export function normalizeNativeMessagePreviewMode(value: unknown): NativeMessagePreviewMode {
  if (value === 'always') return 'always';
  if (value === 'after_unlock') return 'after_unlock';
  return 'off';
}

export type DeviceBindingRecord = {
  web_device_id: string;
  mobile_endpoint_id: string | null;
  mobile_endpoint_ref: string | null;
  route: 'web_push' | 'mobile_push';
  bound_web_origin: string | null;
  status: 'active' | 'inactive' | 'revoked';
  bound_at: Date;
  unbound_at: Date | null;
  delivery_token: string | null;
  delivery_token_expires_at: Date | null;
  push_encryption_public_key: string | null;
  native_message_preview_mode: NativeMessagePreviewMode;
};

function mapDeviceBinding(row: Record<string, any>): DeviceBindingRecord {
  return {
    web_device_id: row.web_device_id,
    mobile_endpoint_id: row.mobile_endpoint_id || null,
    mobile_endpoint_ref: row.mobile_endpoint_ref || null,
    route: row.route as DeviceBindingRecord['route'],
    bound_web_origin: row.bound_web_origin || null,
    status: row.status as DeviceBindingRecord['status'],
    bound_at: row.bound_at,
    unbound_at: row.unbound_at || null,
    delivery_token: row.delivery_token || null,
    delivery_token_expires_at: row.delivery_token_expires_at || null,
    push_encryption_public_key: row.push_encryption_public_key || null,
    native_message_preview_mode: normalizeNativeMessagePreviewMode(row.native_message_preview_mode),
  };
}

export class MobileNotificationRepository {
  async unbindToWebPush(familyId: string, webDeviceId: string): Promise<void> {
    await dbQuery(
      `UPDATE device_notification_bindings
       SET status = 'inactive',
           route = 'web_push',
           unbound_at = NOW(),
           updated_at = NOW()
       WHERE family_id = $1
         AND web_device_id = $2
         AND status = 'active'`,
      [familyId, webDeviceId]
    );
  }

  async getActiveBindingByWebDeviceId(familyId: string, webDeviceId: string): Promise<DeviceBindingRecord | null> {
    const result = await dbQuery(
      `SELECT web_device_id, mobile_endpoint_id, mobile_endpoint_ref, route, bound_web_origin, status,
              bound_at, unbound_at, delivery_token, delivery_token_expires_at, push_encryption_public_key,
              native_message_preview_mode
         FROM device_notification_bindings
        WHERE family_id = $1
          AND web_device_id = $2
          AND status = 'active'
        LIMIT 1`,
      [familyId, webDeviceId]
    );
    return result.rows[0] ? mapDeviceBinding(result.rows[0]) : null;
  }

  async upsertDirectMobileRoute(data: {
    familyId: string;
    webDeviceId: string;
    mobileEndpointId?: string | null;
    boundWebOrigin?: string | null;
    deliveryToken: string;
    deliveryTokenExpiresAt?: Date | null;
    pushEncryptionPublicKey: string;
    nativeMessagePreviewMode?: NativeMessagePreviewMode;
  }): Promise<DeviceBindingRecord> {
    const nativeMessagePreviewMode = normalizeNativeMessagePreviewMode(data.nativeMessagePreviewMode);
    const result = await dbQuery(
      `INSERT INTO device_notification_bindings
         (family_id, web_device_id, mobile_endpoint_id, mobile_endpoint_ref, route, bound_web_origin, status, bound_at, unbound_at, delivery_token, delivery_token_expires_at, push_encryption_public_key, native_message_preview_mode)
       VALUES
         ($1, $2, NULL, $3, 'mobile_push', $4, 'active', NOW(), NULL, $5, $6, $7, $8)
       ON CONFLICT (family_id, web_device_id) WHERE status = 'active'
       DO UPDATE SET
         mobile_endpoint_id = NULL,
         mobile_endpoint_ref = EXCLUDED.mobile_endpoint_ref,
         route = EXCLUDED.route,
         bound_web_origin = EXCLUDED.bound_web_origin,
         bound_at = NOW(),
         unbound_at = NULL,
         delivery_token = EXCLUDED.delivery_token,
         delivery_token_expires_at = EXCLUDED.delivery_token_expires_at,
         push_encryption_public_key = EXCLUDED.push_encryption_public_key,
         native_message_preview_mode = EXCLUDED.native_message_preview_mode,
         updated_at = NOW()
       RETURNING web_device_id, mobile_endpoint_id, mobile_endpoint_ref, route, bound_web_origin, status, bound_at, unbound_at, delivery_token, delivery_token_expires_at, push_encryption_public_key, native_message_preview_mode`,
      [
        data.familyId,
        data.webDeviceId,
        data.mobileEndpointId || null,
        data.boundWebOrigin || null,
        data.deliveryToken,
        data.deliveryTokenExpiresAt || null,
        data.pushEncryptionPublicKey,
        nativeMessagePreviewMode,
      ]
    );
    return mapDeviceBinding(result.rows[0]);
  }
}

export const mobileNotificationRepository = new MobileNotificationRepository();
