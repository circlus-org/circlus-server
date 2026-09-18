import {
  ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES,
  getAttachmentsHttpBodyLimitRaw,
  getMaxAttachmentPlaintextBytes
} from './attachmentHttpBodyLimit';

export function validateConfiguredAttachmentMaxFileSize(maxAttachmentFileSizeBytes: number | null | undefined): string | null {
  if (maxAttachmentFileSizeBytes === undefined || maxAttachmentFileSizeBytes === null) {
    return null;
  }

  const numericValue = Number(maxAttachmentFileSizeBytes);
  if (!Number.isFinite(numericValue) || numericValue < 1) {
    return 'maxAttachmentFileSizeBytes must be a positive number or null';
  }

  if (numericValue > getMaxAttachmentPlaintextBytes()) {
    return `maxAttachmentFileSizeBytes plus ${ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES} bytes of encryption overhead cannot exceed ATTACHMENTS_MAX_HTTP_BODY (${getAttachmentsHttpBodyLimitRaw()})`;
  }

  return null;
}
