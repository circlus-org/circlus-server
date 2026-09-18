import type {
  Base64String,
  DeviceId,
  IdentityId,
  ISODateString,
  PublicKey,
  SignedRequest
} from './types';

export const PLATFORM_RECOVERY_VERSION = 1 as const;
export const PLATFORM_RECOVERY_BINDING_TYPE = 'platform-recovery:bind' as const;
export const PLATFORM_RECOVERY_BINDING_PURPOSE = 'circlus-platform-recovery-binding-v1' as const;
export const PLATFORM_RECOVERY_LOCATOR_PURPOSE = 'circlus-platform-recovery-locator-v1' as const;
export const PLATFORM_RECOVERY_PROOF_BUNDLE_PURPOSE = 'circlus-platform-recovery-proof-bundle-v1' as const;
export const PLATFORM_RECOVERY_TRANSCRIPT_PURPOSE = 'circlus-platform-recovery-enrollment-v1' as const;
export const PLATFORM_RECOVERY_REVOCATION_TYPE = 'platform-recovery:revoke' as const;
export const PLATFORM_RECOVERY_REVOCATION_PURPOSE = 'circlus-platform-recovery-revocation-v1' as const;
export const ANDROID_PLATFORM_RECOVERY_SLOT = 'android_google_restore_v1' as const;
export const IOS_PLATFORM_RECOVERY_SLOT = 'ios_icloud_synced_key_v1' as const;

export type PlatformRecoverySlot =
  | typeof ANDROID_PLATFORM_RECOVERY_SLOT
  | typeof IOS_PLATFORM_RECOVERY_SLOT;

export type AndroidRestoreWebAuthnAuthenticator = {
  kind: 'android_restore_webauthn';
  /** WebAuthn relying-party id. It must be covered by Digital Asset Links. */
  rpId: string;
  /** Base64url WebAuthn credential id. */
  credentialId: string;
  /** Base64url COSE public-key bytes registered by the Circle. */
  credentialPublicKeyCose: string;
  /** The first protocol version deliberately supports only WebAuthn ES256. */
  algorithm: 'ES256';
  /** Exact WebAuthn clientDataJSON origins accepted for the signed Android app. */
  allowedOrigins: string[];
};

/** Dedicated recovery key synchronized by the iOS adapter through Keychain. */
export type IosSyncedKeyAuthenticator = {
  kind: 'ios_synced_key';
  publicKey: PublicKey & { algorithm: 'ed25519' };
};

export type PlatformRecoveryAuthenticator =
  | AndroidRestoreWebAuthnAuthenticator
  | IosSyncedKeyAuthenticator;

export function platformRecoverySlotForAuthenticator(
  authenticator: PlatformRecoveryAuthenticator
): PlatformRecoverySlot {
  return authenticator.kind === 'android_restore_webauthn'
    ? ANDROID_PLATFORM_RECOVERY_SLOT
    : IOS_PLATFORM_RECOVERY_SLOT;
}

/**
 * Long-lived authorization of one platform recovery authenticator.
 *
 * The enclosing SignedRequest must be signed by the Circlus identity key, not
 * by a device key and not by the Circle server. Revocation is a separate,
 * identity-authorized protocol action.
 */
export type PlatformRecoveryBindingPayload = {
  version: typeof PLATFORM_RECOVERY_VERSION;
  purpose: typeof PLATFORM_RECOVERY_BINDING_PURPOSE;
  bindingId: string;
  /** Internal platform-account slot. It is not a user-facing setting. */
  recoverySlot: PlatformRecoverySlot;
  circleOrigin: string;
  identityId: IdentityId;
  authenticator: PlatformRecoveryAuthenticator;
  issuedAt: ISODateString;
  expiresAt: ISODateString;
};

export type PlatformRecoveryBinding = SignedRequest<
  PlatformRecoveryBindingPayload,
  IdentityId
>;

export type PlatformRecoveryRevocationPayload = {
  version: typeof PLATFORM_RECOVERY_VERSION;
  purpose: typeof PLATFORM_RECOVERY_REVOCATION_PURPOSE;
  bindingId: string;
  recoverySlot: PlatformRecoverySlot;
  circleOrigin: string;
  identityId: IdentityId;
  revokedAt: ISODateString;
};

export type PlatformRecoveryRevocation = SignedRequest<
  PlatformRecoveryRevocationPayload,
  IdentityId
>;

/**
 * Minimal non-secret record restored through platform app-data backup. The
 * public key lets a new installation authenticate the server-returned binding;
 * identityId remains self-certifying and must be re-derived from that key.
 */
export type PlatformRecoveryLocator = {
  version: typeof PLATFORM_RECOVERY_VERSION;
  purpose: typeof PLATFORM_RECOVERY_LOCATOR_PURPOSE;
  circleOrigin: string;
  circleId: string;
  identityId: IdentityId;
  identityPublicKey: PublicKey;
  bindingId: string;
  recoverySlot: PlatformRecoverySlot;
};

/**
 * Every value that must be authenticated before an existing device may approve
 * a platform-assisted enrollment. The server contributes freshness but is not
 * trusted to choose or replace either new-device key.
 */
