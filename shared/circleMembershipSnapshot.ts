import type {
  CircleIdentityAdmissionProof,
  CircleMembershipStateClaim,
  CircleMembershipStatePayload,
  CircleMembershipStateRecord,
  IdentityId,
  PublicKey,
} from './types';
import { canonicalizeJson } from './signatureMessage';

/*
 * A membership snapshot is an owner-signed state in the chain that summarises
 * everything a verifier otherwise derives from the history before it, so the
 * history may be left out of transfers and device storage. Client and server
 * compute the expected content from the same history with this module and
 * accept a snapshot only if it is exactly equal.
 */

export const CIRCLE_MEMBERSHIP_SNAPSHOT_VERSION = 1 as const;

export interface CircleMembershipSnapshotInviteUse {
  capabilityId: string;
  mode: 'single-use' | 'unlimited';
  descriptorSignature: string;
  claimIds: string[];
  expiresAt: string;
}

export interface CircleMembershipSnapshot {
  version: typeof CIRCLE_MEMBERSHIP_SNAPSHOT_VERSION;
  /** Identity without an admission at the top of the admission tree: the Circle's creator. */
  admissionRootIdentityId: IdentityId;
  /** Identities that were ever members and are not now; they may return only through `restore`. */
  formerIdentityIds: IdentityId[];
  /** Uses of invitations still valid at `issuedAt`; expired ones cannot be used again after it. */
  inviteUses: CircleMembershipSnapshotInviteUse[];
  /** Admissions of current members and of every issuer up to the root. */
  admissionProofs: CircleIdentityAdmissionProof[];
  /**
   * Signed `transfer_owner` claims of this chain (same `vpsId + circleId`), in
   * sequence order: a device whose checkpoint is older than the snapshot
   * follows them from the owner it saw to the owner who signed the snapshot.
   */
  ownerTransfers: CircleMembershipStateClaim[];
}

/**
 * Every state in order, including the chains embedded as a genesis
 * `predecessor` after server moves. Each chain is sorted by its own sequence.
 */
export function flattenCircleMembershipHistory(states: CircleMembershipStateRecord[]): CircleMembershipStateRecord[] {
  const sorted = [...states].sort((left, right) => left.claim.payload.sequence - right.claim.payload.sequence);
  const predecessor = sorted[0]?.claim.payload.action === 'genesis' ? sorted[0].claim.payload.predecessor : undefined;
  return Array.isArray(predecessor?.states) ? [...flattenCircleMembershipHistory(predecessor.states), ...sorted] : sorted;
}

function inviteUseOf(record: CircleMembershipStateRecord): CircleMembershipSnapshotInviteUse | null {
  const admission = record.admission;
  if (record.claim.payload.action !== 'add' || admission?.kind !== 'circle_invite') return null;
  const descriptor = admission.descriptor;
  const claimId = String(admission.claim?.capabilityProof?.payload?.claimId || '').trim();
  if (!claimId || !admission.capabilityId) return null;
  return {
    capabilityId: admission.capabilityId,
    mode: descriptor.payload.kind === 'call-link' ? 'single-use' : descriptor.payload.mode as 'single-use' | 'unlimited',
    descriptorSignature: descriptor.signature,
    claimIds: [claimId],
    expiresAt: descriptor.payload.expiresAt,
  };
}

/**
 * The snapshot an owner must sign right after `history`, whose last state is
 * the head the snapshot follows. `history` starts at a genesis or at an
 * earlier snapshot, as `flattenCircleMembershipHistory` returns it.
 */
