import { query } from '../db';
import type { LinkCapabilityDescriptor, LinkCapabilityProof, LinkCapabilityProofAction } from '../../../shared/linkCapability';
import type { PublicKey } from '../../../shared/types';
import { verifyCapabilityProof } from './linkCapabilityService';

export type CallLinkGrantResult = {
  ok: boolean;
  reason?: 'not_found' | 'expired' | 'invalid_secret' | 'target_mismatch' | 'inactive';
  descriptor?: LinkCapabilityDescriptor;
  proof?: LinkCapabilityProof;
};

export type WhitelistGrantResult = {
  ok: boolean;
  reason?: 'not_found' | 'inactive' | 'public_key_mismatch';
};

export async function verifyCallLinkGrant(input: {
  familyId: string;
  callLinkId: string;
  capabilityId: string;
  capabilityProof: LinkCapabilityProof;
  externalIdentityId: string;
  externalPublicKey: PublicKey;
  targetIdentityId: string;
}): Promise<CallLinkGrantResult> {
  return verifyCallLinkActionGrant({
    ...input,
    expectedAction: 'call-link:register',
    touchUsage: true
  });
}

export async function verifyCallLinkActionGrant(input: {
  familyId: string;
  callLinkId: string;
  capabilityId: string;
  capabilityProof: LinkCapabilityProof;
  externalIdentityId: string;
  externalPublicKey: PublicKey;
  targetIdentityId: string;
  expectedAction: LinkCapabilityProofAction;
  touchUsage?: boolean;
}): Promise<CallLinkGrantResult> {
  const { familyId, callLinkId, capabilityId, capabilityProof, targetIdentityId } = input;

  const result = await query<{
    call_link_id: string;
    target_identity_id: string;
    secret_hash: string;
    status: string;
    expires_at: Date;
    capability_id: string | null;
    capability_mode: 'single-use' | 'unlimited' | null;
    capability_descriptor: LinkCapabilityDescriptor | null;
    last_used_at: Date | null;
    claimed_by_identity_id: string | null;
    claimed_by_public_key_algorithm: string | null;
    claimed_by_public_key_value: string | null;
  }>(
    `SELECT call_link_id, target_identity_id, secret_hash, status, expires_at,
            capability_id, capability_mode, capability_descriptor, last_used_at,
            claimed_by_identity_id, claimed_by_public_key_algorithm, claimed_by_public_key_value
     FROM call_links
     WHERE family_id = $1 AND call_link_id = $2
     LIMIT 1`,
    [familyId, callLinkId]
  );

  const row = result.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'active') return { ok: false, reason: 'inactive' };
  if (String(row.target_identity_id) !== String(targetIdentityId)) {
    return { ok: false, reason: 'target_mismatch' };
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query(
      `UPDATE call_links
       SET status = 'expired'
       WHERE family_id = $1 AND call_link_id = $2`,
      [familyId, callLinkId]
    );
    return { ok: false, reason: 'expired' };
  }

  if (
    !row.capability_descriptor
    || row.capability_id !== capabilityId
    || !verifyCapabilityProof({
      proof: capabilityProof,
      descriptor: row.capability_descriptor,
      expectedAction: input.expectedAction,
      expectedSubjectIdentityId: input.externalIdentityId,
      expectedSubjectPublicKey: input.externalPublicKey
    })
  ) {
    return { ok: false, reason: 'invalid_secret' };
  }
  if (!input.touchUsage) {
    if (
      row.capability_mode === 'single-use'
      && row.last_used_at
      && (
        row.claimed_by_identity_id !== input.externalIdentityId
        || row.claimed_by_public_key_algorithm !== input.externalPublicKey.algorithm
        || row.claimed_by_public_key_value !== input.externalPublicKey.value
      )
    ) {
      return { ok: false, reason: 'inactive' };
    }
    return {
      ok: true,
      descriptor: row.capability_descriptor,
      proof: capabilityProof
    };
  }

  const touched = await query(
    `UPDATE call_links
     SET last_used_at = NOW(),
         claimed_by_identity_id = CASE
           WHEN capability_mode = 'single-use' THEN COALESCE(claimed_by_identity_id, $3)
           ELSE claimed_by_identity_id
         END,
         claimed_by_public_key_algorithm = CASE
           WHEN capability_mode = 'single-use' THEN COALESCE(claimed_by_public_key_algorithm, $4)
           ELSE claimed_by_public_key_algorithm
         END,
         claimed_by_public_key_value = CASE
           WHEN capability_mode = 'single-use' THEN COALESCE(claimed_by_public_key_value, $5)
           ELSE claimed_by_public_key_value
         END
     WHERE family_id = $1 AND call_link_id = $2
       AND (
         capability_mode <> 'single-use'
         OR last_used_at IS NULL
         OR (
           claimed_by_identity_id = $3
           AND claimed_by_public_key_algorithm = $4
           AND claimed_by_public_key_value = $5
         )
       )
     RETURNING call_link_id`,
    [
      familyId,
      callLinkId,
      input.externalIdentityId,
      input.externalPublicKey.algorithm,
      input.externalPublicKey.value
    ]
  );
  if ((touched.rowCount || 0) === 0) return { ok: false, reason: 'inactive' };

  return { ok: true, descriptor: row.capability_descriptor, proof: capabilityProof };
}

export async function verifyWhitelistGrant(input: {
  familyId: string;
  targetIdentityId: string;
  externalIdentityId: string;
  externalPublicKey: {
    algorithm: 'ed25519' | 'x25519';
    value: string;
  };
}): Promise<WhitelistGrantResult> {
  const { familyId, targetIdentityId, externalIdentityId, externalPublicKey } = input;

  const result = await query<{
    status: 'active' | 'revoked';
    external_public_key_algorithm: 'ed25519' | 'x25519';
    external_public_key_value: string;
  }>(
    `SELECT status, external_public_key_algorithm, external_public_key_value
     FROM call_whitelist_entries
     WHERE family_id = $1
       AND owner_identity_id = $2
       AND external_identity_id = $3
     LIMIT 1`,
    [familyId, targetIdentityId, externalIdentityId]
  );

  const row = result.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'active') return { ok: false, reason: 'inactive' };
  if (
    row.external_public_key_algorithm !== externalPublicKey.algorithm ||
    row.external_public_key_value !== externalPublicKey.value
  ) {
    return { ok: false, reason: 'public_key_mismatch' };
  }

  return { ok: true };
}

export async function verifyExternalAdmission(input:
  | {
      kind: 'call_link';
      familyId: string;
      targetIdentityId: string;
      callLinkId: string;
      capabilityId: string;
      capabilityProof: LinkCapabilityProof;
      externalIdentityId: string;
      externalPublicKey: PublicKey;
    }
  | {
      kind: 'whitelist_key';
      familyId: string;
      targetIdentityId: string;
      externalIdentityId: string;
      externalPublicKey: {
        algorithm: 'ed25519' | 'x25519';
        value: string;
      };
    }
): Promise<{ ok: boolean; reason?: string }> {
  if (input.kind === 'call_link') {
    const result = await verifyCallLinkGrant(input);
    return result;
  }
  const result = await verifyWhitelistGrant(input);
  return { ok: result.ok, reason: result.reason };
}
