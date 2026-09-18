import {
  PLATFORM_RECOVERY_BINDING_PURPOSE,
  PLATFORM_RECOVERY_BINDING_TYPE,
  PLATFORM_RECOVERY_PROOF_BUNDLE_PURPOSE,
  PLATFORM_RECOVERY_VERSION,
  encodePlatformRecoveryEnrollmentTranscript,
  platformRecoverySlotForAuthenticator,
  type BeginPlatformRecoveryEnrollmentResponse,
  type PlatformRecoveryBinding,
  type PlatformRecoveryProofBundle
} from '../../../shared/platformRecovery';

const MAX_BINDING_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;

export function isValidPlatformRecoveryBindingShape(
  binding: PlatformRecoveryBinding,
  identityId: string,
  nowMs = Date.now()
): boolean {
  const payload = binding?.payload;
  const authenticator = payload?.authenticator;
  const issuedAt = Date.parse(payload?.issuedAt || '');
  const expiresAt = Date.parse(payload?.expiresAt || '');
  return binding?.type === PLATFORM_RECOVERY_BINDING_TYPE
    && binding.signerId === identityId
    && payload?.version === PLATFORM_RECOVERY_VERSION
    && payload.purpose === PLATFORM_RECOVERY_BINDING_PURPOSE
    && payload.identityId === identityId
    && Boolean(payload.bindingId?.trim())
    && Boolean(payload.circleOrigin?.trim())
    && Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && issuedAt <= nowMs + 5 * 60 * 1000
    && expiresAt > nowMs
    && expiresAt - issuedAt <= MAX_BINDING_LIFETIME_MS
    && authenticator !== undefined
    && payload.recoverySlot === platformRecoverySlotForAuthenticator(authenticator)
    && (authenticator.kind === 'android_restore_webauthn'
      ? authenticator.algorithm === 'ES256'
        && Boolean(authenticator.rpId?.trim())
        && Boolean(authenticator.credentialId?.trim())
        && Boolean(authenticator.credentialPublicKeyCose?.trim())
        && Array.isArray(authenticator.allowedOrigins)
        && authenticator.allowedOrigins.length > 0
        && authenticator.allowedOrigins.every(origin => Boolean(origin?.trim()))
      : authenticator.kind === 'ios_synced_key'
        && authenticator.publicKey?.algorithm === 'ed25519'
        && Boolean(authenticator.publicKey.value?.trim()));
}

export function isValidSubmittedPlatformRecoveryProof(params: {
  proof: PlatformRecoveryProofBundle;
  stored: BeginPlatformRecoveryEnrollmentResponse;
  verifyNewDeviceSignature: (message: string, signature: string) => boolean;
  verifyPlatformSignature?: (message: string, signature: string, binding: PlatformRecoveryBinding) => boolean;
}): boolean {
  try {
    const proofTranscript = encodePlatformRecoveryEnrollmentTranscript(params.proof.transcript);
    const storedTranscript = encodePlatformRecoveryEnrollmentTranscript(params.stored.transcript);
    const authenticator = params.proof.binding.payload.authenticator;
    const platformProof = params.proof.platformProof;
    const platformProofValid = authenticator.kind === 'android_restore_webauthn'
      ? platformProof.kind === 'android_restore_webauthn'
        && Boolean(platformProof.authenticationResponseJson?.trim())
      : platformProof.kind === 'ios_synced_key'
        && Boolean(platformProof.signature?.trim())
        && Boolean(params.verifyPlatformSignature?.(
          proofTranscript,
          platformProof.signature,
          params.proof.binding
        ));
    return params.proof.version === PLATFORM_RECOVERY_VERSION
      && params.proof.purpose === PLATFORM_RECOVERY_PROOF_BUNDLE_PURPOSE
      && platformProofValid
      && JSON.stringify(params.proof.binding) === JSON.stringify(params.stored.binding)
      && proofTranscript === storedTranscript
      && params.verifyNewDeviceSignature(proofTranscript, params.proof.newDeviceSignature);
  } catch {
    return false;
  }
}
