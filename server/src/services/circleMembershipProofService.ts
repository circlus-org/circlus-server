import type { CircleIdentityAdmissionProof, PublicKey } from '@shared/types';
import type {
  CircleInviteAcceptance,
  DirectGuestAcceptance,
  LinkCapabilityDescriptor,
  LinkCapabilityProof,
} from '@shared/linkCapability';
import { pool } from '../db';

type AdmissionRow = {
  identity_id: string;
  public_key_algorithm: 'ed25519' | 'x25519';
  public_key_value: string;
  role: 'owner' | 'member' | 'guest' | null;
  status: 'active' | 'disabled' | 'removed';
  admission_capability_id: string | null;
  invite_capability_id: string | null;
  invite_descriptor: LinkCapabilityDescriptor | null;
  invite_issuer_identity_id: string | null;
  invite_issuer_key_algorithm: 'ed25519' | 'x25519' | null;
  invite_issuer_key_value: string | null;
  invite_admission_claim: unknown;
  guest_capability_id: string | null;
  guest_link_id: string | null;
  guest_descriptor: LinkCapabilityDescriptor | null;
  guest_issuer_identity_id: string | null;
  guest_issuer_key_algorithm: 'ed25519' | 'x25519' | null;
  guest_issuer_key_value: string | null;
  guest_admission_claim: unknown;
};

function publicKey(algorithm: string | null, value: string | null): PublicKey | null {
  if ((algorithm !== 'ed25519' && algorithm !== 'x25519') || !value) return null;
  return { algorithm, value };
}

/**
 * Returns the evidence graph, not a server assertion that it is valid. Clients
 * deliberately verify the complete path from their own identity before using
 * any row for membership or key distribution.
 */
export async function listCircleIdentityAdmissionProofs(
  familyId: string,
  options: { includeDirectGuests?: boolean; directGuestIdentityIds?: string[] } = {}
): Promise<CircleIdentityAdmissionProof[]> {
  const directGuestIdentityIds = new Set(options.directGuestIdentityIds || []);
  const result = await pool.query<AdmissionRow>(
    `SELECT identity.identity_id,
            identity.public_key_algorithm,
            identity.public_key_value,
            identity.role,
            identity.status,
            identity.admission_capability_id,
            invite.capability_id AS invite_capability_id,
            invite.capability_descriptor AS invite_descriptor,
            invite.created_by AS invite_issuer_identity_id,
            invite_issuer.public_key_algorithm AS invite_issuer_key_algorithm,
            invite_issuer.public_key_value AS invite_issuer_key_value,
            invite_acceptance.admission_claim AS invite_admission_claim,
            guest_registration.capability_id AS guest_capability_id,
            guest_registration.link_id AS guest_link_id,
            guest_link.capability_descriptor AS guest_descriptor,
            guest_link.host_identity_id AS guest_issuer_identity_id,
            guest_issuer.public_key_algorithm AS guest_issuer_key_algorithm,
            guest_issuer.public_key_value AS guest_issuer_key_value,
            guest_registration.admission_claim AS guest_admission_claim
       FROM identities identity
       LEFT JOIN invites invite
         ON invite.family_id = identity.family_id
        AND invite.capability_id = identity.admission_capability_id
       LEFT JOIN invite_acceptances invite_acceptance
         ON invite_acceptance.family_id = identity.family_id
        AND invite_acceptance.capability_id = identity.admission_capability_id
        AND invite_acceptance.accepted_by_identity_id = identity.identity_id
       LEFT JOIN identities invite_issuer
         ON invite_issuer.family_id = invite.family_id
        AND invite_issuer.identity_id = invite.created_by
       LEFT JOIN LATERAL (
         SELECT registration.*
           FROM direct_guest_registrations registration
          WHERE registration.family_id = identity.family_id
            AND registration.guest_identity_id = identity.identity_id
            AND registration.capability_id IS NOT NULL
            AND registration.admission_claim IS NOT NULL
          ORDER BY registration.created_at ASC
          LIMIT 1
       ) guest_registration ON TRUE
       LEFT JOIN direct_guest_links guest_link
         ON guest_link.family_id = guest_registration.family_id
        AND guest_link.link_id = guest_registration.link_id
       LEFT JOIN identities guest_issuer
         ON guest_issuer.family_id = guest_link.family_id
        AND guest_issuer.identity_id = guest_link.host_identity_id
      WHERE identity.family_id = $1
      ORDER BY identity.created_at ASC, identity.identity_id ASC`,
    [familyId]
  );

  return result.rows
    .filter((row) => (
      row.role !== 'guest'
      || (
        options.includeDirectGuests === true
        && (directGuestIdentityIds.size === 0 || directGuestIdentityIds.has(row.identity_id))
      )
    ))
    .map((row) => {
    const identityPublicKey = publicKey(row.public_key_algorithm, row.public_key_value)!;
    const inviteIssuerPublicKey = publicKey(row.invite_issuer_key_algorithm, row.invite_issuer_key_value);
    const guestIssuerPublicKey = publicKey(row.guest_issuer_key_algorithm, row.guest_issuer_key_value);
    let admission: CircleIdentityAdmissionProof['admission'] = null;
    if (
      row.admission_capability_id
      && row.invite_capability_id === row.admission_capability_id
      && row.invite_descriptor
      && row.invite_issuer_identity_id
      && inviteIssuerPublicKey
      && row.invite_admission_claim
    ) {
      admission = {
        kind: 'circle_invite',
        capabilityId: row.invite_capability_id,
        descriptor: row.invite_descriptor,
        issuerIdentityId: row.invite_issuer_identity_id,
        issuerPublicKey: inviteIssuerPublicKey,
        claim: row.invite_admission_claim as {
          capabilityProof: LinkCapabilityProof;
          subjectAcceptance: CircleInviteAcceptance;
        },
      };
    } else if (
      row.guest_capability_id
      && row.guest_link_id
      && row.guest_descriptor
      && row.guest_issuer_identity_id
      && guestIssuerPublicKey
      && row.guest_admission_claim
    ) {
      admission = {
        kind: 'direct_guest',
        capabilityId: row.guest_capability_id,
        linkId: row.guest_link_id,
        descriptor: row.guest_descriptor,
        issuerIdentityId: row.guest_issuer_identity_id,
        issuerPublicKey: guestIssuerPublicKey,
        claim: row.guest_admission_claim as {
          capabilityProof: LinkCapabilityProof;
          subjectAcceptance: DirectGuestAcceptance;
        },
      };
    }
    return {
      identityId: row.identity_id,
      publicKey: identityPublicKey,
      role: row.role || 'member',
      status: row.status,
      admission,
    };
  });
}
