import { validateConfiguredAttachmentMaxFileSize } from './attachmentConfigValidation';

describe('attachmentConfigValidation', () => {
  const previous = process.env.ATTACHMENTS_MAX_HTTP_BODY;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.ATTACHMENTS_MAX_HTTP_BODY;
    } else {
      process.env.ATTACHMENTS_MAX_HTTP_BODY = previous;
    }
  });

  it('reserves space for the AES-GCM authentication tag', () => {
    process.env.ATTACHMENTS_MAX_HTTP_BODY = '100b';
    expect(validateConfiguredAttachmentMaxFileSize(84)).toBeNull();
    expect(validateConfiguredAttachmentMaxFileSize(85)).toContain('16 bytes of encryption overhead');
  });

  it('accepts null and rejects non-positive limits', () => {
    expect(validateConfiguredAttachmentMaxFileSize(null)).toBeNull();
    expect(validateConfiguredAttachmentMaxFileSize(0)).toContain('positive number');
  });
});

