// Shared types between client and server
// Based on spec/section-12-types.ts

export type ISODateString = string;
export type Base64String = string;
export type HexString = string;
export type Nonce = string;
export type Signature = string;

export type IdentityId = string;
export type DeviceId = string;
export type SignerId = DeviceId | IdentityId;
export type InviteId = string;
export type CallId = string;
export type ServerOrigin = string;
export type VpsId = string;
export type CircleId = string;
export type PushId = string;

/* =========================
   Cryptography
========================= */

export interface PublicKey {
  algorithm: 'ed25519' | 'x25519';
  value: Base64String;
}

export interface EncryptedBlob {
  cipher: 'aes-256-gcm';
  data: Base64String;
  nonce: Base64String;
  version: number;
}

/* =========================
   Identity
========================= */

export interface IdentityRecord {
  identityId: IdentityId;
  publicKey: PublicKey;
  encryptedPrivateKey: EncryptedBlob | null;
  createdAt: ISODateString;
  status: 'active' | 'disabled' | 'removed';
  role?: 'owner' | 'member' | 'guest';
}

/* =========================
   Device
========================= */

export interface DeviceRecord {
  deviceId: DeviceId;
  identityId: IdentityId;
  /** Ed25519 key used only to authenticate device-signed requests. */
  publicKey: PublicKey;
  /** X25519 key used only for encrypting payloads to this device. */
  encryptionPublicKey?: PublicKey | null;
  registrationAttestation?: DeviceRegistrationAttestation | null;
  label?: string | null;
  webOrigin?: string | null;
  encryptedPhysicalDeviceId?: EncryptedBlob | null;
  createdAt: ISODateString;
  lastSeenAt?: ISODateString;
  status: 'active' | 'revoked';
  accessLevel?: 'trusted' | 'temporary';
  expiresAt?: ISODateString | null;
}

export type DeviceLifecyclePolicy = {
  reviewAfterDays: number;
  autoRevokeEnabled: boolean;
  autoRevokeAfterDays: number;
  warningDays: number;
  updatedAt: ISODateString;
};

export type DeviceInactivityState = {
  inactiveDays: number;
  reviewRecommended: boolean;
  autoRevokeAt: ISODateString | null;
  protectedAsLastDevice: boolean;
};

export type InactiveDeviceReviewItem = DeviceInactivityState & {
  deviceId: DeviceId;
  identityId: IdentityId;
  identityName: string | null;
  label: string | null;
  webOrigin: string | null;
  createdAt: ISODateString;
  lastSeenAt: ISODateString | null;
  activeDeviceCount: number;
};

export type InactiveDeviceReviewResult = {
  policy: DeviceLifecyclePolicy;
  devices: InactiveDeviceReviewItem[];
  unreachableProfiles: Array<{
    identityId: IdentityId;
    identityName: string | null;
    role: 'owner' | 'member';
    lastDeviceActivityAt: ISODateString | null;
  }>;
};

export interface DeviceKeyBindingPayload {
  version: 1;
  purpose: 'device-key-binding-v1';
  identityId: IdentityId;
  devicePublicKey: PublicKey;
  deviceEncryptionPublicKey: PublicKey;
}

export interface DeviceRegistrationAttestation {
  version: 1;
  identitySignedRequest: SignedRequest<RegisterDevicePayload, IdentityId>;
  deviceKeyBinding: SignedRequest<DeviceKeyBindingPayload, string>;
}

export type TemporaryIdentityDelegationCapability = 'messages' | 'calls';

export interface TemporaryIdentityDelegationPayload {
  version: 1;
  purpose: 'temporary-identity-delegation-v1';
  identityId: IdentityId;
  identityPublicKey: PublicKey;
  temporaryDeviceId: DeviceId;
  temporaryDevicePublicKey: PublicKey;
  capabilities: TemporaryIdentityDelegationCapability[];
  scope: {
    serverOrigin: string;
    groupChatIds?: string[];
    directChatIds?: string[];
  };
  issuedAt: ISODateString;
  notBefore: ISODateString;
  expiresAt: ISODateString;
  issuerDeviceId: DeviceId;
  delegationId: string;
}

export type TemporaryIdentityDelegationCredential = SignedRequest<
  TemporaryIdentityDelegationPayload,
  IdentityId
>;

export interface DeviceLocalCircleDataDeletionAuthorizationPayload {
  version: 1;
  purpose: 'device-local-circle-data-deletion-after-revoke-v1';
  identityId: IdentityId;
  targetDeviceId: DeviceId;
}

export type DeviceLocalCircleDataDeletionAuthorization = SignedRequest<
  DeviceLocalCircleDataDeletionAuthorizationPayload,
  IdentityId
>;

export interface RevokeDevicePayload {
  deviceId: DeviceId;
  deleteLocalCircleData?: boolean;
  localDeletionAuthorization?: DeviceLocalCircleDataDeletionAuthorization;
}

export type GroupEpochTransitionReason =
  | 'initial'
  | 'participant_removed'
  | 'participant_left'
  | 'device_revoked'
  | 'rekey';

export type DirectEpochTransitionReason =
  | 'initial'
  | 'device_revoked'
  | 'rekey';

export interface GroupEpochTransitionPayload {
  version: 1;
  purpose: 'group-epoch-transition-v1';
  chatId: string;
  epoch: number;
  previousEpoch: number | null;
  keyCommitment: string;
  proposerIdentityId: IdentityId;
  proposerDeviceId: DeviceId;
  reason: GroupEpochTransitionReason;
}

export type GroupEpochTransitionClaim = SignedRequest<GroupEpochTransitionPayload, DeviceId>;

export type GroupStateTransitionAction =
  | 'create'
  | 'add_participants'
  | 'remove_participants'
  | 'transfer_owner'
  | 'rekey'
  | 'rename';

/** Complete owner-authorized state, independently verifiable by every client. */
export interface GroupStateTransitionPayload {
  version: 2;
  purpose: 'group-state-transition-v2';
  chatId: string;
  transitionId: string;
  previousTransitionId: string | null;
  sequence: number;
  action: GroupStateTransitionAction;
  ownerIdentityId: IdentityId;
  participantIdentityIds: IdentityId[];
  epoch: number;
  keyCommitment: string;
  titleCiphertext: string;
}

export type GroupStateTransitionClaim = SignedRequest<GroupStateTransitionPayload, IdentityId>;

/** Irrevocable authorization by one participant to remove only their current
 * membership incarnation from a group. The owner device completes it with an
 * owner-signed state transition and a new epoch. */
export interface GroupLeaveRequestPayload {
  version: 1;
  purpose: 'group-leave-request-v1';
  chatId: string;
  requestId: string;
  participantIdentityId: IdentityId;
  membershipTransitionId: string;
  observedTransitionId: string;
  requestedAt: number;
}

export type GroupLeaveRequestClaim = SignedRequest<GroupLeaveRequestPayload, IdentityId>;

export type GroupMessageAuthorAction = 'create' | 'edit' | 'delete';

export interface GroupMessageAuthorPayload {
  version: 1;
  purpose: 'group-message-author-v1';
  action: GroupMessageAuthorAction;
  chatId: string;
  senderIdentityId: IdentityId;
  clientMessageId: string;
  clientCreatedAt: number;
  /** Time of the foreground user action that created this message. Persisted
   * across outbox retries so a delayed retry cannot fabricate a new online. */
  foregroundActivityAt?: number;
  epoch: number;
  revision: number;
  ciphertext: string;
}

export type GroupMessageAuthorClaim = SignedRequest<GroupMessageAuthorPayload, IdentityId>;

export type DirectMessageAuthorAction = 'create' | 'edit' | 'delete';

/** Identity-authorized immutable description of one direct-message revision. */
export interface DirectMessageAuthorPayload {
  version: 1;
  purpose: 'direct-message-author-v1';
  action: DirectMessageAuthorAction;
  directChatId: string;
  senderIdentityId: IdentityId;
  recipientIdentityId: IdentityId;
  clientMessageId: string;
  clientCreatedAt: number | null;
  /** Time of the foreground user action that created this message. */
  foregroundActivityAt?: number;
  epoch: number;
  revision: number;
  ciphertext: string;
  senderCiphertext: string | null;
  senderSignature: string;
}

export type DirectMessageAuthorClaim = SignedRequest<DirectMessageAuthorPayload, IdentityId>;

export interface MessageRevisionTrustRecord {
  version: 1;
  conversationKind: 'direct' | 'group';
  conversationId: string;
  senderIdentityId: IdentityId;
  clientMessageId: string;
  revision: number;
  action: GroupMessageAuthorAction;
  claimSignature: string;
  conflicted?: boolean;
}

export interface GroupChatTrustCheckpoint {
  sequence: number;
  transitionId: string;
}

/** A locally accepted owner signature that first admitted this identity to a group. */
export interface GroupChatTrustBootstrap {
  transitionId: string;
  sequence: number;
  signerIdentityId: IdentityId;
  signerPublicKey: PublicKey;
  acceptedAt: ISODateString;
}

export interface GroupChatTrustRecord {
  checkpoints: GroupChatTrustCheckpoint[];
  bootstraps?: GroupChatTrustBootstrap[];
}

