export type DeviceEnrollmentBootstrapPayload = {
  v: 2;
  server: string;
  identityPublicKey: string;
  enrollmentId: string;
  sessionPublicKey: string;
  trustedDeviceId: string;
};

const DEVICE_ENROLLMENT_COMMITMENT_CONTEXT = 'circlus-device-enrollment-bootstrap-v1';

/**
 * A deliberately fixed-order encoding shared by the browser and server.
 * Do not replace this with object JSON serialization: property ordering must
 * remain part of the public commitment protocol.
 */
export function encodeDeviceEnrollmentBootstrap(
  payload: DeviceEnrollmentBootstrapPayload
): string {
  return JSON.stringify([
    DEVICE_ENROLLMENT_COMMITMENT_CONTEXT,
    payload.v,
    payload.server.trim(),
    payload.identityPublicKey.trim(),
    payload.enrollmentId.trim(),
    payload.sessionPublicKey.trim(),
    payload.trustedDeviceId.trim()
  ]);
}
