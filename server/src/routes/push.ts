import { compatiblePushRegistration } from '../services/compatiblePushRegistration';
import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import express, { type Response, type NextFunction } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { createNonceStore, validateSignedRequestEnvelope, consumeSignedRequestEnvelope } from '../middleware/auth';
import { nanoid } from 'nanoid';
import { deviceRepository, pushSubscriptionRepository, temporaryDeviceRepository } from '../db/repositories';
import { verifySignedRequest } from '../utils/crypto';
import {
  getPushVapidKey,
  isRelayDeliveryEnabled,
  getPushServiceUrl,
  type PushDeliveryMode
} from '../utils/push';
import type { SignedRequest, DeviceId } from '@shared/types';
import type { TenancyRequest } from '../middleware/tenancy';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { signPushServiceRequest } from '../utils/pushServiceS2S';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';

const router = express.Router();
const pushNonces = createNonceStore();

const pushRateLimits = getRateLimitRuntimeConfig().push;

const rlVapidKey = createRateLimiter({
  name: 'push:vapid-key',
  windowMs: pushRateLimits.windowMs,
  max: pushRateLimits.vapidKeyMax,
  keyFn: ipFamilyKey,
  onRateLimited: (_req, res) => res.status(429).json({ success: false, error: 'Too many requests' })
});

const rlPushMutation = createRateLimiter({
  name: 'push:mutations',
  windowMs: pushRateLimits.windowMs,
  max: pushRateLimits.mutationsMax,
  keyFn: ipFamilyKey,
  onRateLimited: (_req, res) => res.status(429).json({ success: false, error: 'Too many requests' })
});

type PushSignerResolution =
  | {
      deviceId: DeviceId;
      publicKey: {
        algorithm: 'ed25519' | 'x25519';
        value: string;
      };
    }
  | {
      errorStatus: number;
      error: string;
    };

async function resolvePushSigner(familyId: string, signerId: DeviceId): Promise<PushSignerResolution> {
  const device = await deviceRepository.findByDeviceId(familyId, signerId);
  if (device) {
    if (device.status !== 'active') {
      return { errorStatus: 403, error: 'Device is not active' };
    }
    return {
      deviceId: device.device_id as DeviceId,
      publicKey: {
        algorithm: device.public_key_algorithm as 'ed25519' | 'x25519',
        value: device.public_key_value
      }
    };
  }

  const temporaryDevice = await temporaryDeviceRepository.findByDeviceId(familyId, signerId);
  if (!temporaryDevice) {
    return { errorStatus: 404, error: 'Device not found' };
  }
  if (temporaryDevice.status !== 'active' || temporaryDevice.expires_at.getTime() <= Date.now()) {
    return { errorStatus: 403, error: 'Device is not active' };
  }

  return {
    deviceId: temporaryDevice.device_id as DeviceId,
    publicKey: {
      algorithm: temporaryDevice.public_key_algorithm as 'ed25519' | 'x25519',
      value: temporaryDevice.public_key_value
    }
  };
}

/**
 * Get VAPID public key for client
 */
router.get('/vapid-key', rlVapidKey, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const deliveryInfo = await getPushVapidKey();

    if (!deliveryInfo?.publicKey) {
      return res.status(503).json({
        success: false,
        error: 'Push notifications not configured'
      });
    }

    res.json({
      success: true,
      publicKey: deliveryInfo.publicKey
    });
  } catch (error) {
    routeLogger.error('Error getting VAPID key:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get VAPID key'
    });
  }
});

/**
 * Register push subscription
 */
async function requirePushSignature(req: AuthRequest & {pushSigner?: Exclude<PushSignerResolution,{error:string}>}, res: Response, next: NextFunction) {
  try {
    const request = req.body;
    const expected = req.route.path === '/subscribe' ? 'push:subscribe' : 'push:unsubscribe';
    if (request?.type !== expected) return res.status(400).json({success:false,error:'Unexpected signed request type'});
    const envelope = validateSignedRequestEnvelope(request,pushNonces);
    if (!envelope.ok) return res.status(envelope.status).json({success:false,error:envelope.message});
    const signer = await resolvePushSigner(req.familyId!,request.signerId);
    if ('error' in signer) return res.status(signer.errorStatus).json({success:false,error:signer.error});
    if (!verifySignedRequest(request,signer.publicKey)) return res.status(401).json({success:false,error:'Invalid signature'});
    const claimed = await consumeSignedRequestEnvelope(request,pushNonces);
    if (!claimed.ok) return res.status(claimed.status).json({success:false,error:claimed.message});
    req.pushSigner=signer;
    req.signedRequest=request;
    next();
  } catch (error) { next(error); }
}