export function computeCircleMembershipSnapshot(
  history: CircleMembershipStateRecord[],
  issuedAt: string
): CircleMembershipSnapshot {
  const head = history[history.length - 1]?.claim.payload;
  if (!head) throw new Error('A membership snapshot needs a history');
  let baseIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]!.claim.payload.action === 'snapshot') {
      baseIndex = index;
      break;
    }
  }
  const base = baseIndex >= 0 ? history[baseIndex]!.claim.payload.snapshot : undefined;
  const root = base?.admissionRootIdentityId
    ?? history.find((state) => state.claim.payload.action === 'genesis')?.claim.payload.ownerIdentityId
    ?? head.ownerIdentityId;

  const seen = new Set<IdentityId>(base?.formerIdentityIds || []);
  const keys = new Map<IdentityId, PublicKey>();
  const admissions = new Map<IdentityId, CircleIdentityAdmissionProof['admission']>();
  const uses = new Map<string, CircleMembershipSnapshotInviteUse>();
  for (const proof of base?.admissionProofs || []) {
    keys.set(proof.identityId, proof.publicKey);
    admissions.set(proof.identityId, proof.admission);
  }
  for (const use of base?.inviteUses || []) uses.set(use.capabilityId, { ...use, claimIds: [...use.claimIds] });
  const sameChain = (payload: CircleMembershipStatePayload) => (
    payload.vpsId === head.vpsId && payload.circleId === head.circleId
  );
  const transfers = new Map<string, CircleMembershipStateClaim>();
  for (const claim of base?.ownerTransfers || []) {
    if (sameChain(claim.payload)) transfers.set(claim.payload.stateId, claim);
  }

  for (const record of history.slice(Math.max(baseIndex, 0))) {
    const payload: CircleMembershipStatePayload = record.claim.payload;
    for (const member of payload.members) {
      seen.add(member.identityId);
      keys.set(member.identityId, member.publicKey);
    }
    if (payload.action === 'add' && payload.subjectIdentityId && record.admission) {
      admissions.set(payload.subjectIdentityId, record.admission);
    }
    if (payload.action === 'transfer_owner' && sameChain(payload)) transfers.set(payload.stateId, record.claim);
    const use = inviteUseOf(record);
    if (use) {
      const known = uses.get(use.capabilityId);
      if (known) known.claimIds = [...new Set([...known.claimIds, ...use.claimIds])];
      else uses.set(use.capabilityId, use);
    }
  }

  const current = new Map(head.members.map((member) => [member.identityId, member]));
  const proofs = new Map<IdentityId, CircleIdentityAdmissionProof>();
  const pending = [...current.keys()];
  while (pending.length > 0) {
    const identityId = pending.pop()!;
    if (proofs.has(identityId)) continue;
    const publicKey = keys.get(identityId);
    if (!publicKey) continue;
    const admission = identityId === root ? null : admissions.get(identityId) ?? null;
    const member = current.get(identityId);
    proofs.set(identityId, {
      identityId,
      publicKey,
      role: member?.role ?? 'member',
      status: member ? 'active' : 'removed',
      admission,
    });
    if (admission) pending.push(admission.issuerIdentityId);
  }

  const issuedAtMs = Date.parse(issuedAt);
  return {
    version: CIRCLE_MEMBERSHIP_SNAPSHOT_VERSION,
    admissionRootIdentityId: root,
    formerIdentityIds: [...seen].filter((identityId) => !current.has(identityId)).sort(),
    inviteUses: [...uses.values()]
      .filter((use) => Date.parse(use.expiresAt) > issuedAtMs)
      .map((use) => ({ ...use, claimIds: [...use.claimIds].sort() }))
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
    admissionProofs: [...proofs.values()].sort((left, right) => left.identityId.localeCompare(right.identityId)),
    ownerTransfers: [...transfers.values()].sort((left, right) => left.payload.sequence - right.payload.sequence),
  };
}

export function sameCircleMembershipSnapshot(left: unknown, right: CircleMembershipSnapshot): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

/** Issue time of the latest snapshot before `index`, or null; later invite admissions must not be expired by then. */
export function latestSnapshotIssuedAt(history: CircleMembershipStateRecord[], index = history.length): string | null {
  for (let position = Math.min(index, history.length) - 1; position >= 0; position -= 1) {
    const payload = history[position]!.claim.payload;
    if (payload.action === 'snapshot') return payload.issuedAt;
  }
  return null;
}
