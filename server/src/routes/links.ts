import { routeLogger } from '../utils/routeLogger';
import crypto from 'crypto';
import { Router } from 'express';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import type { TenancyRequest } from '../middleware/tenancy';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { query } from '../db';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';
import type { LinkCapabilityDescriptor, LinkCapabilityProof } from '../../../shared/linkCapability';
import { verifyCapabilityProof } from '../services/linkCapabilityService';

const router = Router();
const linkRateLimits = getRateLimitRuntimeConfig().links;

const resolveLimiter = createRateLimiter({
  name: 'links:resolve',
  windowMs: linkRateLimits.windowMs,
  max: linkRateLimits.max,
  keyFn: ipFamilyKey
});

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function notFound(res: Parameters<Parameters<typeof router.post>[1]>[1]) {
  return res.status(404).json({
    status: 'error',
    error: { code: 'NOT_FOUND' as ErrorCode, message: 'Link not found or expired' }
  } as ApiResponse);
}

router.post('/resolve', resolveLimiter, async (req, res) => {
  try {
    const familyId = (req as TenancyRequest).familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const capabilityId = String(req.body?.capabilityId || '').trim();
    const capabilityProof = req.body?.proof as LinkCapabilityProof | undefined;
    if (capabilityId) {
      if (!/^cap_[A-Za-z0-9_-]{24}$/.test(capabilityId) || !capabilityProof) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Capability proof is required' }
        } as ApiResponse);
      }

      const result = await query<{
        link_type: 'call-link' | 'direct-link' | 'circle-invite';
        link_id: string;
        link_priority: number;
        capability_descriptor: LinkCapabilityDescriptor;
        issuer_public_key_algorithm: 'ed25519';
        issuer_public_key_value: string;
      }>(
        `SELECT 'circle-invite'::text AS link_type,
                invite.invite_id AS link_id,
                1::int AS link_priority,
                invite.capability_descriptor,
                issuer.public_key_algorithm AS issuer_public_key_algorithm,
                issuer.public_key_value AS issuer_public_key_value
         FROM invites invite
         JOIN identities issuer
           ON issuer.family_id = invite.family_id
          AND issuer.identity_id = invite.created_by
          AND issuer.status = 'active'
         WHERE invite.family_id = $1
           AND invite.capability_id = $2
           AND invite.status = 'active'
           AND invite.expires_at > NOW()
         UNION ALL
         SELECT 'direct-link'::text,
                link.link_id,
                2::int,
                link.capability_descriptor,
                issuer.public_key_algorithm,
                issuer.public_key_value
         FROM direct_guest_links link
         JOIN identities issuer
           ON issuer.family_id = link.family_id
          AND issuer.identity_id = link.created_by_identity_id
          AND issuer.status = 'active'
         WHERE link.family_id = $1
           AND link.capability_id = $2
           AND link.status = 'active'
           AND (link.expires_at IS NULL OR link.expires_at > NOW())
         UNION ALL
         SELECT 'call-link'::text,
                link.call_link_id,
                0::int,
                link.capability_descriptor,
                issuer.public_key_algorithm,
                issuer.public_key_value
         FROM call_links link
         JOIN identities issuer
           ON issuer.family_id = link.family_id
          AND issuer.identity_id = link.created_by
          AND issuer.status = 'active'
         WHERE link.family_id = $1
           AND link.capability_id = $2
           AND link.status = 'active'
           AND link.expires_at > NOW()
         ORDER BY link_priority
         LIMIT 1`,
        [familyId, capabilityId]
      );
      const row = result.rows[0];
      if (!row?.capability_descriptor) return notFound(res);
      if (!verifyCapabilityProof({
        proof: capabilityProof,
        descriptor: row.capability_descriptor,
        expectedAction: 'resolve'
      })) return notFound(res);
      return res.json({
        status: 'ok',
        result: {
          type: row.link_type,
          payload: {
            linkId: row.link_id,
            descriptor: row.capability_descriptor,
            issuerPublicKey: {
              algorithm: row.issuer_public_key_algorithm,
              value: row.issuer_public_key_value
            }
          }
        }
      } as ApiResponse);
    }

    const secret = String(req.body?.secret || '').trim();
    if (!secret || secret.length > 256) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Link secret is required' }
      } as ApiResponse);
    }
    const secretHash = sha256Hex(secret);

    const ownerClaim = await query<{ claim_id: string; join_invite_token: string | null }>(
      `SELECT claim.claim_id, invite.token AS join_invite_token
       FROM tenant_owner_claims claim
       LEFT JOIN family_config config ON config.family_id = claim.family_id
       LEFT JOIN invites invite
         ON invite.family_id = claim.family_id
        AND invite.invite_id = config.join_invite_id
        AND invite.status = 'active'
        AND invite.expires_at > NOW()
        AND invite.used_count < invite.max_uses
       WHERE claim.family_id = $1 AND claim.token_hash = $2
         AND claim.status = 'pending' AND claim.expires_at > NOW()
       LIMIT 1`,
      [familyId, secretHash]
    );
    if (ownerClaim.rows[0]) {
      return res.json({
        status: 'ok',
        result: {
          type: 'owner-claim',
          payload: {
            claimId: ownerClaim.rows[0].claim_id,
            token: ownerClaim.rows[0].join_invite_token
          }
        }
      } as ApiResponse);
    }

    const ownerRecoveryClaim = await query<{ claim_id: string }>(
      `SELECT claim_id
         FROM circle_owner_recovery_claims
        WHERE family_id = $1 AND token_hash = $2
          AND status = 'pending' AND expires_at > NOW()
        LIMIT 1`,
      [familyId, secretHash]
    );
    if (ownerRecoveryClaim.rows[0]) {
      return res.json({
        status: 'ok',
        result: {
          type: 'owner-recovery',
          payload: { claimId: ownerRecoveryClaim.rows[0].claim_id }
        }
      } as ApiResponse);
    }

    const enrollment = await query<{
      bootstrap_payload: unknown;
    }>(
      `SELECT bootstrap_payload
       FROM device_enrollments
       WHERE family_id = $1 AND bootstrap_commitment = $2
         AND state IN (
           'reserved',
           'pending_origin_check',
           'pending_trusted_read',
           'pending_trusted_approval',
           'approved',
           'consumed'
         )
         AND COALESCE(enrollment_expires_at, expires_at) > NOW()
       LIMIT 1`,
      [familyId, secret]
    );
    if (enrollment.rows[0]?.bootstrap_payload) {
      return res.json({
        status: 'ok',
        result: {
          type: 'device-enrollment',
          payload: enrollment.rows[0].bootstrap_payload
        }
      } as ApiResponse);
    }

    return notFound(res);
  } catch (error) {
    routeLogger.error('Resolve compact link error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

export default router;
