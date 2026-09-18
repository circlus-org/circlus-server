import { getStorageRuntimeConfig } from '../config/serverRuntimeConfig';

export const ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES = 16;

export function getAttachmentsHttpBodyLimitRaw(): string {
  return getStorageRuntimeConfig().attachments.maxHttpBody;
}

export function getAttachmentsHttpBodyLimitBytes(): number {
  return getStorageRuntimeConfig().attachments.maxHttpBodyBytes;
}

export function getMaxAttachmentPlaintextBytes(): number {
  return Math.max(0, getAttachmentsHttpBodyLimitBytes() - ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES);
}
