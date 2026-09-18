import nacl from 'tweetnacl';
import { encodeBase64, decodeUTF8 } from 'tweetnacl-util';
import {
  PLATFORM_RECOVERY_BINDING_PURPOSE,
  PLATFORM_RECOVERY_BINDING_TYPE,
  PLATFORM_RECOVERY_PROOF_BUNDLE_PURPOSE,
  PLATFORM_RECOVERY_TRANSCRIPT_PURPOSE,
  PLATFORM_RECOVERY_VERSION,
  ANDROID_PLATFORM_RECOVERY_SLOT,
  IOS_PLATFORM_RECOVERY_SLOT,
  encodePlatformRecoveryEnrollmentTranscript,
  type BeginPlatformRecoveryEnrollmentResponse,
  type PlatformRecoveryBinding,
  type PlatformRecoveryProofBundle
} from '../../../shared/platformRecovery';
import {
  isValidPlatformRecoveryBindingShape,
  isValidSubmittedPlatformRecoveryProof
} from './platformRecoveryEnrollmentValidation';

const now = Date.parse('2026-08-29T12:00:00.000Z');

function binding(): PlatformRecoveryBinding {
  return {
    type: PLATFORM_RECOVERY_BINDING_TYPE,
    signerId: 'identity-1',
    payload: {
      version: PLATFORM_RECOVERY_VERSION,
      purpose: PLATFORM_RECOVERY_BINDING_PURPOSE,
      bindingId: 'binding-1',
      recoverySlot: ANDROID_PLATFORM_RECOVERY_SLOT,
      circleOrigin: 'https://circle.example',
      identityId: 'identity-1',
      authenticator: {
        kind: 'android_restore_webauthn',
        rpId: 'web.circlus.org',
        credentialId: 'credential-1',
        credentialPublicKeyCose: 'cose-key',
        algorithm: 'ES256',
        allowedOrigins: ['android:apk-key-hash:release-key']
      },
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString()
    },
    signature: 'identity-signature'
  };
}

function iosBinding(publicKey: string): PlatformRecoveryBinding {
  const value = binding();
  value.payload.recoverySlot = IOS_PLATFORM_RECOVERY_SLOT;
  value.payload.authenticator = {
    kind: 'ios_synced_key',
    publicKey: { algorithm: 'ed25519', value: publicKey }
  };
  return value;
}

function fixture(): {
  stored: BeginPlatformRecoveryEnrollmentResponse;
  proof: PlatformRecoveryProofBundle;
  verify: (message: string, signature: string) => boolean;
} {
  const keyPair = nacl.sign.keyPair();
  const transcript = {
    version: PLATFORM_RECOVERY_VERSION,
    purpose: PLATFORM_RECOVERY_TRANSCRIPT_PURPOSE,
    bindingId: 'binding-1',
    circleOrigin: 'https://circle.example',
    identityId: 'identity-1',
    enrollmentId: 'enrollment-1',
    newDeviceId: 'new-device-1',
    newDeviceSigningPublicKey: { algorithm: 'ed25519' as const, value: encodeBase64(keyPair.publicKey) },
    newDeviceEncryptionPublicKey: { algorithm: 'x25519' as const, value: encodeBase64(nacl.box.keyPair().publicKey) },
    clientNonce: 'client-nonce',
    serverNonce: 'server-nonce',
    expiresAt: new Date(now + 60_000).toISOString()
  };
  const message = encodePlatformRecoveryEnrollmentTranscript(transcript);
  const signature = encodeBase64(nacl.sign.detached(decodeUTF8(message), keyPair.secretKey));
  const activeBinding = binding();
  const stored = { binding: activeBinding, transcript, requestJson: '{}' };
  const proof: PlatformRecoveryProofBundle = {
    version: PLATFORM_RECOVERY_VERSION,
    purpose: PLATFORM_RECOVERY_PROOF_BUNDLE_PURPOSE,
    binding: activeBinding,
    transcript,
    platformProof: { kind: 'android_restore_webauthn', authenticationResponseJson: '{}' },
    newDeviceSignature: signature
  };
  return {
    stored,
    proof,
    verify: (candidate, candidateSignature) => nacl.sign.detached.verify(
      decodeUTF8(candidate),
      Buffer.from(candidateSignature, 'base64'),
      keyPair.publicKey
    )
  };
}

describe('platform recovery enrollment validation', () => {
  test('accepts a bounded identity binding with explicit Android origins', () => {
    expect(isValidPlatformRecoveryBindingShape(binding(), 'identity-1', now)).toBe(true);
    const invalid = binding();
    invalid.payload.authenticator.allowedOrigins = [''];
    expect(isValidPlatformRecoveryBindingShape(invalid, 'identity-1', now)).toBe(false);
  });

  test('accepts an iOS synced-key binding only in its internal iCloud slot', () => {
    const keyPair = nacl.sign.keyPair();
    const candidate = iosBinding(encodeBase64(keyPair.publicKey));
    expect(isValidPlatformRecoveryBindingShape(candidate, 'identity-1', now)).toBe(true);
    candidate.payload.recoverySlot = ANDROID_PLATFORM_RECOVERY_SLOT;
    expect(isValidPlatformRecoveryBindingShape(candidate, 'identity-1', now)).toBe(false);
  });

  test('accepts only the exact reserved transcript and binding', () => {
    const { stored, proof, verify } = fixture();
    expect(isValidSubmittedPlatformRecoveryProof({ proof, stored, verifyNewDeviceSignature: verify })).toBe(true);

    const substituted = structuredClone(proof);
    substituted.transcript.newDeviceSigningPublicKey.value = encodeBase64(nacl.sign.keyPair().publicKey);
    expect(isValidSubmittedPlatformRecoveryProof({
      proof: substituted,
      stored,
      verifyNewDeviceSignature: verify
    })).toBe(false);

    const changedBinding = structuredClone(proof);
    changedBinding.binding.payload.bindingId = 'server-binding';
    expect(isValidSubmittedPlatformRecoveryProof({
      proof: changedBinding,
      stored,
      verifyNewDeviceSignature: verify
    })).toBe(false);
  });

  test('accepts an iOS proof only when the synced key signs the reserved transcript', () => {
    const { stored, proof, verify } = fixture();
    const recoveryKeyPair = nacl.sign.keyPair();
    const candidateBinding = iosBinding(encodeBase64(recoveryKeyPair.publicKey));
    stored.binding = candidateBinding;
    proof.binding = candidateBinding;
    proof.platformProof = {
      kind: 'ios_synced_key',
      signature: encodeBase64(nacl.sign.detached(
        decodeUTF8(encodePlatformRecoveryEnrollmentTranscript(proof.transcript)),
        recoveryKeyPair.secretKey
      ))
    };
    expect(isValidSubmittedPlatformRecoveryProof({
      proof,
      stored,
      verifyNewDeviceSignature: verify,
      verifyPlatformSignature: (message, signature, activeBinding) => {
        const authenticator = activeBinding.payload.authenticator;
        return authenticator.kind === 'ios_synced_key'
          && nacl.sign.detached.verify(
            decodeUTF8(message),
            Buffer.from(signature, 'base64'),
            Buffer.from(authenticator.publicKey.value, 'base64')
          );
      }
    })).toBe(true);
  });
});
