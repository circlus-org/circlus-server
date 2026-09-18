export type IdentityAuthorizationFacts = {
  status?: string | null;
  role?: string | null;
  canCreateCircleInvites?: boolean;
  canCreateGuestInvites?: boolean;
};

export type IdentityAuthorization = Readonly<{
  active: boolean;
  owner: boolean;
  fullCircleMember: boolean;
  manageCircle: boolean;
  createCircleInvites: boolean;
  createGuestInvites: boolean;
  manageOwnGuestLinks: boolean;
}>;

/** Central role/capability projection. Resource ownership and proofs stay separate. */
export function resolveIdentityAuthorization(facts: IdentityAuthorizationFacts): IdentityAuthorization {
  const active = facts.status === 'active';
  const owner = active && facts.role === 'owner';
  const fullCircleMember = active && (owner || facts.role === 'member');
  return Object.freeze({
    active,
    owner,
    fullCircleMember,
    manageCircle: owner,
    createCircleInvites: owner || (fullCircleMember && facts.canCreateCircleInvites === true),
    createGuestInvites: owner || (active && facts.canCreateGuestInvites === true),
    manageOwnGuestLinks: active && (facts.role === 'owner' || facts.role === 'member' || facts.role === 'guest')
  });
}
