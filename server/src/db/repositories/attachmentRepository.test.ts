jest.mock('../index', () => ({
  query: jest.fn(),
  transaction: jest.fn(async (callback: (client: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: mockClientQuery };
    return callback(client);
  })
}));

import { attachmentRepository } from './index';

const mockClientQuery = jest.fn();

describe('AttachmentRepository.commitBlob', () => {
  const params = {
    familyId: 'family-1',
    reservationId: 'reservation-1',
    blobId: 'blob-1',
    senderIdentityId: 'identity-1',
    chatType: 'direct' as const,
    chatId: 'thread-1',
    linkedMessageId: 'message-1'
  };

  const committedBlob = {
    id: 'blob-row-1',
    blob_id: params.blobId,
    family_id: params.familyId,
    uploader_identity_id: params.senderIdentityId,
    chat_type: params.chatType,
    chat_id: params.chatId,
    sender_identity_id: params.senderIdentityId,
    linked_message_id: params.linkedMessageId,
    plaintext_size_bytes: 123,
    ciphertext_size_bytes: 456,
    ciphertext_sha256: null,
    storage_key: 'family-1/blob-1',
    status: 'committed',
    expires_at: new Date('2026-01-01T00:00:00Z'),
    committed_at: new Date('2026-01-01T00:00:00Z'),
    deleted_at: null,
    deleted_by_identity_id: null,
    delete_reason: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z')
  };

  beforeEach(() => {
    mockClientQuery.mockReset();
  });

  it('returns the existing blob for a repeated identical commit without updating quota', async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{
          reservation_id: params.reservationId,
          blob_id: params.blobId,
          family_id: params.familyId,
          uploader_identity_id: params.senderIdentityId,
          plaintext_size_bytes: 123,
          status: 'committed'
        }]
      })
      .mockResolvedValueOnce({ rows: [committedBlob] });

    const result = await attachmentRepository.commitBlob(params);

    expect(result).toBe(committedBlob);
    expect(mockClientQuery).toHaveBeenCalledTimes(2);
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE family_config'))).toBe(false);
  });

  it('rejects a repeated commit that targets a different message', async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{
          reservation_id: params.reservationId,
          blob_id: params.blobId,
          family_id: params.familyId,
          uploader_identity_id: params.senderIdentityId,
          plaintext_size_bytes: 123,
          status: 'committed'
        }]
      })
      .mockResolvedValueOnce({
        rows: [{
          ...committedBlob,
          linked_message_id: 'other-message'
        }]
      });

    const result = await attachmentRepository.commitBlob(params);

    expect(result).toBeNull();
    expect(mockClientQuery).toHaveBeenCalledTimes(2);
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE family_config'))).toBe(false);
  });
});
