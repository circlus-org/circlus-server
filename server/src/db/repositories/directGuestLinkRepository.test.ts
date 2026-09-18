import type { PoolClient } from 'pg';
import { pool } from '../index';
import { DirectGuestLinkRepository } from './directGuestLinkRepository';

jest.mock('../index', () => ({
  pool: { query: jest.fn() },
}));

describe('DirectGuestLinkRepository.create', () => {
  it('sends a numbered parameterized query without pgtyped named parameters', async () => {
    const createdAt = new Date('2026-08-19T12:00:00.000Z');
    const query = jest.fn().mockResolvedValue({
      rows: [{
        link_id: 'link-1',
        family_id: 'family-1',
        host_identity_id: 'host-1',
        created_by_identity_id: 'host-1',
        secret_hash: 'secret-hash',
        encrypted_secret: null,
        status: 'active',
        title: null,
        presentation_title: null,
        presentation_description: null,
        presentation_image_url: null,
        can_message: true,
        can_call: false,
        can_direct_file_transfer: false,
        can_server_attachments: false,
        host_can_message_guest: true,
        guest_can_message_host: true,
        host_can_call_guest: false,
        guest_can_call_host: false,
        host_can_direct_file_transfer_guest: false,
        guest_can_direct_file_transfer_host: false,
        host_can_server_attachments_guest: false,
        guest_can_server_attachments_host: false,
        auto_subscribe_to_channel: false,
        public_site_visible: false,
        public_site_channel_slug: null,
        public_site_cta_label: null,
        public_site_intro_title: null,
        public_site_intro_text: null,
        public_site_intro_image_url: null,
        public_site_guest_link_url: null,
        max_uses: null,
        created_at: createdAt,
        updated_at: createdAt,
        revoked_at: null,
      }],
    });
    const repository = new DirectGuestLinkRepository();

    await repository.create({
      linkId: 'link-1',
      familyId: 'family-1',
      hostIdentityId: 'host-1',
      createdByIdentityId: 'host-1',
      secretHash: 'secret-hash',
      canMessage: true,
      canCall: false,
      canDirectFileTransfer: false,
      canServerAttachments: false,
      hostCanMessageGuest: true,
      guestCanMessageHost: true,
      hostCanCallGuest: false,
      guestCanCallHost: false,
      hostCanDirectFileTransferGuest: false,
      guestCanDirectFileTransferHost: false,
      hostCanServerAttachmentsGuest: false,
      guestCanServerAttachmentsHost: false,
      autoSubscribeToChannel: false,
    }, { query } as unknown as PoolClient);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/:\w+/);
    expect(Array.from(sql.matchAll(/\$(\d+)/g), (match) => Number(match[1])))
      .toEqual(Array.from({ length: 36 }, (_, index) => index + 1));
    expect(values).toHaveLength(36);
    expect(values.slice(0, 5)).toEqual([
      'link-1',
      'family-1',
      'host-1',
      'host-1',
      'secret-hash',
    ]);
  });
});

describe('DirectGuestLinkRepository.deleteRevokedEmpty', () => {
  it('uses the current schema and retains the revoked and registration guards', async () => {
    const query = pool.query as jest.Mock;
    query.mockResolvedValueOnce({ rows: [] });

    const deleted = await new DirectGuestLinkRepository().deleteRevokedEmpty(
      'family-1', 'link-1', 'host-1'
    );

    expect(deleted).toBeNull();
    expect(query).toHaveBeenCalledWith(expect.any(String), ['family-1', 'link-1', 'host-1']);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("l.status = 'revoked'");
    expect(sql).toContain('FROM direct_guest_registrations r');
    expect(sql).toContain('DELETE FROM announcement_channel_links acl');
    expect(sql).not.toContain('direct_guest_broadcasts');
  });
});
