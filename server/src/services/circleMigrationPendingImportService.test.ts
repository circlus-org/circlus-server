import {
  isRecognizedSourceAttachmentUrl,
  normalizeOpenGuestLink,
  transformCopiedRow,
  transformFamilyConfig
} from './circleMigrationPendingImportService';

describe('Circle migration destination normalization', () => {
  const manifest = {
    oldPublicBaseUrl: 'https://old-circle.example',
    targetPublicBaseUrl: 'https://new-circle.example',
    configAdjustments: {}
  } as any;

  it('clears only recognized source attachment routes', () => {
    expect(isRecognizedSourceAttachmentUrl(
      'https://old-circle.example/api/direct-guest-links/presentation-images/dglimg_1',
      'https://old-circle.example'
    )).toBe(true);
    expect(isRecognizedSourceAttachmentUrl(
      'https://old-circle.example/images/kept.png',
      'https://old-circle.example'
    )).toBe(false);
    expect(isRecognizedSourceAttachmentUrl(
      'https://cdn.example/api/direct-guest-links/presentation-images/dglimg_1',
      'https://old-circle.example'
    )).toBe(false);

    expect(transformCopiedRow('direct_guest_links', {
      family_id: 'family',
      presentation_image_url: 'https://old-circle.example/api/direct-guest-links/presentation-images/a',
      public_site_intro_image_url: 'https://cdn.example/intro.png',
      public_site_guest_link_url: null
    }, manifest)).toMatchObject({
      presentation_image_url: null,
      public_site_intro_image_url: null
    });
    expect(transformCopiedRow('circle_site_settings', {
      family_id: 'family',
      cover_image_url: 'https://cdn.example/cover.png'
    }, manifest)).toMatchObject({ cover_image_url: null });
    expect(transformCopiedRow('announcement_channels', {
      family_id: 'family',
      public_site_intro_image_url: 'https://cdn.example/intro.png'
    }, manifest)).toMatchObject({ public_site_intro_image_url: null });
    expect(transformCopiedRow('direct_guest_link_defaults', {
      family_id: 'family',
      presentation_image_url: 'https://old-circle.example/api/direct-guest-links/presentation-images/default'
    }, manifest)).toMatchObject({ presentation_image_url: null });
  });

  it('rewrites only the server field in a standard direct-link open URL', () => {
    const source = 'https://links.example/open#type=direct-link&server=old-circle.example&linkId=dgl_1&secret=keep';
    const normalized = normalizeOpenGuestLink(
      source,
      'https://old-circle.example',
      'https://new-circle.example'
    );
    const parsed = new URL(String(normalized));
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    expect(parsed.origin).toBe('https://links.example');
    expect(fragment.get('server')).toBe('new-circle.example');
    expect(fragment.get('linkId')).toBe('dgl_1');
    expect(fragment.get('secret')).toBe('keep');
    expect(normalizeOpenGuestLink(
      'https://links.example/open#type=contact-share&server=old-circle.example',
      'https://old-circle.example',
      'https://new-circle.example'
    )).toBe('https://links.example/open#type=contact-share&server=old-circle.example');
  });

  it('does not trust source-owned destination policy fields', () => {
    const transformed = transformFamilyConfig({
      family_id: '11111111-1111-4111-8111-111111111111',
      server_name: 'old',
      owner_identity_id: 'owner',
      public_base_url: 'https://old-circle.example',
      message_ttl_hours: 720,
      attachments_enabled: true,
      max_attachment_file_size_bytes: 100,
      attachment_storage_quota_bytes: 200,
      attachment_retention_seconds: 300,
      used_attachment_storage_bytes: 80,
      reserved_attachment_storage_bytes: 20,
      status: 'active',
      created_by_server_admin_id: 'old-admin',
      join_invite_id: 'invite',
      message_archive_server_policy: 'text_with_attachments',
      message_archive_circle_policy: 'text_with_attachments',
      max_member_identities: 100,
      max_total_identities: 200
    }, {
      server_name: 'new',
      target_public_base_url: 'https://new-circle.example',
      expected_owner_identity_id: 'owner',
      created_by_server_admin_id: 'new-admin',
      settings: {
        messageTtlHours: 24,
        attachmentsEnabledAfterActivation: false,
        messageArchivePolicyAfterActivation: 'disabled'
      },
      limits: {
        maxMemberIdentities: 10,
        maxTotalIdentities: 20
      }
    } as any, manifest);

    expect(transformed).toMatchObject({
      server_name: 'new',
      public_base_url: 'https://new-circle.example',
      message_ttl_hours: 24,
      attachments_enabled: false,
      max_attachment_file_size_bytes: null,
      attachment_storage_quota_bytes: null,
      used_attachment_storage_bytes: 0,
      reserved_attachment_storage_bytes: 0,
      status: 'pending_import',
      owner_identity_id: 'owner',
      created_by_server_admin_id: 'new-admin',
      join_invite_id: null,
      message_archive_server_policy: 'disabled',
      message_archive_circle_policy: 'disabled',
      max_member_identities: 10,
      max_total_identities: 20
    });
  });
});