export interface DirectEpochTransitionPayload {
  version: 1;
  purpose: 'direct-epoch-transition-v1';
  directChatId: string;
  participantIdentityIds: [IdentityId, IdentityId];
  epoch: number;
  previousEpoch: number | null;
  keyCommitment: string;
  proposerIdentityId: IdentityId;
  proposerDeviceId: DeviceId;
  reason: DirectEpochTransitionReason;
}

export type DirectEpochTransitionClaim = SignedRequest<DirectEpochTransitionPayload, DeviceId>;

export interface TemporaryMembershipRecord {
  enrollmentId: string;
  vpsId: VpsId;
  circleId: CircleId;
  identityId: IdentityId;
  deviceId: DeviceId;
  serverOrigin: string;
  /** Ed25519 key used only to authenticate temporary-device requests. */
  publicKey: PublicKey;
  /** X25519 key used only for encrypting payloads to this temporary device. */
  encryptionPublicKey?: PublicKey | null;
  cachedContacts?: TemporaryContactRecord[];
  accessibleGroupChatIds?: string[];
  accessibleDirectChatIds?: string[];
  temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
  approvedByDeviceId: DeviceId;
  createdAt: ISODateString;
  grantedAt: ISODateString;
  expiresAt: ISODateString;
  accessLevel: 'temporary';
}

export interface TemporaryContactIdentity {
  /** VPS namespace for circleId. Absent only while hydrating pre-CircleKey local data. */
  vpsId?: VpsId;
  circleId: CircleId;
  identityId: IdentityId;
  serverOrigin?: string;
  identityPublicKey: PublicKey;
  serverIdentityName?: string;
}

export interface TemporaryContactRecord {
  contactId: string;
  displayName: string;
  identities: TemporaryContactIdentity[];
}

export interface TemporaryContactsPayload {
  accessLevel: 'temporary';
  enrollmentId: string;
  serverOrigin: string;
  contacts: TemporaryContactRecord[];
  createdAt: ISODateString;
}

export interface TemporaryTrustedAccessRequestRecord {
  requestId: string;
  enrollmentId: string;
  temporaryDeviceId: DeviceId;
  identityId: IdentityId;
  createdAt: ISODateString;
  expiresAt: ISODateString;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
}

export interface CreateTemporaryTrustedAccessRequestRequest {
  enrollmentId: string;
}

export interface CreateTemporaryTrustedAccessRequestResponse {
  request: TemporaryTrustedAccessRequestRecord;
}

export type TemporaryRenewalRequestRecord = TemporaryTrustedAccessRequestRecord;

export interface CreateTemporaryRenewalRequestRequest {
  enrollmentId: string;
}

export interface CreateTemporaryRenewalRequestResponse {
  request: TemporaryRenewalRequestRecord;
}

export interface ListTemporaryTrustedAccessRequestsResponse {
  requests: Array<TemporaryTrustedAccessRequestRecord & {
    requestIp?: string | null;
    requestUserAgent?: string | null;
    origin?: string | null;
    temporaryDevicePublicKey: PublicKey;
    temporaryDeviceEncryptionPublicKey?: PublicKey | null;
  }>;
}

export interface ListTemporaryRenewalRequestsResponse {
  requests: Array<TemporaryRenewalRequestRecord & {
    requestIp?: string | null;
    requestUserAgent?: string | null;
    origin?: string | null;
    temporaryDevicePublicKey: PublicKey;
    temporaryDeviceEncryptionPublicKey?: PublicKey | null;
    currentTemporaryAccessExpiresAt?: ISODateString | null;
    accessibleGroupChatIds?: string[];
    accessibleDirectChatIds?: string[];
    canCall?: boolean;
  }>;
}

export interface ApproveTemporaryTrustedAccessRequestRequest {
  requestId: string;
  encryptedTrustedAccessPayload: Base64String;
  cipher: string;
}

export interface RejectTemporaryTrustedAccessRequestRequest {
  requestId: string;
}

export interface ReadTemporaryTrustedAccessPayloadResponse {
  request: TemporaryTrustedAccessRequestRecord;
  encryptedTrustedAccessPayload: Base64String | null;
  cipher: string | null;
}

export interface ApproveTemporaryRenewalRequestRequest {
  requestId: string;
  encryptedTemporaryRenewalPayload: Base64String;
  temporaryAccessExpiresAt: ISODateString;
  cipher: string;
  canCall?: boolean;
}

export interface RejectTemporaryRenewalRequestRequest {
  requestId: string;
}

export interface ReadTemporaryRenewalPayloadResponse {
  request: TemporaryRenewalRequestRecord;
  encryptedTemporaryRenewalPayload: Base64String | null;
  temporaryAccessExpiresAt: ISODateString | null;
  cipher: string | null;
}

export interface TemporaryRenewalTransferPayload {
  accessLevel: 'temporary_renewal';
  enrollmentId: string;
  serverOrigin: string;
  identityId: IdentityId;
  deviceId: DeviceId;
  expiresAt: ISODateString;
  temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
  approvedByDeviceId: DeviceId;
  createdAt: number;
}

export type DeviceEnrollmentState =
  | 'reserved'
  | 'pending_origin_check'
  | 'pending_trusted_read'
  | 'pending_trusted_approval'
  | 'approved'
  | 'activated'
  | 'rejected'
  | 'expired'
  | 'consumed';

export interface BootstrapDeviceEnrollmentQrPayload {
  v: 2;
  server: string;
  identityPublicKey: Base64String;
  enrollmentId: string;
  sessionPublicKey: Base64String;
  trustedDeviceId: DeviceId;
}

export interface CreateDeviceEnrollmentRequest {
  enrollmentId: string;
  newDeviceCiphertext: Base64String;
  cipher: string;
  trustedDeviceId: string;
}

export interface ReserveDeviceEnrollmentRequest {
  enrollmentId: string;
  trustedDeviceId: DeviceId;
  bootstrapCommitment?: string;
  bootstrapPayload?: BootstrapDeviceEnrollmentQrPayload;
}

export interface ReserveDeviceEnrollmentResponse {
  enrollmentId: string;
  expiresAt: ISODateString;
  state: 'reserved';
}

export interface CreateDeviceEnrollmentResponse {
  enrollmentId: string;
  expiresAt: ISODateString;
}

export interface ReadDeviceEnrollmentRequest {
  trustedDeviceId: DeviceId;
}

export interface ReadDeviceEnrollmentResponse {
  enrollmentId: string;
  origin: string | null;
  originVerified: boolean;
  requestIp: string | null;
  requestUserAgent: string | null;
  requestedAt: ISODateString;
  expiresAt: ISODateString;
  newDeviceCiphertext: Base64String | null;
  cipher: string | null;
}

export interface CompleteDeviceEnrollmentRequest {
  trustedDeviceId: DeviceId;
  accessMode: 'temporary' | 'full_circle';
  temporaryDeviceId: DeviceId;
  /** Ed25519 key used only to authenticate the temporary device. */
  temporaryDevicePublicKey: PublicKey;
  /** X25519 key used only to encrypt enrollment/trusted-access payloads to the temporary device. */
  temporaryDeviceEncryptionPublicKey?: PublicKey;
  encryptedTemporaryMembership: Base64String;
  temporaryAccessExpiresAt: ISODateString;
  cipher: string;
  /** Ephemeral sender key required only by platform-recovery enrollments. */
  approvalSenderPublicKey?: PublicKey;
}

export interface CompleteDeviceEnrollmentResponse {
  enrollmentId: string;
  state: 'approved';
}

export interface ReadDeviceEnrollmentPayloadRequest {
  enrollmentId: string;
}

export interface ReadDeviceEnrollmentPayloadResponse {
  state: 'approved';
  encryptedTemporaryMembership: Base64String | null;
  cipher: string | null;
  temporaryAccessExpiresAt: ISODateString | null;
  approvalSenderPublicKey?: PublicKey | null;
}

export interface ActivateDeviceEnrollmentRequest {
  enrollmentId: string;
  activatedDeviceId?: DeviceId;
}

export interface ActivateDeviceEnrollmentResponse {
  enrollmentId: string;
  state: 'activated';
}

export interface RecoverDeviceEnrollmentRequest {
  enrollmentId: string;
  trustedDeviceId: DeviceId;
}

export interface ValidateDeviceEnrollmentRecoveryRequest {
  trustedDeviceId: DeviceId;
  identityPublicKey: Base64String;
}

export interface ValidateDeviceEnrollmentRecoveryResponse {
  enrollmentId: string;
  state: 'reserved';
}

export interface RecoverDeviceEnrollmentResponse {
  enrollmentId: string;
  state: 'activated';
}

export interface ReadDeviceEnrollmentStatusResponse {
  enrollmentId: string;
  state: DeviceEnrollmentState;
  accessMode: 'temporary' | 'full_circle';
  activatedAt: ISODateString | null;
}

/* =========================
   Invite
========================= */

export interface InviteRecord {
  inviteId: InviteId;
  token: string;
  createdBy: IdentityId | 'system';
  createdAt: ISODateString;
  expiresAt: ISODateString;
  maxUses: number;
  usedCount: number;
  status: 'active' | 'expired' | 'exhausted' | 'revoked';
  reusable?: boolean;
  capabilityId?: string | null;
  capabilityMode?: 'single-use' | 'unlimited' | null;
  capabilityDescriptor?: import('./linkCapability').LinkCapabilityDescriptor | null;
  encryptedSecret?: EncryptedBlob | null;
  encryptedMembershipCheckpointBundle?: EncryptedBlob | null;
  acceptances?: InviteAcceptanceRecord[];
}

