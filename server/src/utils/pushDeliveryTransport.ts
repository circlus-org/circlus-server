import { pushSubscriptionRepository } from '../db/repositories';
import { signPushServiceRequest } from './pushServiceS2S';
import type { MobileDeliveryClass, PushDeliveryUrgency, PushPayload } from './pushPayload';
import { getRequestLogger } from '../middleware/requestContext';

const RELAY_VAPID_CACHE_MS = 5 * 60 * 1000;
let relayVapidCache: { key: string; fetchedAt: number } | null = null;

type PushServiceHttpError = Error & {
  statusCode?: number;
  serviceError?: string;
};

function extractServiceError(responseBody: string): string | undefined {
  try {
    const parsed = responseBody ? JSON.parse(responseBody) : null;
    const error = typeof parsed?.error === 'string' ? parsed.error.trim() : '';
    // Central error codes/messages are useful for diagnostics. Keep logs bounded
    // and never copy an arbitrary response body into them.
    return error ? error.replace(/\s+/g, ' ').slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

function pushServiceHttpError(message: string, statusCode: number, responseBody: string): PushServiceHttpError {
  const error = new Error(message) as PushServiceHttpError;
  error.statusCode = statusCode;
  error.serviceError = extractServiceError(responseBody);
  return error;
}

async function pushServicePostJson<T>(url: string, body: any, pathForSignature: string): Promise<T> {
  const raw = JSON.stringify(body || {});
  const headers = signPushServiceRequest({ method: 'POST', path: pathForSignature, body: raw });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: raw
  });

  const text = await response.text().catch(() => '');
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw pushServiceHttpError(
      `Push-service request failed with status ${response.status}`,
      response.status,
      text
    );
  }

  return json as T;
}

export async function ensureRelayTokenForSubscription(params: {
  pushServiceUrl: string;
  familyId: string;
  pushId: string;
  pushEncryptionPublicKey: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
}): Promise<string> {
  const data = await pushServicePostJson<{ success?: boolean; token?: string; error?: string }>(
    `${params.pushServiceUrl}/api/push/relay/subscribe`,
    { subscription: params.subscription },
    '/api/push/relay/subscribe'
  );
  if (!data?.token) {
    throw new Error(data?.error || 'Push-service did not return a relay token');
  }

  await pushSubscriptionRepository.updateSubscription(
    params.familyId,
    params.pushId,
    params.subscription.keys.p256dh,
    params.subscription.keys.auth,
    'relay',
    data.token,
    params.pushEncryptionPublicKey
  );

  return data.token;
}

export type MobileCentralDeliveryParams = {
  pushServiceUrl: string;
  deliveryToken: string;
  payload: PushPayload;
  deliveryClass: MobileDeliveryClass;
  collapseId?: string;
  urgency?: PushDeliveryUrgency;
  ttlSec: number;
};

export function buildMobileCentralDeliveryBody(
  params: Omit<MobileCentralDeliveryParams, 'pushServiceUrl' | 'deliveryToken'>
): string {
  return JSON.stringify({
    contractVersion: 2,
    payload: params.payload,
    deliveryClass: params.deliveryClass,
    ...(params.collapseId ? { collapseId: params.collapseId } : {}),
    urgency: params.urgency,
    ttlSec: params.ttlSec
  });
}

export async function sendMobileNotificationViaCentral(
  params: MobileCentralDeliveryParams
): Promise<void> {
  const body = buildMobileCentralDeliveryBody(params);
  const s2sHeaders = signPushServiceRequest({ method: 'POST', path: '/api/mobile/deliver', body });
  const response = await fetch(`${params.pushServiceUrl}/api/mobile/deliver`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.deliveryToken}`,
      ...s2sHeaders
    },
    body
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw pushServiceHttpError(
      `Mobile central push failed with status ${response.status}`,
      response.status,
      text
    );
  }
}

export async function sendRelayNotification(params: {
  pushServiceUrl: string;
  token: string;
  payload: PushPayload;
  urgency?: PushDeliveryUrgency;
  ttlSec: number;
}): Promise<void> {
  const body = JSON.stringify({
    token: params.token,
    payload: params.payload,
    urgency: params.urgency,
    ttlSec: params.ttlSec
  });
  const s2sHeaders = signPushServiceRequest({ method: 'POST', path: '/api/push/relay/send', body });
  const response = await fetch(`${params.pushServiceUrl}/api/push/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...s2sHeaders },
    body
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw pushServiceHttpError(
      `Relay push failed with status ${response.status}`,
      response.status,
      text
    );
  }
}

export async function getRelayVapidPublicKey(pushServiceUrl: string): Promise<string | null> {
  if (relayVapidCache && Date.now() - relayVapidCache.fetchedAt < RELAY_VAPID_CACHE_MS) {
    return relayVapidCache.key;
  }

  try {
    const response = await fetch(`${pushServiceUrl}/api/push/vapid-key`);
    const data = (await response.json()) as {
      success?: boolean;
      publicKey?: string;
      error?: string;
    };

    if (!data?.success || !data.publicKey) {
      getRequestLogger({ subsystem: 'push_delivery_transport' }).error(
        'relay_vapid_key_response_invalid',
        { hasServiceError: Boolean(data?.error) }
      );
      return null;
    }

    relayVapidCache = { key: data.publicKey, fetchedAt: Date.now() };
    return data.publicKey as string;
  } catch (error: unknown) {
    getRequestLogger({ subsystem: 'push_delivery_transport' }).error(
      'relay_vapid_key_fetch_failed',
      { error }
    );
    return null;
  }
}
