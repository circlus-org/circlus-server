import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export function createAttachmentUploadToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashAttachmentUploadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyAttachmentUploadToken(token: string, expectedHash: string): boolean {
  const actualBuf = Buffer.from(hashAttachmentUploadToken(token), 'hex');
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
}