export type PlatformRecoveryEnrollmentTranscript = {
  version: typeof PLATFORM_RECOVERY_VERSION;
  purpose: typeof PLATFORM_RECOVERY_TRANSCRIPT_PURPOSE;
  bindingId: string;
  circleOrigin: string;
  identityId: IdentityId;
  enrollmentId: string;
  newDeviceId: DeviceId;
  newDeviceSigningPublicKey: PublicKey;
  newDeviceEncryptionPublicKey: PublicKey;
  clientNonce: string;
  serverNonce: string;
  expiresAt: ISODateString;
};

export type AndroidRestoreCredentialProof = {
  kind: 'android_restore_webauthn';
  /** JSON returned by Android RestoreCredential.authenticationResponseJson. */
  authenticationResponseJson: string;
};

export type IosSyncedKeyProof = {
  kind: 'ios_synced_key';
  signature: Base64String;
};

export type PlatformRecoveryProof =
  | AndroidRestoreCredentialProof
  | IosSyncedKeyProof;

/**
 * Complete untrusted transport envelope. Consumers must verify every field
 * locally and must never rely on a Circle-provided "verified" boolean.
 */
export type PlatformRecoveryProofBundle = {
  version: typeof PLATFORM_RECOVERY_VERSION;
  purpose: typeof PLATFORM_RECOVERY_PROOF_BUNDLE_PURPOSE;
  binding: PlatformRecoveryBinding;
  transcript: PlatformRecoveryEnrollmentTranscript;
  platformProof: PlatformRecoveryProof;
  /** Ed25519 signature over the encoded transcript by the new device key. */
  newDeviceSignature: Base64String;
};

export type BeginPlatformRecoveryEnrollmentRequest = {
  locator: PlatformRecoveryLocator;
  newDeviceId: DeviceId;
  newDeviceSigningPublicKey: PublicKey;
  newDeviceEncryptionPublicKey: PublicKey;
  clientNonce: string;
};

export type BeginPlatformRecoveryEnrollmentResponse = {
  binding: PlatformRecoveryBinding;
  transcript: PlatformRecoveryEnrollmentTranscript;
  /** Present only for Android WebAuthn. It is untrusted and must be checked locally. */
  requestJson?: string;
};

export type SubmitPlatformRecoveryEnrollmentRequest = {
  proofBundle: PlatformRecoveryProofBundle;
};

export type ReadPlatformRecoveryEnrollmentResponse = {
  proofBundle: PlatformRecoveryProofBundle;
  requestIp: string | null;
  requestUserAgent: string | null;
  requestedAt: ISODateString;
  expiresAt: ISODateString;
};

/**
 * Fixed-order, versioned encoding used as the WebAuthn challenge preimage (or
 * equivalent platform-proof message). Callers hash the UTF-8 result with
 * SHA-256 and encode the digest as base64url.
 *
 * Do not replace this array encoding with object serialization. Its exact bytes
 * are a protocol contract shared by web, Android, future iOS and the server.
 */
export function encodePlatformRecoveryEnrollmentTranscript(
  transcript: PlatformRecoveryEnrollmentTranscript
): string {
  if (
    transcript.version !== PLATFORM_RECOVERY_VERSION
    || transcript.purpose !== PLATFORM_RECOVERY_TRANSCRIPT_PURPOSE
    || transcript.newDeviceSigningPublicKey.algorithm !== 'ed25519'
    || transcript.newDeviceEncryptionPublicKey.algorithm !== 'x25519'
  ) {
    throw new Error('Invalid platform recovery enrollment transcript');
  }
  return JSON.stringify([
    PLATFORM_RECOVERY_TRANSCRIPT_PURPOSE,
    transcript.version,
    transcript.bindingId.trim(),
    transcript.circleOrigin.trim(),
    transcript.identityId.trim(),
    transcript.enrollmentId.trim(),
    transcript.newDeviceId.trim(),
    transcript.newDeviceSigningPublicKey.algorithm,
    transcript.newDeviceSigningPublicKey.value.trim(),
    transcript.newDeviceEncryptionPublicKey.algorithm,
    transcript.newDeviceEncryptionPublicKey.value.trim(),
    transcript.clientNonce.trim(),
    transcript.serverNonce.trim(),
    transcript.expiresAt.trim()
  ]);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const second = offset + 1 < bytes.length ? bytes[offset + 1] : 0;
    const third = offset + 2 < bytes.length ? bytes[offset + 2] : 0;
    const value = (first << 16) | (second << 8) | third;
    result += alphabet[(value >>> 18) & 63];
    result += alphabet[(value >>> 12) & 63];
    if (offset + 1 < bytes.length) result += alphabet[(value >>> 6) & 63];
    if (offset + 2 < bytes.length) result += alphabet[value & 63];
  }
  return result;
}

/** WebAuthn challenge bound to the exact new-device transcript. */
export async function createPlatformRecoveryChallenge(
  transcript: PlatformRecoveryEnrollmentTranscript
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto subtle API is unavailable');
  const encoded = new TextEncoder().encode(
    encodePlatformRecoveryEnrollmentTranscript(transcript)
  );
  const digest = await subtle.digest('SHA-256', encoded as unknown as ArrayBuffer);
  return bytesToBase64Url(new Uint8Array(digest));
}