export interface InviteAcceptanceRecord {
  identityId: IdentityId;
  identityName?: string | null;
  identityPublicKey?: string | null;
  acceptedAt: ISODateString;
  admissionClaim?: {
    capabilityProof: import('./linkCapability').LinkCapabilityProof;
    subjectAcceptance: import('./linkCapability').CircleInviteAcceptance;
  } | null;
}

/**
 * Client-verifiable evidence for Circle participants and direct guests.
 * For Circle membership, a null admission is reserved for the root identity and
 * every other member connects to that root through a circle invitation. Direct
 * guest admissions prove host-scoped guest access only; they do not make the
 * guest part of Circle membership state.
 */
export interface CircleIdentityAdmissionProof {
  identityId: IdentityId;
  publicKey: PublicKey;
  role: 'owner' | 'member' | 'guest';
  status: 'active' | 'disabled' | 'removed';
  admission:
    | {
        kind: 'circle_invite';
        capabilityId: string;
        descriptor: import('./linkCapability').LinkCapabilityDescriptor;
        issuerIdentityId: IdentityId;
        issuerPublicKey: PublicKey;
        claim: {
          capabilityProof: import('./linkCapability').LinkCapabilityProof;
          subjectAcceptance: import('./linkCapability').CircleInviteAcceptance;
        };
      }
    | {
        kind: 'direct_guest';
        capabilityId: string;
        linkId: string;
        descriptor: import('./linkCapability').LinkCapabilityDescriptor;
        issuerIdentityId: IdentityId;
        issuerPublicKey: PublicKey;
        claim: {
          capabilityProof: import('./linkCapability').LinkCapabilityProof;
          subjectAcceptance: import('./linkCapability').DirectGuestAcceptance;
        };
      }
    | null;
}

export interface ChannelSubscriptionAcceptancePayload {
  version: 1;
  purpose: 'circlus-channel-subscription-v1';
  channelId: string;
  subscriberIdentityId: IdentityId;
  sourceLinkId: string | null;
  sourceLinkCapabilityId: string | null;
  sourceLinkProof: import('./linkCapability').LinkCapabilityProof | null;
}

export type ChannelSubscriptionAcceptance = SignedRequest<
  ChannelSubscriptionAcceptancePayload,
  IdentityId
>;

export type CircleMembershipRole = 'owner' | 'member';
export type CircleMembershipAction =
  | 'genesis'
  | 'repair'
  | 'add'
  | 'remove'
  | 'restore'
  | 'transfer_owner'
  | 'set_invite_permission';

export interface CircleMembershipPermissions {
  canCreateInvites: boolean;
}

export interface CircleMembershipEntry {
  identityId: IdentityId;
  publicKey: PublicKey;
  role: CircleMembershipRole;
  permissions?: CircleMembershipPermissions;
}

/** Complete authenticated Circle roster. An `add` may be signed by the
 * invitation capability delegated by an already admitted identity. */
export interface CircleMembershipStatePayload {
  version: 2;
  purpose: 'circle-membership-state-v2';
  vpsId: VpsId;
  circleId: CircleId;
  stateId: string;
  sequence: number;
  previousStateId: string | null;
  /** Content commitment to the previous signed claim; absent on legacy transitions. */
  previousStateHash?: string | null;
  ownerIdentityId: IdentityId;
  members: CircleMembershipEntry[];
  action: CircleMembershipAction;
  subjectIdentityId: IdentityId | null;
  issuedAt: ISODateString;
}

export type CircleMembershipStateClaim = SignedRequest<CircleMembershipStatePayload, string>;

export interface CircleMembershipStateRecord {
  claim: CircleMembershipStateClaim;
  /** Circle invitation admission authorizing a member `add`.
   * Direct guests are intentionally outside Circle membership state. */
  admission: CircleIdentityAdmissionProof['admission'];
}

export interface CircleIdentityProfilePayload {
  version: 1;
  purpose: 'circle-identity-profile-v1';
  circleId: CircleId;
  ownerIdentityId: IdentityId;
  membershipStateId: string;
  revision: number;
  displayName: string | null;
  visibleInCircle: boolean;
  avatar: CircleIdentityProfileAvatar | null;
  issuedAt: ISODateString;
}

export type CircleIdentityProfileClaim = SignedRequest<CircleIdentityProfilePayload, IdentityId>;

export interface CircleIdentityProfileAvatar {
  blobId: string;
  mimeType: string;
  epoch: number;
  /** SHA-256 of the normalized plaintext image bytes, signed inside the encrypted profile. */
  contentDigest: string;
}

export interface CircleProfileEpochPayload {
  version: 1;
  purpose: 'circle-profile-epoch-v1';
  circleId: CircleId;
  epoch: number;
  membershipStateId: string;
  membershipSequence: number;
  previousKeyCommitment: string | null;
  keyCommitment: string;
  issuedAt: ISODateString;
}

export type CircleProfileEpochClaim = SignedRequest<CircleProfileEpochPayload, IdentityId>;

export interface CircleProfileEpochEnvelope {
  epoch: number;
  keyCommitment: string;
  membershipStateId: string;
  publisherIdentityId: IdentityId;
  recipientIdentityId: IdentityId;
  envelopeCiphertext: string;
}

export interface CircleEncryptedIdentityProfile {
  ownerIdentityId: IdentityId;
  epoch: number;
  revision: number;
  sourceRevision: number | null;
  publicationId: string;
  publicationKind: 'manual' | 'republish';
  ciphertext: string;
  updatedAt?: ISODateString;
}

export interface CircleSharedMetadataPayload {
  version: 1;
  purpose: 'circle-shared-metadata-v1';
  circleId: CircleId;
  ownerIdentityId: IdentityId;
  membershipStateId: string;
  epoch: number;
  keyCommitment: string;
  revision: number;
  displayName: string;
  issuedAt: ISODateString;
}

export type CircleSharedMetadataClaim = SignedRequest<CircleSharedMetadataPayload, IdentityId>;

export interface CircleEncryptedSharedMetadata {
  ownerIdentityId: IdentityId;
  epoch: number;
  revision: number;
  ciphertext: string;
  updatedAt?: ISODateString;
}

export interface CircleIdentityStatusPayload {
  version: 1;
  purpose: 'circle-identity-status-v1';
  circleId: CircleId;
  ownerIdentityId: IdentityId;
  membershipStateId: string;
  epoch: number;
  keyCommitment: string;
  revision: number;
  statusText: string | null;
  issuedAt: ISODateString;
}

export type CircleIdentityStatusClaim = SignedRequest<CircleIdentityStatusPayload, IdentityId>;

export interface CircleEncryptedIdentityStatus {
  ownerIdentityId: IdentityId;
  epoch: number;
  revision: number;
  ciphertext: string;
  updatedAt?: ISODateString;
}

export interface CircleMembershipTrustCheckpoint {
  sequence: number;
  stateId: string;
  /** SHA-256 commitment to the canonical signed membership-state claim. */
  stateHash?: string;
  conflicted?: boolean;
}

/* =========================
   Vault
========================= */

export interface VaultRecord {
  identityId: IdentityId;
  encryptedVault: EncryptedBlob;
  updatedAt: ISODateString;
  revision?: number;
  status: 'present' | 'absent';
}

export type ContactAddedVia = 'qr_link' | 'circle_people' | 'conversation' | 'call_history' | 'circle_invitation' | 'guest_invitation';

/**
 * Single identity of a contact on a specific server
 *
 * identityId (aka "fingerprint" / "identity_id") is derived from identityPublicKey.
 * It is the stable identifier used for routing calls and keying cached data.
 */
export interface VaultContactIdentity {
  /** VPS namespace for circleId. Absent only while hydrating pre-CircleKey local data. */
  vpsId?: VpsId;
  circleId: CircleId;
  /**
   * Identity ID on the server (derived from identityPublicKey).
   */
  identityId: IdentityId;

  /**
   * Optional server base URL (useful for multi-server / different client origins).
   * Example: https://my-family.example.com
   */
  serverOrigin?: string;

  // Public key for E2EE call verification and sharing contacts
  identityPublicKey: PublicKey;

  /**
   * Legacy key-import timestamp; does not establish who supplied the key or how the contact was added.
   */
  directKeyVerifiedAt?: ISODateString;

  /**
   * Set when the key was seen/used via server-mediated flows (messages/calls/invites).
   */
  serverKeySeenAt?: ISODateString;

  /** How this contact identity was added. Absent for legacy records; not a trust assertion. */
  addedVia?: ContactAddedVia;
  addedAt: ISODateString;
  /**
   * Optional identity name stored on the server (if allowed and published).
   */
  serverIdentityName?: string;
}

/**
 * Contact (person) - may have multiple identities across different servers
 */
