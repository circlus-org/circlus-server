import crypto from 'node:crypto';
import { getIntegrationRuntimeConfig } from '../config/serverRuntimeConfig';

const CALL_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function deriveSubjectId(params: {
  prefix: 'cs1' | 'ms1';
  scope: 'circle' | 'media-session';
  parts: string[];
  sharedSecretBase64: string;
}): string {
  const secret = Buffer.from(params.sharedSecretBase64, 'base64');
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`circlus:${params.scope}:v1\0`)
    .update(params.parts.join('\0'))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
  return `${params.prefix}_${digest}`;
}

export function normalizeMediaCallSessionId(value: unknown): string | null {
  const callSessionId = String(value || '').trim();
  return CALL_SESSION_ID_PATTERN.test(callSessionId) ? callSessionId : null;
}

export function deriveIceSubjectIds(params: {
  familyId: string;
  purpose: 'bootstrap' | 'call' | 'file-transfer';
  callSessionId?: string;
  sharedSecretBase64?: string;
}): { circleSubjectId: string; mediaSessionId?: string } {
  const sharedSecretBase64 = params.sharedSecretBase64
    || getIntegrationRuntimeConfig().ice.subjectIdSecretBase64;
  if (!sharedSecretBase64) {
    throw new Error('ICE_SUBJECT_ID_SECRET or ICE_CONFIG_SHARED_SECRET is required to derive ICE subject ids');
  }

  const circleSubjectId = deriveSubjectId({
    prefix: 'cs1',
    scope: 'circle',
    parts: [params.familyId],
    sharedSecretBase64
  });

  if (!params.callSessionId) return { circleSubjectId };

  return {
    circleSubjectId,
    mediaSessionId: deriveSubjectId({
      prefix: 'ms1',
      scope: 'media-session',
      parts: [params.purpose, params.familyId, params.callSessionId],
      sharedSecretBase64
    })
  };
}