router.post('/subscribe', rlPushMutation, requirePushSignature, compatiblePushRegistration(async (req, res) => {
  try {
    const { familyId } = req as TenancyRequest;
    if (!familyId) {
      return res.status(500).json({
        success: false,
        error: 'Family context is missing'
      });
    }

    const signedRequest: SignedRequest<{
      subscription: {
        endpoint: string;
        keys: {
          p256dh: string;
          auth: string;
        };
      };
      delivery?: PushDeliveryMode;
      pushEncryptionPublicKey: string;
    }, DeviceId> = req.body;

    // Validate request
    if (!signedRequest || !signedRequest.signerId || !signedRequest.payload?.subscription) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request'
      });
    }

    const signer = (req as TenancyRequest & {pushSigner: Exclude<PushSignerResolution,{error:string}>}).pushSigner;

    const { subscription } = signedRequest.payload;
    const pushEncryptionPublicKey = String(signedRequest.payload.pushEncryptionPublicKey || '').trim();
    if (!pushEncryptionPublicKey) {
      return res.status(400).json({
        success: false,
        error: 'pushEncryptionPublicKey is required'
      });
    }

    const delivery: PushDeliveryMode = 'relay';
    let relayToken: string | null = null;

    // A 404/410 response from the push provider means this endpoint is no longer usable.
    // Tell the client to create a genuinely fresh browser subscription instead of merely
    // marking the same endpoint active again.
    const existing = await pushSubscriptionRepository.findByDeviceAndEndpoint(
      familyId,
      signer.deviceId,
      subscription.endpoint
    );
    if (existing?.status === 'invalid') {
      return res.json({
        success: true,
        pushId: existing.push_id,
        requiresResubscribe: true
      });
    }

    if (!isRelayDeliveryEnabled()) {
      return res.status(400).json({
        success: false,
        error: 'Relay delivery is disabled'
      });
    }

    const pushServiceUrl = getPushServiceUrl();
    if (!pushServiceUrl) {
      return res.status(500).json({
        success: false,
        error: 'Relay delivery is not configured'
      });
    }

    const relayBody = JSON.stringify({ subscription });
    const s2sHeaders = signPushServiceRequest({ method: 'POST', path: '/api/push/relay/subscribe', body: relayBody });

    const relayResponse = await fetch(`${pushServiceUrl}/api/push/relay/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...s2sHeaders },
      body: relayBody
    });

    const relayData = (await relayResponse.json().catch(() => null)) as
      | {
          token?: string;
          error?: string;
        }
      | null;

    if (!relayResponse.ok || !relayData?.token) {
      return res.status(502).json({
        success: false,
        error: relayData?.error || 'Failed to register relay subscription'
      });
    }

    relayToken = relayData.token;

    if (existing) {
      // Update existing subscription
      await pushSubscriptionRepository.updateSubscription(
        familyId,
        existing.push_id,
        subscription.keys.p256dh,
        subscription.keys.auth,
        delivery,
        relayToken,
        pushEncryptionPublicKey
      );
      await pushSubscriptionRepository.updateStatus(familyId, existing.push_id, 'active');

      return res.json({
        success: true,
        pushId: existing.push_id
      });
    }

    // Create new subscription
    const pushId = `push_${nanoid()}`;

    await pushSubscriptionRepository.create({
      familyId,
      pushId,
      deviceId: signer.deviceId,
      endpoint: subscription.endpoint,
      keysP256dh: subscription.keys.p256dh,
      keysAuth: subscription.keys.auth,
      deliveryMethod: delivery,
      relayToken,
      pushEncryptionPublicKey
    });

    res.json({
      success: true,
      pushId
    });
  } catch (error) {
    routeLogger.error('Error registering push subscription:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to register push subscription'
    });
  }
}, req => 'push:'+req.body.signerId+':'+(req.body.payload.endpoint || req.body.payload.subscription?.endpoint)));

/**
 * Unsubscribe from push notifications
 */
router.post('/unsubscribe', rlPushMutation, requirePushSignature, reliableOperation(async (req, res) => {
  try {
    const { familyId } = req as TenancyRequest;
    if (!familyId) {
      return res.status(500).json({
        success: false,
        error: 'Family context is missing'
      });
    }

    const signedRequest: SignedRequest<{
      endpoint: string;
    }, DeviceId> = req.body;

    // Validate request
    if (!signedRequest || !signedRequest.signerId || !signedRequest.payload?.endpoint) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request'
      });
    }

    const signer = (req as TenancyRequest & {pushSigner: Exclude<PushSignerResolution,{error:string}>}).pushSigner;

    const { endpoint } = signedRequest.payload;

    // Find and disable subscription
    const subscription = await pushSubscriptionRepository.findByDeviceAndEndpoint(
      familyId,
      signer.deviceId,
      endpoint
    );

    if (subscription) {
      await pushSubscriptionRepository.updateStatus(familyId, subscription.push_id, 'disabled');
    }

    res.json({
      success: true
    });
  } catch (error) {
    routeLogger.error('Error unsubscribing from push:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to unsubscribe'
    });
  }
}, req => 'push:'+req.body.signerId+':'+(req.body.payload.endpoint || req.body.payload.subscription?.endpoint)));

export default router;

// Delivery selection is intentionally removed: the family server always uses relay in the planned architecture.