export interface VaultContact {
  contactId: string; // Stable ID across all servers and devices
  displayName: string;
  identities: VaultContactIdentity[]; // One or more identities (server + fingerprint)
  groupId?: string;
  relationshipKind?: 'regular' | 'direct_guest';
  directGuest?: {
    role: 'guest' | 'host';
    canMessage: boolean;
    canCall: boolean;
    canDirectFileTransfer: boolean;
    canServerAttachments?: boolean;
    hostCanMessageGuest?: boolean;
    guestCanMessageHost?: boolean;
    hostCanCallGuest?: boolean;
    guestCanCallHost?: boolean;
    hostCanDirectFileTransferGuest?: boolean;
    guestCanDirectFileTransferHost?: boolean;
    hostCanServerAttachmentsGuest?: boolean;
    guestCanServerAttachmentsHost?: boolean;
    autoSubscribeToChannel?: boolean;
    registrationId?: string;
    departure?: import('./directGuestDeparture').DirectGuestDeparture;
    accessUnavailable?: boolean;
    revocation?: import('./directGuestRevocation').DirectGuestRevocation;
    linkId?: string;
    linkTitle?: string;
    servicePurpose?: 'managed_push_support';
    managedPushRequest?: {
      requestId: string;
      serverUrl: string;
      expiresAt: ISODateString;
      message?: string;
      completedAt?: ISODateString;
    };
    hostIdentityId: IdentityId;
    guestIdentityId?: IdentityId;
  };
  createdAt: ISODateString;
  displayNameUpdatedAt?: ISODateString; // Set when displayName is explicitly changed; used for merge conflict resolution
}

export interface VaultContactGroup {
  groupId: string;
  label: string;
  createdAt: ISODateString;
}

/**
 * Local-only vault data (not synced between devices)
 */
export interface VaultLocalData {
  // Cached contact statuses (identityId -> status info)
  // These are refreshed independently on each device
  contactStatuses?: Record<IdentityId, {
    statusText: string | null;
    statusUpdatedAt: ISODateString | null;
    avatarBlobId?: string | null;
    presence?: {
      visibility?: 'visible' | 'hidden';
      isOnline: boolean;
      lastSeenAt: ISODateString | null;
      onlineUntil: ISODateString | null;
    };
    cachedAt: ISODateString; // When we last fetched this status
  }>;

  // How this device joined — affects master key setup prompts.
  // 'invite_link': registered via invite token (new identity, starts as trusted).
  // 'device_transfer': connected an existing identity (starts as temporary, upgrades to trusted).
  joinMethod?: 'invite_link' | 'device_transfer';

  // Future: short messages (not synced)
  messages?: Record<string, unknown>;

  // Other device-specific data
  [key: string]: unknown;
}

/**
 * Master key status for a single device, stored in the synchronized vault.
 * Allows every device in a circle to know which devices hold a master key
 * and whether they created it themselves (primary) or received it from another device.
 *
 * Values:
 *   'none'         — device has no master key.
 *   'received'     — master key was transferred from another trusted device.
 *   'created_here' — master key was generated on this device (primary origin).
 *
 * Conflict: two devices with 'created_here' in the same circle → user must resolve.
 */
export type MasterKeyStatus = 'none' | 'received' | 'created_here';

export interface VaultDeviceEntry {
  masterKeyStatus: MasterKeyStatus;
  // Client-side timestamp of the last status change on the originating device.
  // Used only to resolve "same device, seen through different circles" merges.
  // Not comparable across different devices.
  updatedAt: ISODateString;
}

export interface VaultDeviceLabelEntry {
  label: string;
  updatedAt: ISODateString;
}

/** Request written by a device that wants to receive the master key. */
export interface VaultMkTransferRequest {
  /**
   * X25519 public key of the requesting device (base64, 32 bytes).
   * The approving device encrypts the master key to this key via ECIES.
   */
  ecdhPublicKey: string;
  /**
   * 2-digit visual confirmation code (00–99), generated with crypto.getRandomValues.
   * Used only for human disambiguation — carries no cryptographic weight.
   */
  code: string;
  /** ISO timestamp when the request was created. */
  requestedAt: ISODateString;
}

/** Response written by the approving device. */
export interface VaultMkTransferResponse {
  /**
   * Master key encrypted via ECIES to the requesting device's X25519 key.
   * encryptedBlob.data  = base64(ephemeralX25519PubKey[32] || AES-GCM-ciphertext)
   * encryptedBlob.nonce = base64(AES-GCM IV[12])
   * encryptedBlob.version = 2
   */
  encryptedBlob: EncryptedBlob;
  /** ISO timestamp when the response was written. */
  respondedAt: ISODateString;
}

/**
 * Vault data structure
 * Separated into syncable (transferred between devices) and local (device-specific) data
 */
export interface VaultData {
  version: number;

  // ========== SYNCABLE DATA (transferred between devices) ==========
  contacts: Record<string, VaultContact>;
  groups: Record<string, VaultContactGroup>;
  preferences?: Record<string, unknown>;
  /** Owner-signed group heads observed by this user's trusted devices. */
  groupChatTrust?: Record<string, GroupChatTrustRecord>;
  /** Highest authenticated edit/delete observed for each message. */
  messageRevisionTrust?: Record<string, MessageRevisionTrustRecord>;
  /** Highest authenticated Circle membership head observed by this identity. */
  circleMembershipTrust?: Record<IdentityId, CircleMembershipTrustCheckpoint>;
  // Server registration dates (for determining primary server per contact)
  /** Keyed by encoded CircleKey (`vpsId + circleId`). */
  serverRegistrations?: Record<string, ISODateString>;
  // Master key status per device. Keyed by deviceId.
  // Written by each device to all its circles so peers can see who holds a master key.
  devices?: Record<string, VaultDeviceEntry>;
  /** User-visible device names, scoped per identity and stored only in the encrypted vault. */
  deviceLabels?: Record<IdentityId, Record<DeviceId, VaultDeviceLabelEntry>>;
  // Pending master key transfer requests. Keyed by requesting deviceId.
  pendingMkRequests?: Record<string, VaultMkTransferRequest>;
  // Pending master key transfer responses. Keyed by requesting deviceId.
  pendingMkResponses?: Record<string, VaultMkTransferResponse>;
  // Written by the device that wins the primary-key conflict resolution.
  mkConflictResolution?: {
    /** The device that claims to be the sole created_here primary. */
    winnerDeviceId: string;
    resolvedAt: ISODateString;
  };

  // ========== PHOTO GALLERY (syncable, per-Circle blob IDs) ==========
  // Global photo library. One photo entry can have blobIds on multiple servers.
  photoGallery?: {
    photos: Array<{
      /** Client-generated stable ID for this photo entry */
      localId: string;
      /** Uploaded blob IDs keyed by encoded CircleKey (`vpsId + circleId`). */
      serverBlobIds: Record<string, string>;
      mimeType: string;
      uploadedAt: ISODateString;
      /** Last metadata/blob-map change; used for deterministic cross-device merge. */
      updatedAt?: ISODateString;
      /** Stable digest of the normalized full-size photo stored in the local protected media library. */
      contentDigest?: string;
      /** Small base64 thumbnail cached locally to avoid re-fetching for gallery UI */
      thumbnailDataUrl?: string;
    }>;
    /** Deletion tombstones prevent an older vault copy from restoring a removed photo. */
    removedPhotoIds?: Record<string, ISODateString>;
  };

  /** Which photo (by localId) each circle identity is currently using as avatar. */
  circleAvatarLocalIds?: Record<IdentityId, string>;
  /** Per-circle selection versions; entries remain after clearing to represent deletion. */
  circleAvatarUpdatedAt?: Record<IdentityId, ISODateString>;

  /** User-defined display names for circles, keyed by own identityId. Synced across user's devices. */
  circleDisplayNames?: Record<IdentityId, string>;

  /** Owner's identityId for each circle, keyed by own identityId. Synced across user's devices. */
  circleOwnerIdentityIds?: Record<IdentityId, string>;

  /** Owner's server-side display name for each circle, keyed by own identityId. Synced across user's devices. */
  circleOwnerIdentityNames?: Record<IdentityId, string>;

  // ========== LOCAL DATA (NOT synced between devices) ==========
  localData?: VaultLocalData;

  meta?: {
    updatedAt: ISODateString;
  };
}

/* =========================
   Push
========================= */

export interface PushSubscriptionRecord {
  pushId: PushId;
  deviceId: DeviceId;
  subscriptionData: unknown;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  status: 'active' | 'disabled' | 'invalid';
}

/* =========================
   Call Session
========================= */

export type CallStatus =
  | 'new'
  | 'ringing'
  | 'accepted'
  | 'connecting'
  | 'active'
  | 'ended'
  | 'failed'
  | 'expired';

export interface CallSession {
  callId: CallId;
  callerIdentityId: IdentityId;
  callerDeviceId: DeviceId;
  calleeIdentityId: IdentityId;
  calleeDeviceId?: DeviceId;
  createdAt: ISODateString;
  status: CallStatus;

  sdpOffer?: string;
  sdpAnswer?: string;
  iceCandidates?: Array<{
    from: 'caller' | 'callee';
    candidate: string;
  }>;

  expiresAt?: ISODateString;
}

/* =========================
   Signed Requests
========================= */

