import type { IdentityId, PublicKey, SignedRequest } from './types';

export const LINK_CAPABILITY_VERSION = 2 as const;
export const LINK_CAPABILITY_SECRET_PREFIX = 'cap2';

export type LinkCapabilityKind = 'circle-invite' | 'direct-guest' | 'call-link';
export type LinkCapabilityMode = 'single-use' | 'unlimited';

export type LinkCapabilityDescriptorPayload = {
  version: typeof LINK_CAPABILITY_VERSION;
  purpose: 'circlus-link-capability-v2';
  capabilityId: string;
  kind: LinkCapabilityKind;
  mode: LinkCapabilityMode;
  issuerIdentityId: IdentityId;
  targetIdentityId: IdentityId;
  capabilityPublicKey: PublicKey;
  issuedAt: string;
  expiresAt: string;
  scope: Record<string, unknown>;
};

export type LinkCapabilityDescriptor = SignedRequest<LinkCapabilityDescriptorPayload, IdentityId>;

export type LinkCapabilityProofAction =
  | 'resolve'
  | 'circle-invite:claim'
  | 'direct-guest:claim'
  | 'direct-guest:subscribe'
  | 'call-link:register'
  | 'call-link:call';

export type LinkCapabilityProofPayload = {
  version: typeof LINK_CAPABILITY_VERSION;
  purpose: 'circlus-link-capability-proof-v2';
  capabilityId: string;
  action: LinkCapabilityProofAction;
  targetIdentityId: IdentityId;
  subjectIdentityId?: IdentityId;
  subjectPublicKey?: PublicKey;
  claimId?: string;
  context?: Record<string, unknown>;
};

export type LinkCapabilityProof = SignedRequest<LinkCapabilityProofPayload, string>;

export type LinkCapabilityRevocationPayload = {
  version: typeof LINK_CAPABILITY_VERSION;
  purpose: 'circlus-link-capability-revocation-v2';
  capabilityId: string;
  issuerIdentityId: IdentityId;
  revokedAt: string;
};

export type LinkCapabilityRevocation = SignedRequest<LinkCapabilityRevocationPayload, IdentityId>;

export type CircleInviteAcceptancePayload = {
  version: typeof LINK_CAPABILITY_VERSION;
  purpose: 'circlus-circle-invite-acceptance-v2';
  capabilityId: string;
  claimId: string;
  identityPublicKey: PublicKey;
  capabilityProof: LinkCapabilityProof;
};

export type CircleInviteAcceptance = SignedRequest<CircleInviteAcceptancePayload, IdentityId>;

export type DirectGuestAcceptancePayload = {
  version: typeof LINK_CAPABILITY_VERSION;
  purpose: 'circlus-direct-guest-acceptance-v2';
  /** Signed profile encrypted for the inviting identity; never a public guest name. */
  encryptedGuestProfile?: string;
  capabilityId: string;
  claimId: string;
  identityPublicKey: PublicKey;
  capabilityProof: LinkCapabilityProof;
};

export type DirectGuestAcceptance = SignedRequest<DirectGuestAcceptancePayload, IdentityId>;
