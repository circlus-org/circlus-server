import fs from 'node:fs';
import path from 'node:path';

function readPublicInitialSchema(): string {
  const candidates = [
    path.resolve(process.cwd(), 'db/migrations/001_initial_schema.sql'),
    path.resolve(process.cwd(), '../SERVER_PUBLIC_INITIAL_SCHEMA.sql')
  ];
  const schemaPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!schemaPath) {
    throw new Error(`Public initial schema not found. Tried: ${candidates.join(', ')}`);
  }
  return fs.readFileSync(schemaPath, 'utf8');
}

describe('Public initial database schema', () => {
  const publicInitialSchema = readPublicInitialSchema();

  it('supports guest diagnostics and keeps media timing separate from legacy acceptance', () => {
    expect(publicInitialSchema).toContain('media_connected_at bigint');
    expect(publicInitialSchema).not.toContain('ADD CONSTRAINT call_client_diagnostics_identity_id_fkey');
    expect(publicInitialSchema).not.toContain('ADD CONSTRAINT call_client_diagnostics_device_id_fkey');
    expect(publicInitialSchema).toContain('ADD CONSTRAINT call_client_diagnostics_call_session_id_fkey');
    expect(publicInitialSchema).toContain('ADD CONSTRAINT call_client_diagnostics_family_id_fkey');
  });

  it('includes reliability and access revisions in the initial release without upgrade files', () => {
    for (const table of ['signed_request_nonces', 'signed_operation_results', 'signed_resource_versions', 'message_send_receipts']) {
      expect(publicInitialSchema).toContain(`CREATE TABLE public.${table}`);
    }
    for (const table of ['server_admin_claims', 'tenant_owner_claims']) {
      const body = publicInitialSchema.match(new RegExp(`CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`))?.[1];
      expect(body).toContain('redemption_result jsonb');
    }
    expect(publicInitialSchema).toContain("'temporary_renewal'::text");
    expect(publicInitialSchema).toContain('CREATE FUNCTION public.bump_access_resource_version');
    expect(publicInitialSchema).toContain('CREATE FUNCTION public.track_access_resource_version');
    for (const table of ['identities', 'platform_recovery_bindings', 'call_whitelist_entries',
      'direct_guest_registrations', 'server_admins', 'family_config',
      'announcement_channels', 'announcement_channel_subscriptions']) {
      expect(publicInitialSchema).toContain(`CREATE TRIGGER track_access_version AFTER INSERT OR UPDATE OR DELETE ON public.${table}`);
    }
  });

  it('defines the durable Circle migration tables', () => {
    for (const table of [
      'migration_slots',
      'circle_migrations',
      'circle_migration_events',
      'family_migration_redirects'
    ]) {
      expect(publicInitialSchema).toContain(`CREATE TABLE public.${table}`);
    }
  });

  it('persists encrypted migration credentials and idempotency bindings', () => {
    for (const column of [
      'migration_code_encrypted',
      'idempotency_key',
      'request_fingerprint',
      'source_session_public_key',
      'session_credentials_encrypted'
    ]) {
      expect(publicInitialSchema).toContain(column);
    }
    expect(publicInitialSchema).toContain("'pending_import'::text");
  });

  it('creates migration foreign keys after the referenced family key', () => {
    const familyKeyPosition = publicInitialSchema.indexOf(
      'ADD CONSTRAINT family_config_family_id_key UNIQUE (family_id)'
    );
    expect(familyKeyPosition).toBeGreaterThan(-1);
    for (const constraint of [
      'ADD CONSTRAINT circle_migrations_family_fk FOREIGN KEY',
      'ADD CONSTRAINT family_migration_redirects_family_fk FOREIGN KEY'
    ]) {
      expect(publicInitialSchema.indexOf(constraint)).toBeGreaterThan(familyKeyPosition);
    }
  });

  it('does not inline a foreign key before its referenced table exists', () => {
    const createdTables = new Set<string>();
    const tablePattern = /CREATE TABLE public\.([a-z0-9_]+) \(([\s\S]*?)\n\);/g;
    for (const table of publicInitialSchema.matchAll(tablePattern)) {
      const tableName = table[1];
      const body = table[2];
      for (const reference of body.matchAll(/REFERENCES public\.([a-z0-9_]+)/g)) {
        expect({ table: tableName, referencedTable: reference[1], alreadyCreated: createdTables.has(reference[1]) })
          .toEqual({ table: tableName, referencedTable: reference[1], alreadyCreated: true });
      }
      createdTables.add(tableName);
    }
  });

  it('contains the native announcement channel schema without legacy broadcast tables', () => {
    for (const table of [
      'announcement_channels',
      'announcement_channel_links',
      'announcement_channel_subscriptions',
      'announcement_channel_epoch_keys',
      'announcement_channel_key_envelopes',
      'announcement_channel_posts'
    ]) {
      expect(publicInitialSchema).toContain(`CREATE TABLE public.${table}`);
    }
    expect(publicInitialSchema).not.toContain('CREATE TABLE public.direct_guest_broadcast');
    expect(publicInitialSchema).toContain("public_site_state text DEFAULT 'hidden'::text NOT NULL");
  });

  it('keeps guest-link and channel titles at their published privacy boundary', () => {
    expect(publicInitialSchema).toContain(
      "COMMENT ON COLUMN public.direct_guest_links.title IS 'Optional private management label."
    );
    expect(publicInitialSchema).toContain(
      "COMMENT ON COLUMN public.announcement_channels.title IS 'Guest-visible channel title."
    );
  });

  it('stores guest-invite delegation per identity rather than as a global member policy', () => {
    expect(publicInitialSchema).toContain('can_create_guest_invites boolean DEFAULT false NOT NULL');
    expect(publicInitialSchema).not.toContain('members_can_create_guest_links');
  });

  it('contains durable call-link management metadata', () => {
    const table = publicInitialSchema.match(/CREATE TABLE public\.call_links \(([\s\S]*?)\n\);/)?.[1] || '';
    expect(table).toContain('title character varying(120)');
    expect(table).toContain('join_invite_id character varying(255)');
    expect(table).toContain('revoked_at timestamp without time zone');
    expect(publicInitialSchema).toContain('ADD CONSTRAINT fk_call_links_join_invite FOREIGN KEY');
  });

  it('allows call-link callers to appear in call history without local identity rows', () => {
    const table = publicInitialSchema.match(/CREATE TABLE public\.call_logs \(([\s\S]*?)\n\);/)?.[1] || '';
    expect(table).toContain('external_initiator_public_key jsonb');
    expect(table).toContain('call_link_title text');
    expect(publicInitialSchema).not.toContain('call_logs_initiator_identity_id_fkey');
    expect(publicInitialSchema).toContain('call_logs_target_identity_id_fkey');
  });

  it('allows external call participants to have ICE diagnostics', () => {
    expect(publicInitialSchema).toContain('CREATE TABLE public.call_ice_diagnostics');
    expect(publicInitialSchema).toContain('call_ice_diagnostics_call_session_id_fkey');
    expect(publicInitialSchema).not.toContain('call_ice_diagnostics_identity_id_fkey');
  });

  it('folds the complete client-verifiable link capability schema into the public baseline', () => {
    const tableBody = (tableName: string) => publicInitialSchema.match(
      new RegExp(`CREATE TABLE public\\.${tableName} \\(([\\s\\S]*?)\\n\\);`)
    )?.[1] || '';
    const expectedColumns: Record<string, string[]> = {
      invites: [
        'capability_id text',
        'capability_public_key text',
        'capability_mode text',
        'capability_descriptor jsonb',
        'capability_revocation jsonb',
        'encrypted_secret jsonb',
        'encrypted_membership_checkpoint_bundle jsonb'
      ],
      direct_guest_links: [
        'capability_id text',
        'capability_public_key text',
        'capability_mode text',
        'capability_descriptor jsonb',
        'capability_revocation jsonb',
        'expires_at timestamp with time zone'
      ],
      call_links: [
        'capability_id text',
        'capability_public_key text',
        'capability_mode text',
        'capability_descriptor jsonb',
        'capability_revocation jsonb',
        'encrypted_secret jsonb',
        'claimed_by_identity_id text',
        'claimed_by_public_key_algorithm text',
        'claimed_by_public_key_value text'
      ],
      invite_acceptances: ['capability_id text', 'admission_claim jsonb'],
      circle_membership_states: ['state_id text', 'claim jsonb', 'admission jsonb'],
      circle_profile_epochs: ['membership_state_id text', 'membership_sequence bigint', 'key_commitment text', 'claim jsonb'],
      circle_profile_epoch_envelopes: ['recipient_identity_id text', 'publisher_identity_id text', 'envelope_ciphertext text'],
      circle_encrypted_identity_profiles: [
        'owner_identity_id text', 'epoch integer', 'revision bigint', 'source_revision bigint',
        'publication_id text', 'publication_kind text', 'ciphertext text'
      ],
      announcement_channel_epoch_keys: ['membership_state_id text'],
      announcement_channel_key_envelopes: ['membership_state_id text'],
      direct_guest_registrations: ['capability_id text', 'admission_claim jsonb'],
      identities: ['admission_capability_id text'],
      announcement_channel_subscriptions: ['subscription_claim jsonb']
    };
    for (const [tableName, columns] of Object.entries(expectedColumns)) {
      const body = tableBody(tableName);
      for (const column of columns) expect(body).toContain(column);
    }
    for (const name of [
      'uq_invites_capability_id',
      'uq_direct_guest_links_capability_id',
      'uq_call_links_capability_id',
      'uq_direct_guest_registration_identity',
      'idx_invite_acceptances_capability',
      'idx_direct_guest_registrations_capability',
      'invites_capability_mode_check',
      'direct_guest_links_capability_mode_check',
      'call_links_capability_mode_check',
      'call_links_claimed_identity_check'
    ]) {
      expect(publicInitialSchema).toContain(name);
    }
    expect(publicInitialSchema).toContain("'set_invite_permission'::text");
  });

  it('contains device-enrollment bootstrap commitments', () => {
    for (const fragment of [
      'bootstrap_commitment text',
      'bootstrap_payload jsonb',
      'check_device_enrollment_bootstrap_pair',
      'idx_device_enrollments_bootstrap_commitment'
    ]) {
      expect(publicInitialSchema).toContain(fragment);
    }
  });

  it('contains owner recovery claims, audit history and deferred family foreign keys', () => {
    for (const table of ['circle_owner_recovery_claims', 'circle_owner_changes']) {
      expect(publicInitialSchema).toContain(`CREATE TABLE public.${table}`);
    }
    const familyKeyPosition = publicInitialSchema.indexOf(
      'ADD CONSTRAINT family_config_family_id_key UNIQUE (family_id)'
    );
    for (const constraint of [
      'ADD CONSTRAINT circle_owner_recovery_claims_family_id_fkey FOREIGN KEY',
      'ADD CONSTRAINT circle_owner_changes_family_id_fkey FOREIGN KEY'
    ]) {
      expect(publicInitialSchema.indexOf(constraint)).toBeGreaterThan(familyKeyPosition);
    }
    expect(publicInitialSchema).toContain("ARRAY['voluntary_transfer'::text, 'server_admin_recovery'::text]");
  });

  it('contains Circle-local media routing settings without TURN credentials', () => {
    expect(publicInitialSchema).toContain('CREATE TABLE public.circle_media_routing_settings');
    expect(publicInitialSchema).toContain("ARRAY['server_default'::text, 'fixed'::text]");
    expect(publicInitialSchema).toContain(
      'ADD CONSTRAINT fk_circle_media_routing_settings_family_config FOREIGN KEY'
    );
    expect(publicInitialSchema).not.toMatch(/circle_media_routing_settings[\s\S]{0,500}(credential|secret)/i);
  });

  it('stores versioned client media quality summaries with call diagnostics', () => {
    expect(publicInitialSchema).toContain('diagnostics_version integer');
    expect(publicInitialSchema).toContain('media_quality_summary jsonb');
    expect(publicInitialSchema).toContain('CREATE TABLE public.call_quality_daily');
    expect(publicInitialSchema).toContain('turn_cluster_id text NOT NULL');
    expect(publicInitialSchema).toContain('two_sided_calls_count integer DEFAULT 0 NOT NULL');
    expect(publicInitialSchema).toContain('relay_media_bytes_sent bigint DEFAULT 0 NOT NULL');
    expect(publicInitialSchema).toContain('relay_media_bytes_received bigint DEFAULT 0 NOT NULL');
    const dailyTable = publicInitialSchema.match(/CREATE TABLE public\.call_quality_daily \(([\s\S]*?)\n\);/)?.[1] || '';
    expect(dailyTable).not.toMatch(/call_session_id|identity_id|device_id|media_session_id/i);
  });

  it('keeps deterministic device-label conflict metadata', () => {
    expect(publicInitialSchema).toContain(
      "label_update_id character varying(128) DEFAULT ''::character varying NOT NULL"
    );
  });

  it('stores profile backups by Circle secret namespace and device slot', () => {
    const backupTable = publicInitialSchema.match(
      /CREATE TABLE public\.identity_backups \(([\s\S]*?)\n\);/
    )?.[1] || '';
    expect(backupTable).toContain('backup_slot_id character varying NOT NULL');
    expect(backupTable).toContain('lookup_secret_hash character varying NOT NULL');
    expect(backupTable).toContain('last_uploader_identity_id character varying NOT NULL');
    expect(publicInitialSchema).toContain(
      'identity_backups_namespace_slot_uniq UNIQUE (family_id, lookup_secret_hash, backup_slot_id)'
    );
    expect(publicInitialSchema).not.toContain('identity_backups_identity_device_uniq');
  });

  it('contains channel attachments and public publication assets', () => {
    expect(publicInitialSchema).toContain(
      "ARRAY['direct'::character varying, 'group'::character varying, 'channel'::character varying]"
    );
    expect(publicInitialSchema).toContain('CREATE TABLE public.circle_site_publication_assets');
    for (const name of [
      'idx_circle_site_publication_assets_publication',
      'idx_circle_site_publication_assets_status',
      'fk_circle_site_publication_assets_family',
      'fk_circle_site_publication_assets_publication',
      'fk_circle_site_publication_assets_uploader',
      'idx_circle_site_publication_assets_channel_post',
      'fk_circle_site_publication_assets_channel_post',
      'site_image_slot text',
      'site_image_channel_id text',
      'check_circle_site_publication_assets_source',
      'idx_circle_site_publication_assets_site_image',
      'fk_circle_site_publication_assets_site_image_channel'
    ]) {
      expect(publicInitialSchema).toContain(name);
    }
  });

  it('keeps server-backed attachments as an independent guest-link capability', () => {
    expect(publicInitialSchema).toContain(
      'can_message OR can_call OR can_direct_file_transfer OR can_server_attachments OR auto_subscribe_to_channel'
    );
  });

  it('contains channel push fan-out, engagement cursors, and disclosure policy', () => {
    for (const fragment of [
      'announcement_channel_push_outbox',
      'cursor_identity_id',
      'idx_announcement_channel_push_outbox_ready',
      'idx_announcement_channel_subscriptions_received_cursor',
      'idx_announcement_channel_subscriptions_read_cursor',
      'disclose_server_admin_status boolean DEFAULT false NOT NULL'
    ]) {
      expect(publicInitialSchema).toContain(fragment);
    }
  });
});