export interface SignedRequest<T = unknown, S extends SignerId = SignerId> {
  /** Physical server namespace covered by the signature for cross-VPS replay protection. */
  vpsId?: VpsId;
  /** VPS-local tenant destination covered by the signature for cross-Circle replay protection. */
  circleId?: CircleId;
  operationId?: string;
  /** Server-issued access revision and signed destination for reversible rights mutations. */
  expectedVersion?: string;
  accessPath?: string;
  type: string;
  timestamp: number;
  nonce: Nonce;
  /**
   * Identifier of the signing key holder.
   *
   * For device-signed requests this is the deviceId.
   * For identity-signed requests (e.g. `auth:register-device`) this is the identityId.
   */
  signerId: S;
  payload: T;
  signature: Signature;
}

export interface ApiResponse<T = unknown> {
  status: 'ok' | 'error';
  result?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryAfterMs?: number;
    requiredFeature?: string;
    minimumClientVersion?: string;
  };
  meta?: {
    serverVersion?: string;
    requestId?: string;
    deprecation?: {
      code: string;
      message: string;
      sunsetAt?: ISODateString;
    };
  };
}

export type ServerFeatureKey =
  | 'familyDomains'
  | 'domainMigrationNotice'
  | 'deviceEnrollmentV2'
  | 'temporaryTrustedAccess'
  | 'attachments'
  | 'avatarStorage'
  | 'callHistorySync'
  | 'mobilePushCentral'
  | 'groupChats'
  | 'directGuestLinks'
  | 'messageMutations'
  | 'serverAdminTenants'
  | 'tenantOwnerClaims'
  | 'publicCircleSite'
  | 'memberRemoval'
  | 'platformRecoveryV1';

export interface ServerCapabilitiesResponse {
  circleId: CircleId;
  vpsId: VpsId;
  /** Schema of this capabilities document, independent from feature API level. */
  capabilitiesVersion: typeof import('./protocolVersions').CAPABILITIES_DOCUMENT_VERSION;
  /** Exact versions of security-sensitive signed protocols accepted by this Circle. */
  protocols: import('./protocolVersions').SignedProtocolVersions;
  /**
   * Monotonically increasing server API level. A newer level contains all
   * capabilities of the lower levels.
   */
  apiLevel: number;
  serverVersion: string;
  /**
   * Runtime feature overrides. Missing means enabled when the API level
   * supports the feature; false means disabled by server policy.
   */
  enabled: Partial<Record<ServerFeatureKey, boolean>>;
  limits: {
    messageTtlHours: number;
    attachmentsEnabled: boolean;
    maxAttachmentFileSizeBytes: number | null;
    attachmentStorageQuotaBytes: number | null;
    attachmentRetentionSeconds: number | null;
    membersCanUseGuestServerAttachments: boolean;
  };
  canonical: {
    publicBaseUrl: string | null;
    acceptedDomainRole?: 'primary' | 'alias' | 'legacy' | 'pending' | null;
    acceptedDomainStatus?: 'active' | 'pending_verification' | 'suspended' | 'disabled' | 'revoked' | null;
    publicSiteEligible?: boolean;
    publicSiteEnabled?: boolean;
  };
  migration?: {
    status: 'primary';
    targetPublicBaseUrl: string | null;
  };
}

/* =========================
   Request Payloads
========================= */

export interface RegisterIdentityPayload {
  inviteToken: string;
  inviteCapabilityProof?: import('./linkCapability').LinkCapabilityProof;
  inviteAcceptance?: import('./linkCapability').CircleInviteAcceptance;
  identityPublicKey: PublicKey;
  encryptedIdentityPrivateKey?: EncryptedBlob;
  membershipState?: CircleMembershipStateRecord;
}

export interface RegisterOwnerIdentityPayload extends RegisterIdentityPayload {
  ownerClaimToken: string;
}

export type CircleOwnerChangeMethod = 'voluntary_transfer';

export interface RegisterDevicePayload {
  /** Stable id created locally before the registration request is sent. */
  deviceId: DeviceId;
  /** Ed25519 key used only to authenticate device-signed requests. */
  devicePublicKey: PublicKey;
  /** X25519 key used only for encrypting payloads to this device. */
  deviceEncryptionPublicKey?: PublicKey;
  /** Proof that the device signing key owner bound the signing and encryption keys together. */
  deviceKeyBinding?: SignedRequest<DeviceKeyBindingPayload, string>;
  encryptedPhysicalDeviceId?: EncryptedBlob | null;
}

export interface SetVaultPayload {
  encryptedVault: EncryptedBlob;
  expectedRevision: number;  // 0 creates; existing writes require the observed revision
}

export interface GetVaultResponse {
  vault?: EncryptedBlob;
  revision?: number;
}

export interface VaultHeadResponse {
  revision: number;
  updatedAt?: string;
}

export interface RegisterPushPayload {
  subscription: unknown;
}

export interface CreateCallPayload {
  calleeIdentityId: IdentityId;
}

export interface CallSignalPayload {
  callId: CallId;
  signal: {
    type: 'offer' | 'answer' | 'ice' | 'accept' | 'reject' | 'end';
    sdp?: string;
    candidate?: string;
    // E2EE verification: signature over DTLS fingerprint extracted from SDP
    dtlsSignature?: string; // Base64-encoded signature
    callKeyDelegation?: {
      payload?: string;
      signature?: string;
    };
  };
}

export interface GetIceServersResponse {
  iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
}

export interface GetTurnCredentialsPayload {
  callSessionId: CallSessionId;
}

export interface GetTurnCredentialsResponse {
  urls: string[];
  username?: string;
  credential?: string;
  expiresAt?: string; // ISO
  /** Opaque, deterministic identifier used for TURN/SFU accounting. */
  mediaSessionId?: string;
  turnClusterId?: string;
}

/* =========================
   Error Codes
========================= */

export type ErrorCode =
  | 'ACCESS_VERSION_CONFLICT'
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'INVALID_SIGNATURE'
  | 'INVALID_NONCE'
  | 'DEVICE_REVOKED'
  | 'IDENTITY_DISABLED'
  | 'MISSING_FAMILY_ID'
  | 'INVITE_INVALID'
  | 'INVITE_EXPIRED'
  | 'INVITE_EXHAUSTED'
  | 'INVITE_DOMAIN_MISMATCH'
  | 'MEMBER_LIMIT_EXCEEDED'
  | 'TOTAL_USER_LIMIT_EXCEEDED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'
  | 'MESSAGE_TOO_LARGE'
  | 'SYNC_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_FEATURE'
  | 'UNSUPPORTED_PROTOCOL_VERSION'
  | 'CLIENT_UPDATE_REQUIRED'
  | 'SERVER_UPDATE_REQUIRED'
  | 'FEATURE_DISABLED'
  | 'CIRCLE_DELETED'
  | 'CIRCLE_SUSPENDED'
  | 'UNKNOWN_FAMILY_DOMAIN'
  | 'DOMAIN_ALIAS_NOT_PRIMARY'
  | 'DOMAIN_MIGRATION_PENDING'
  | 'INTERNAL_ERROR';

/* =========================
   Configuration
========================= */

export interface ServerConfig {
  serverName: string;
}

/* =========================
   WebSocket Messages
========================= */

export type CallSessionId = string;
export type DirectFileTransferSessionId = string;
export type CallState = 'new' | 'ringing' | 'accepted' | 'connecting' | 'active' | 'ended';

/**
 * A receiver-issued capability for one sender to deliver files to one concrete
 * device without an interactive confirmation. The capability is intentionally
 * self-contained: the server can validate it without keeping a plaintext ACL,
 * while the target device remains the final authority and may revoke it locally.
 */
export interface QuickReceiveGrantPayload {
  version: 1;
  purpose: 'direct-file-auto-receive-v1';
  grantId: string;
  receiverIdentityId: IdentityId;
  targetDeviceId: DeviceId;
  authorizedSenderIdentityId: IdentityId;
  issuedAt: ISODateString;
  maxFileSizeBytes?: number;
}

export type QuickReceiveGrant = SignedRequest<QuickReceiveGrantPayload, IdentityId>;

/** E2EE mailbox payload used to distribute and revoke quick-receive grants. */
export interface QuickReceiveControlPlaintext {
  version: 1;
  purpose: 'direct-file-quick-receive-control-v1';
  action: 'upsert' | 'revoke';
  grantId: string;
  issuedAt: ISODateString;
  grant?: QuickReceiveGrant;
}

export interface QuickReceiveControlEnvelope {
  sequence: number;
  controlId: string;
  issuerIdentityId: IdentityId;
  issuerPublicKey: PublicKey;
  ciphertext: string;
  createdAt: ISODateString;
}

export interface SendQuickReceiveControlRequest {
  controlId: string;
  recipientIdentityId: IdentityId;
  ciphertext: string;
}

export interface ListQuickReceiveControlsRequest {
  afterSequence?: number;
  limit?: number;
}

export interface ListQuickReceiveControlsResponse {
  controls: QuickReceiveControlEnvelope[];
  nextSequence: number;
  hasMore: boolean;
}

export interface WebSocketMessage {
  type: string;
  data: any;
  timestamp?: number;
}

export interface WSTemporaryTrustedAccessRequestCreatedData {
  requestId: string;
  identityId: IdentityId;
  temporaryDeviceId: DeviceId;
  createdAt: ISODateString;
}

export interface WSCircleDirectoryChangedData {
  reason: 'membership' | 'profile' | 'profile_epoch';
  changedAt: number;
}

export interface WSTemporaryAccessGrantReadyData {
  requestId: string;
  enrollmentId: string;
  requestType: 'trusted_access' | 'temporary_renewal';
}

export interface WSAttachmentMetadataUpdatedData {
  chatId: string;
  blobId: string;
  status: 'reserved' | 'uploaded' | 'committed' | 'pending_delete' | 'deleted' | 'expired';
  expiresAt: ISODateString;
  deletedAt: ISODateString | null;
  deletedByIdentityId: IdentityId | null;
  deleteReason: string | null;
}

export type WSMessageType =
  | 'register'
  | 'register-call-runtime'
  | 'register-file-transfer-runtime'
  | 'registered'
  | 'system:sync'
  | 'system:sync-ack'
  | 'system:sync-result'
  | 'call-history:sync'
  | 'call-history:sync-ack'
  | 'call-history:mark-missed-seen'
  | 'call-history:sync-result'
  | 'system:event'
  | 'message:send'
  | 'message:status'
  | 'message:edit'
  | 'message:delete'
  | 'message:sync'
  | 'message:sync-status'
  | 'message:sync-ack'
  | 'message:sync-status-ack'
  | 'message:ack'
  | 'message:deliver'
  | 'message:mutation-update'
  | 'message:status-update'
  | 'message:sync-result'
  | 'message:sync-status-result'
  | 'temporary-access:trusted-request-created'
  | 'temporary-access:grant-ready'
  | 'circle:directory-changed'
  | 'attachment:metadata-updated'
  | 'group:chat-updated'
  | 'group:message:deliver'
  | 'group:message:updated'
  | 'identity:server-data-deleted'
  | 'device:delete-local-circle-data'
  | 'quick-receive:control-available'
  | 'call:offer'
  | 'call:incoming'
  | 'call:answer'
  | 'call:answered'
  | 'call:renegotiate-offer'
  | 'call:renegotiate-answer'
  | 'call:ice-candidate'
  | 'call:video-state'
  | 'call:connected'
  | 'call:heartbeat'
  | 'call:resume'
  | 'call:resumed'
  | 'call:finalized'
  | 'call:cancel'
  | 'call:decline'
  | 'call:hangup'
  | 'call:ended'
  | 'file-transfer:offer'
  | 'file-transfer:incoming'
  | 'file-transfer:accept'
  | 'file-transfer:accepted'
  | 'file-transfer:reject'
  | 'file-transfer:rejected'
  | 'file-transfer:ice-candidate'
  | 'file-transfer:bootstrap'
  | 'file-transfer:renotify'
  | 'file-transfer:complete'
  | 'file-transfer:completed'
  | 'file-transfer:cancel'
  | 'file-transfer:ended'
  | 'enrollment:request'
  | 'error';

export interface WSMessage<T extends WSMessageType = WSMessageType, D = unknown> {
  type: T;
  data: D;
  timestamp?: number;
}

/* =========================
   System Events (planned)
========================= */

export type SystemEventId = string;

export type SystemEventType =
  | 'call:missed'
  | 'direct-guest:departed'
  | 'direct-guest:revoked'
  | 'invite:accepted'
  | 'invite:guest-membership'
  | 'device:inactivity-warning'
  | 'circle:migration:scheduled'
  | 'circle:owner-changed';

export type SystemEventCallMissedPayload = {
  callSessionId: CallSessionId;
  remoteIdentityId: IdentityId;
  direction: 'incoming' | 'outgoing';
  reason: 'timeout' | 'unknown';
  isTemporaryLinkCall?: boolean;
  /** When the call session was originally created on the server (ms since epoch). */
  callCreatedAt?: number;
};

export type SystemEventInviteAcceptedPayload = {
  inviteId: InviteId;
  acceptedIdentityId: IdentityId;
  acceptedIdentityPublicKey: PublicKey;
  acceptedIdentityName?: string;
};

export type SystemEventGuestMembershipInvitePayload = {
  inviteId: InviteId;
  hostIdentityId: IdentityId;
  guestIdentityId: IdentityId;
  registrationId: string;
  encryptedSecret: string;
  expiresAt: ISODateString;
};

export type SystemEventDeviceInactivityWarningPayload = {
  deviceId: DeviceId;
  inactiveDays: number;
  reviewAfterDays: number;
  autoRevokeAfterDays: number;
};

export type SystemEventCircleMigrationScheduledPayload = {
  migrationId: string;
  scheduledAt: ISODateString;
  destinationPublicBaseUrl: string;
};

export type SystemEventCircleOwnerChangedPayload = {
  ownershipChangeId: string;
  circleName: string;
  previousOwnerIdentityId: IdentityId;
  previousOwnerIdentityName?: string;
  newOwnerIdentityId: IdentityId;
  newOwnerIdentityName?: string;
  /** `server_admin_recovery` is retained only to identify and reject legacy unsigned events. */
  method: CircleOwnerChangeMethod | 'server_admin_recovery';
  initiatedByIdentityId: IdentityId;
  changedAt: ISODateString;
  ownerRoleDocumentVersion: string;
};

export type SystemEventPayloadByType = {
  'call:missed': SystemEventCallMissedPayload;
  'direct-guest:revoked': import('./directGuestRevocation').DirectGuestRevocationNotice;
  'direct-guest:departed': import('./directGuestDeparture').DirectGuestDepartureNotice;
  'invite:accepted': SystemEventInviteAcceptedPayload;
  'invite:guest-membership': SystemEventGuestMembershipInvitePayload;
  'device:inactivity-warning': SystemEventDeviceInactivityWarningPayload;
  'circle:migration:scheduled': SystemEventCircleMigrationScheduledPayload;
  'circle:owner-changed': SystemEventCircleOwnerChangedPayload;
};

export type SystemEventRecord<T extends SystemEventType = SystemEventType> = {
  eventId: SystemEventId;
  circleId: CircleId;
  recipientIdentityId: IdentityId;
  type: T;
  payload: SystemEventPayloadByType[T];
  /** Server cursor timestamp used for sync/ack (ms since epoch). */
  serverTimestamp: number;
};

export type WSSystemSyncData = {
  type: 'sys:sync';
  payload: {
    since?: number;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSSystemSyncAckPayload = {
  syncedThrough: number;
};

export type WSSystemSyncAckData = {
  type: 'sys:sync-ack';
  payload: WSSystemSyncAckPayload;
  deviceId: DeviceId;
  signature: string;
};

export type WSSystemSyncResultData = {
  events: SystemEventRecord[];
  syncedThrough: number;
  hasMore?: boolean;
};

export type WSCallHistorySyncData = {
  type: 'call-history:sync';
  payload: {
    since?: number;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSCallHistorySyncAckData = {
  type: 'call-history:sync-ack';
  payload: {
    syncedThrough: number;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSCallHistoryMarkMissedSeenData = {
  type: 'call-history:mark-missed-seen';
  payload: {
    callSessionIds?: CallSessionId[];
    peerIdentityId?: IdentityId;
    seenAt: number;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSCallHistoryEvent = {
  callSessionId: CallSessionId;
  localIdentityId: IdentityId;
  remoteIdentityId: IdentityId;
  direction: 'incoming' | 'outgoing';
  status: 'ringing' | 'answered' | 'rejected' | 'ended' | 'failed';
  timestamp: number;
  createdAt: number;
  connectedAt?: number;
  endedAt?: number;
  durationSeconds?: number;
  reason?: string;
  isTemporaryLinkCall?: boolean;
  callLinkTitle?: string;
  remoteIdentityName?: string;
  remotePublicKey?: PublicKey;
  missedSeenAt?: number;
  lastUpdatedAt: number;
};

export type WSCallHistorySyncResultData = {
  events: WSCallHistoryEvent[];
  syncedThrough: number;
  hasMore?: boolean;
};

export type WSCallConnectedData = {
  type: 'call:connected';
  payload: {
    callSessionId: CallSessionId;
    connectedAt: number;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSCallHeartbeatData = {
  type: 'call:heartbeat';
  payload: {
    callSessionId: CallSessionId;
    connectedAt: number;
    sentAt: number;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSCallResumeData = {
  callSessionId: CallSessionId;
};

export type WSCallResumedData = {
  callSessionId: CallSessionId;
  resumed: boolean;
  reason?: 'resumed' | 'already_bound' | 'not_pending';
};

/**
 * Client-observed WebRTC diagnostics for a call, reported best-effort
 * alongside call:finalized. Complements the server's own ICE candidate-type
 * view (see call_ice_diagnostics) with things only the client can see: the
 * actually-selected candidate pair and its health, which UI connection
 * phases it went through, and whether E2EE/DTLS verification succeeded.
 */
export type CallSelectedCandidatePairInfo = {
  localType?: string;
  remoteType?: string;
  protocol?: string;
  rttMs?: number;
  bytesSent?: number;
  bytesReceived?: number;
  state?: string;
};

export type CallPhaseHistoryEntry = {
  phase: string;
  atMs: number;
};

export type CallClientRuntimeDiagnostics = {
  diagnosticsVersion?: number;
  platform?: 'android' | 'ios' | 'web' | string;
  runtimeMode?: string;
  appVersionName?: string | null;
  appVersionCode?: number | string | null;
  androidSdk?: number | null;
  iosVersion?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  webViewPackage?: string | null;
  webViewVersion?: string | null;
  appForeground?: boolean | null;
  lastNegotiationOperation?: string | null;
  lastNegotiationReason?: string | null;
  lastNegotiationSignalingState?: string | null;
  lastNegotiationError?: string | null;
  signalingClosedAtMs?: number | null;
  signalingCloseCode?: number | null;
  signalingReconnectDelayMs?: number | null;
  signalingResumeSentAtMs?: number | null;
  signalingResumedAtMs?: number | null;
  signalingResumeResult?: string | null;
  /** Android ICE setup results contain status codes and server URL labels only, never credentials. */
  iceSetup?: {
    bootstrap?: { status: string; httpStatus?: number | null; errorCode?: string | null; failure?: string | null; hasTurn: boolean };
    callCredentials?: { status: string; httpStatus?: number | null; errorCode?: string | null; failure?: string | null; hasTurn: boolean };
    selectedTurnSource?: string;
  } | null;
  iceCandidateErrors?: Array<{ atMs: number; url: string; code: number }>;
  terminationTrigger?: string | null;
  signalingRegisteredAtEnd?: boolean;
  callStateAtEnd?: string | null;
};

export type CallQualityMetricSummary = {
  average: number;
  maximum: number;
};

/** Bounded history of both audio directions at the reporting participant. */
export type CallAudioIntervalHistory = {
  columns: string[];
  /** Numeric matrix; null means unsupported or no consecutive baseline. Times use the reporting device clock. */
  rows: Array<Array<number | null>>;
  observedIntervals: number;
  omittedIntervals: number;
};

/** Incoming audio summary; omitted fields are unsupported.
 * Buffer maxima are maxima of per-stream sampling-interval averages, not packet peaks.
 */
export type CallAudioQualitySummary = {
  intervalHistory?: CallAudioIntervalHistory;
  packetsLost?: number;
  packetsReceived?: number;
  packetsDiscarded?: number;
  concealedSamples?: number;
  silentConcealedSamples?: number;
  concealmentEvents?: number;
  insertedSamplesForDeceleration?: number;
  removedSamplesForAcceleration?: number;
  jitterMs?: CallQualityMetricSummary;
  concealmentPercent?: CallQualityMetricSummary;
  jitterBufferDelayMs?: CallQualityMetricSummary;
  jitterBufferTargetDelayMs?: CallQualityMetricSummary;
  jitterBufferMinimumDelayMs?: CallQualityMetricSummary;
};

export type CallMediaQualitySummary = {
  schemaVersion: 1;
  sampleCount: number;
  startedAtMs: number;
  endedAtMs: number;
  mediaSessionId?: string | null;
  turnClusterId?: string | null;
  usedRelay: boolean;
  reconnectCount: number;
  rttMs?: CallQualityMetricSummary;
  jitterMs?: CallQualityMetricSummary;
  packetLoss?: {
    lost: number;
    received: number;
    percent: number;
  };
  bitrateKbps?: {
    outboundAverage?: number;
    inboundAverage?: number;
    availableOutgoingAverage?: number;
    availableOutgoingMinimum?: number;
  };
  bytesSent?: number;
  bytesReceived?: number;
  audio?: CallAudioQualitySummary;
  video?: {
    framesEncoded?: number;
    framesDecoded?: number;
    framesDropped?: number;
    freezeCount?: number;
    totalFreezesDurationMs?: number;
    qualityLimitationReasons?: string[];
  };
};

export type CallClientDiagnosticsReport = {
  /** First locally observed media connection, not the time the call was accepted. */
  mediaConnectedAtMs?: number;
  diagnosticsVersion?: number;
  finalConnectionState?: string | null;
  finalIceConnectionState?: string | null;
  everConnected: boolean;
  reachedReconnecting: boolean;
  securityVerified?: boolean | null;
  selectedCandidatePair?: CallSelectedCandidatePairInfo | null;
  phaseHistory?: CallPhaseHistoryEntry[];
  endReason?: string | null;
  runtime?: CallClientRuntimeDiagnostics | null;
  mediaQuality?: CallMediaQualitySummary | null;
};

// Architectural note: detailed call-handling events are intentionally uploaded while
// call reliability is being validated; later they should move behind an explicit
// diagnostics-sharing setting.
export type CallHandlingEventType =
  | 'fcm_received'
  | 'fcm_target_missing'
  | 'incoming_call_security_rejected'
  | 'incoming_call_accepted'
  | 'push_received'
  | 'foreground_service_start_requested'
  | 'foreground_service_received'
  | 'foreground_service_started'
  | 'incoming_ui_shown'
  | 'ringing_started'
  | 'answered'
  | 'declined'
  | 'incoming_suppressed'
  | 'expired'
  | 'notifications_disabled'
  | 'bootstrap_started'
  | 'bootstrap_success'
  | 'bootstrap_failed'
  | 'native_answer_start'
  | 'native_runtime_registered'
  | 'answer_sent'
  | 'telecom_reported'
  | 'telecom_failed'
  | 'busy'
  | 'call_finalized';

export type CallHandlingEventReport = {
  callSessionId: CallSessionId;
  eventType: CallHandlingEventType;
  occurredAt: number;
  reasonCode?: string | null;
};

export type CallDeliveryStatus =
  | 'delivered'
  | 'ringing'
  | 'answered'
  | 'declined'
  | 'busy'
  | 'could_not_reach_device'
  | 'failed';

export type WSCallDeliveryStatusData = {
  callSessionId: CallSessionId;
  status: CallDeliveryStatus;
  reason?: string;
  occurredAt: number;
};

export type WSCallFinalizedData = {
  type: 'call:finalized';
  payload: {
    callSessionId: CallSessionId;
    endedAt: number;
    finalStatus: 'answered' | 'rejected' | 'ended' | 'failed';
    durationSeconds?: number;
    reason?: string;
    diagnostics?: CallClientDiagnosticsReport;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSCallVideoStateData = {
  callSessionId: CallSessionId;
  enabled: boolean;
  source?: 'camera' | 'screen';
  requestReply?: boolean;
};

export type WSCallIncomingData = {
  callSessionId: CallSessionId;
  fromIdentityId?: IdentityId;
  fromIdentityPublicKey?: PublicKey;
  fromIdentityName?: string;
  isTemporaryLinkCall?: boolean;
  callLinkTitle?: string;
  capabilityGrant?: {
    descriptor: import('./linkCapability').LinkCapabilityDescriptor;
    proof: import('./linkCapability').LinkCapabilityProof;
  };
  offer: unknown;
};

export type WSCallAnsweredData = {
  callSessionId: CallSessionId;
  fromIdentityId?: IdentityId;
  fromIdentityPublicKey?: PublicKey;
  fromIdentityName?: string;
  answer: unknown;
};

export type WSCallIceCandidateData = {
  callSessionId: CallSessionId;
  candidate: unknown;
};

export type WSCallEndedData = {
  callSessionId: CallSessionId;
  reason: string;
};

export type WSRegisterCallRuntimeData = {
  signedRequest: SignedRequest<{
    callSessionId: CallSessionId;
    identityId?: IdentityId;
    remoteIdentityId: IdentityId;
    role: 'caller' | 'callee';
    mode: 'video-native';
    callKeyDelegation?: {
      payload?: string;
      signature?: string;
    };
  }, DeviceId | string>;
};

export type FileTransferRuntimeRole = 'sender' | 'receiver';

export type FileTransferKeyDelegationClaims = {
  type: 'circlus.file-transfer-key.delegation.v1';
  identityId: IdentityId;
  identityPublicKey: string;
  deviceId: DeviceId;
  transferSigningPublicKey: string;
  capabilities: Array<'file-transfer.send' | 'file-transfer.receive'>;
  notBefore: number;
  expiresAt: number;
  createdAt: number;
  keyId: string;
};

export type FileTransferKeyDelegation = {
  payload: string;
  signature: string;
};

export type WSRegisterDirectFileTransferRuntimeData = {
  signedRequest: SignedRequest<{
    sessionId: DirectFileTransferSessionId;
    identityId: IdentityId;
    remoteIdentityId: IdentityId;
    deviceId: DeviceId;
    role: FileTransferRuntimeRole;
    mode: 'direct-file-native';
    fileTransferKeyDelegation: FileTransferKeyDelegation;
  }, string>;
};

export type WSDirectFileTransferMetadata = {
  fileName: string;
  size: number;
  mimeType: string;
  presentationKind?: 'media' | 'file';
  transferProtocolVersion?: number;
  batch?: {
    batchId: string;
    fileIndex: number;
    fileCount: number;
    totalSize: number;
  };
};

export type WSDirectFileTransferIncomingData = {
  sessionId: DirectFileTransferSessionId;
  fromIdentityId: IdentityId;
  fromIdentityName?: string;
  fromDeviceId?: DeviceId;
  metadata: WSDirectFileTransferMetadata;
  offer: unknown;
  targetDeviceId?: DeviceId;
  autoReceiveGrant?: QuickReceiveGrant;
};

export type WSDirectFileTransferOfferData = {
  sessionId: DirectFileTransferSessionId;
  targetIdentityId: IdentityId;
  metadata: WSDirectFileTransferMetadata;
  offer: unknown;
  targetDeviceId?: DeviceId;
  autoReceiveGrant?: QuickReceiveGrant;
  quickTargets?: Array<{
    targetDeviceId: DeviceId;
    autoReceiveGrant: QuickReceiveGrant;
  }>;
};

export type WSDirectFileTransferBootstrapData = {
  sessionId: DirectFileTransferSessionId;
};

export type WSDirectFileTransferAcceptData = {
  sessionId: DirectFileTransferSessionId;
  answer: unknown;
  transferProtocolVersion?: number;
};

export type WSDirectFileTransferRejectData = {
  sessionId: DirectFileTransferSessionId;
  reason: string;
};

export type WSDirectFileTransferAcceptedData = {
  sessionId: DirectFileTransferSessionId;
  answer: unknown;
  transferProtocolVersion?: number;
};

export type WSDirectFileTransferRejectedData = {
  sessionId: DirectFileTransferSessionId;
  reason: string;
};

export type WSDirectFileTransferIceCandidateData = {
  sessionId: DirectFileTransferSessionId;
  candidate: unknown;
};

export type WSDirectFileTransferCompletedData = {
  sessionId: DirectFileTransferSessionId;
  receivedBytes: number;
};

export type WSDirectFileTransferEndedData = {
  sessionId: DirectFileTransferSessionId;
  reason: string;
};

export type MessageStatus = 'new' | 'delivered' | 'read';

export type DirectMessageDeliveryReceipt = SignedRequest<{
  version: 1;
  purpose: 'direct-message-delivery-v1';
  serverMessageId: string;
  clientMessageId: string;
  authorClaimSignature: string;
  senderIdentityId: IdentityId;
  recipientIdentityId: IdentityId;
  recipientDeviceId: DeviceId;
}, IdentityId>;

export type DirectMessageDeliveryProof = {
  receipt: DirectMessageDeliveryReceipt;
  temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
};

export type WSMessageSendPayload = {
  recipientIdentityId: IdentityId;
  ciphertext: string;
  senderCiphertext?: string;
  notificationPreviewCiphertext?: string;
  temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
  clientMessageId: string;
  clientCreatedAt?: number;
  epoch?: number;
  authorClaim?: DirectMessageAuthorClaim;
};

export type WSMessageSendData = {
  type: 'msg:send';
  payload: WSMessageSendPayload;
  deviceId: DeviceId;
  signature: string;
};

export type WSMessageStatusPayload = {
  serverMessageId: string;
  status: Exclude<MessageStatus, 'new'>;
  deliveryProof?: DirectMessageDeliveryProof;
};

export type WSMessageStatusData = {
  type: 'msg:status';
  payload: WSMessageStatusPayload;
  deviceId: DeviceId;
  signature: string;
};

export type WSMessageEditPayload = {
  serverMessageId: string;
  ciphertext: string;
  senderCiphertext?: string;
  epoch?: number;
  authorClaim?: DirectMessageAuthorClaim;
};

export type WSMessageEditData = {
  type: 'msg:edit';
  payload: WSMessageEditPayload;
  deviceId: DeviceId;
  signature: string;
};

export type WSMessageDeletePayload = {
  serverMessageId: string;
  authorClaim?: DirectMessageAuthorClaim;
};

export type WSMessageDeleteData = {
  type: 'msg:delete';
  payload: WSMessageDeletePayload;
  deviceId: DeviceId;
  signature: string;
};

export type WSMessageSyncData = {
  type: 'msg:sync';
  payload: {
    since?: number;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSMessageSyncStatusData = {
  type: 'msg:sync-status';
  payload: {
    since?: number;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSMessageSyncAckPayload = {
  syncedThrough: number;
};

export type WSMessageSyncAckData = {
  type: 'msg:sync-ack';
  payload: WSMessageSyncAckPayload;
  deviceId: DeviceId;
  signature: string;
};

export type WSMessageSyncStatusAckData = {
  type: 'msg:sync-status-ack';
  payload: WSMessageSyncAckPayload;
  deviceId: DeviceId;
  signature: string;
};

export type WSMessageAckData = {
  clientMessageId: string;
  serverMessageId: string;
  serverTimestamp: number;
  status: MessageStatus;
};

export type DirectMessageReplyReference = {
  messageId: string;
  senderIdentityId: IdentityId;
  previewText: string;
  previewStart: number | null;
  previewEnd: number | null;
  previewKind?: 'photo';
  originalTimestamp?: number;
  channelId?: string;
  channelPostId?: string;
};

export type WSMessageDeliverData = {
  serverMessageId: string;
  senderIdentityId: IdentityId;
  recipientIdentityId: IdentityId;
  /** Device that originally authored a self-chat message; omitted for regular direct chats. */
  senderDeviceId?: DeviceId;
  /**
   * Optional sender identity public key for decrypting messages when the receiver
   * doesn't yet have the sender saved in their vault.
   */
  senderIdentityPublicKey?: PublicKey;
  senderIdentityName?: string;
  senderIdentityRole?: 'owner' | 'member' | 'guest';
  ciphertext: string;
  senderCiphertext?: string;
  senderSignature: string;
  authorClaim?: DirectMessageAuthorClaim | null;
  temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
  clientMessageId?: string;
  clientCreatedAt?: number | null;
  epoch?: number;
  serverTimestamp: number;
  editedAt?: number | null;
  deletedAt?: number | null;
  contentUpdatedAt?: number | null;
  revision?: number;
  /**
   * Gapless, monotonic per-direct-chat sequence number, assigned by the server
   * and always present in server-delivered payloads. Used as the focused
   * per-chat sync cursor. Optional only because locally created rows reuse
   * this shape before the server has assigned a sequence number.
   */
  chatSeq?: number;
};

export type WSMessageMutationUpdateData = WSMessageDeliverData;

export type WSMessageStatusUpdateData = {
  serverMessageId: string;
  status: Exclude<MessageStatus, 'new'>;
  serverTimestamp: number;
  deliveryProof?: DirectMessageDeliveryProof;
};

export type ReadCursor = {
  peerIdentityId: IdentityId;
  readThrough: number;
};

export type WSReadCursorPushData = {
  peerIdentityId: IdentityId;
  readThrough: number;
};

export type WSMarkReadData = {
  type: 'msg:mark-read';
  payload: {
    peerIdentityId: IdentityId;
    readThrough: number;
  };
  deviceId: DeviceId;
  signature: string;
};

export type WSMessageSyncResultData = {
  messages: WSMessageDeliverData[];
  syncedThrough: number;
  hasMore?: boolean;
  readCursors?: ReadCursor[];
};

export type WSMessageSyncStatusResultData = {
  updates: WSMessageStatusUpdateData[];
  syncedThrough: number;
  hasMore?: boolean;
};

export type WSGroupChatUpdatedData = {
  chatId: string;
  event:
    | 'chat_created'
    | 'chat_renamed'
    | 'participants_added'
    | 'participant_removed'
    | 'owner_transferred'
    | 'participant_left'
    | 'participant_leave_requested'
    | 'device_revoked'
    | 'device_added'
    | 'periodic_rekey'
    | 'settings_updated';
  titleCiphertext?: string;
  participantIds?: string[];
  participantId?: string;
  identityId?: string;
  ownerIdentityId?: string;
  from?: string;
  to?: string;
  muted?: boolean;
  keyEpoch?: number;
  rekeyRequired?: boolean;
  rekeyRequiredAt?: number;
};

export type WSGroupMessageDeliverData = {
  chatId: string;
  messageId: string;
  senderIdentityId: string;
  ciphertext: string;
  senderSignature: string | null;
  authorClaim?: GroupMessageAuthorClaim | null;
  temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
  clientMessageId: string;
  clientCreatedAt: number | null;
  createdAt: number;
  epoch?: number;
  editedAt?: number | null;
  deletedAt?: number | null;
  contentUpdatedAt?: number | null;
  revision?: number;
  chatSeq?: number;
  kind?: 'user' | 'system';
  systemType?: string | null;
  systemPayload?: Record<string, unknown> | null;
};

export type WSGroupMessageUpdatedData = WSGroupMessageDeliverData;

/* =========================
   Server Monitoring (Admin)
========================= */

export type ResourceStatus = 'healthy' | 'warning' | 'critical';

export interface ResourceUsage {
  used: number;
  total: number;
  percentage: number;
  status: ResourceStatus;
}

export interface DatabaseMetrics {
  totalConnections: number;
  idleConnections: number;
  activeConnections: number;
  waitingConnections: number;
  maxConnections: number;
  poolUtilization: number;
  status: ResourceStatus;
}

export interface ApplicationMetrics {
  totalUsers: number;
  activeDevices: number;
  onlineDevices: number;
  activeCalls: number;
  totalInvites: number;
  activeInvites: number;
}

export interface ServerHealthMetrics {
  timestamp: ISODateString;
  uptime: number;
  cpu: ResourceUsage;
  memory: ResourceUsage;
  disk?: ResourceUsage;
  database: DatabaseMetrics;
  application: ApplicationMetrics;
  overallStatus: ResourceStatus;
  recommendations: string[];
}

export interface GetServerHealthResponse {
  health: ServerHealthMetrics;
}
