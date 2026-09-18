--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: set_call_session_expiration(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_call_session_expiration() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    CASE NEW.state
        WHEN 'new', 'ringing' THEN
            NEW.expires_at = NOW() + INTERVAL '60 seconds';
        WHEN 'accepted', 'connecting' THEN
            NEW.expires_at = NOW() + INTERVAL '120 seconds';
        WHEN 'active' THEN
            NEW.expires_at = NULL;
        ELSE
            NEW.expires_at = NULL;
    END CASE;
    RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: attachment_blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachment_blobs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    blob_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    uploader_identity_id character varying(255) NOT NULL,
    chat_type character varying(20),
    chat_id character varying(255),
    sender_identity_id character varying(255),
    linked_message_id character varying(255),
    original_file_name text NOT NULL,
    mime_type text,
    plaintext_size_bytes bigint NOT NULL,
    ciphertext_size_bytes bigint DEFAULT 0 NOT NULL,
    plaintext_sha256 character varying(64),
    storage_key text NOT NULL,
    status character varying(32) NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    committed_at timestamp without time zone,
    deleted_at timestamp without time zone,
    deleted_by_identity_id character varying(255),
    delete_reason character varying(32),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachment_blobs_chat_type_check CHECK (((chat_type)::text = ANY ((ARRAY['direct'::character varying, 'group'::character varying, 'channel'::character varying])::text[]))),
    CONSTRAINT attachment_blobs_delete_reason_check CHECK (((delete_reason)::text = ANY ((ARRAY['user_request'::character varying, 'expired'::character varying, 'failed_commit'::character varying, 'admin_delete'::character varying])::text[]))),
    CONSTRAINT attachment_blobs_status_check CHECK (((status)::text = ANY ((ARRAY['reserved'::character varying, 'uploaded'::character varying, 'committed'::character varying, 'pending_delete'::character varying, 'deleted'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: attachment_upload_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachment_upload_reservations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    reservation_id character varying(255) NOT NULL,
    blob_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    uploader_identity_id character varying(255) NOT NULL,
    upload_token_hash character varying(64) NOT NULL,
    plaintext_size_bytes bigint NOT NULL,
    ciphertext_size_bytes bigint,
    status character varying(32) NOT NULL,
    reserved_until timestamp without time zone NOT NULL,
    uploaded_at timestamp without time zone,
    committed_at timestamp without time zone,
    released_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachment_upload_reservations_status_check CHECK (((status)::text = ANY ((ARRAY['reserved'::character varying, 'uploading'::character varying, 'uploaded'::character varying, 'committed'::character varying, 'released'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: call_device_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_device_sync (
    family_id uuid NOT NULL,
    device_id text NOT NULL,
    last_call_history_sync_at bigint DEFAULT 0 NOT NULL
);


--
-- Name: call_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_links (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    call_link_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    target_identity_id character varying(255) NOT NULL,
    created_by character varying(255) NOT NULL,
    secret_hash character varying(64) NOT NULL,
    title character varying(120),
    suggest_join_after_call boolean DEFAULT false NOT NULL,
    join_invite_id character varying(255),
    direct_guest_link_id text,
    join_invite_token character varying(255),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp without time zone,
    revoked_at timestamp without time zone,
    capability_id text,
    capability_public_key text,
    capability_mode text,
    capability_descriptor jsonb,
    capability_revocation jsonb,
    encrypted_secret jsonb,
    claimed_by_identity_id text,
    claimed_by_public_key_algorithm text,
    claimed_by_public_key_value text,
    CONSTRAINT call_links_capability_mode_check CHECK (((capability_mode IS NULL) OR (capability_mode = ANY (ARRAY['single-use'::text, 'unlimited'::text])))),
    CONSTRAINT call_links_claimed_identity_check CHECK ((((claimed_by_identity_id IS NULL) AND (claimed_by_public_key_algorithm IS NULL) AND (claimed_by_public_key_value IS NULL)) OR ((claimed_by_identity_id IS NOT NULL) AND (claimed_by_public_key_algorithm = 'ed25519'::text) AND (claimed_by_public_key_value IS NOT NULL)))),
    CONSTRAINT call_links_one_attached_invitation CHECK (((join_invite_id IS NULL) OR (direct_guest_link_id IS NULL))),
    CONSTRAINT call_links_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: TABLE call_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.call_links IS 'Secret-protected short links for direct calls';


--
-- Name: COLUMN call_links.secret_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.call_links.secret_hash IS 'SHA-256 hash of link secret';


--
-- Name: call_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_logs (
    call_session_id text NOT NULL,
    family_id uuid NOT NULL,
    initiator_identity_id text NOT NULL,
    target_identity_id text NOT NULL,
    is_temporary_link_call boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    connected_at bigint,
    media_connected_at bigint,
    ended_at bigint,
    final_status text DEFAULT 'ringing'::text NOT NULL,
    final_reason text,
    duration_seconds integer,
    last_updated_at bigint NOT NULL,
    last_heartbeat_at bigint,
    missed_seen_at bigint,
    external_initiator_public_key jsonb,
    call_link_title text
);


--
-- Name: call_quality_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_quality_daily (
    family_id uuid NOT NULL,
    day_start_ms bigint NOT NULL,
    turn_cluster_id text NOT NULL,
    calls_count integer DEFAULT 0 NOT NULL,
    reports_count integer DEFAULT 0 NOT NULL,
    two_sided_calls_count integer DEFAULT 0 NOT NULL,
    relay_calls_count integer DEFAULT 0 NOT NULL,
    relay_reports_count integer DEFAULT 0 NOT NULL,
    sample_count bigint DEFAULT 0 NOT NULL,
    reconnect_count bigint DEFAULT 0 NOT NULL,
    reconnecting_reports_count integer DEFAULT 0 NOT NULL,
    rtt_reports_count integer DEFAULT 0 NOT NULL,
    rtt_average_ms double precision,
    rtt_maximum_ms double precision,
    jitter_reports_count integer DEFAULT 0 NOT NULL,
    jitter_average_ms double precision,
    jitter_maximum_ms double precision,
    packets_lost bigint DEFAULT 0 NOT NULL,
    packets_received bigint DEFAULT 0 NOT NULL,
    outbound_bitrate_reports_count integer DEFAULT 0 NOT NULL,
    outbound_bitrate_average_kbps double precision,
    inbound_bitrate_reports_count integer DEFAULT 0 NOT NULL,
    inbound_bitrate_average_kbps double precision,
    traffic_reports_count integer DEFAULT 0 NOT NULL,
    relay_traffic_reports_count integer DEFAULT 0 NOT NULL,
    media_bytes_sent bigint DEFAULT 0 NOT NULL,
    media_bytes_received bigint DEFAULT 0 NOT NULL,
    relay_media_bytes_sent bigint DEFAULT 0 NOT NULL,
    relay_media_bytes_received bigint DEFAULT 0 NOT NULL,
    freeze_count bigint DEFAULT 0 NOT NULL,
    reports_with_freezes_count integer DEFAULT 0 NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: call_handling_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_handling_events (
    event_id bigserial NOT NULL,
    call_session_id text NOT NULL,
    identity_id text NOT NULL,
    device_id text NOT NULL,
    family_id uuid NOT NULL,
    event_type text NOT NULL,
    reason_code text,
    occurred_at bigint NOT NULL,
    recorded_at bigint NOT NULL
);


--
-- Name: call_client_diagnostics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_client_diagnostics (
    call_session_id text NOT NULL,
    identity_id text NOT NULL,
    device_id text NOT NULL,
    family_id uuid NOT NULL,
    final_connection_state text,
    final_ice_connection_state text,
    ever_connected boolean DEFAULT false NOT NULL,
    reached_reconnecting boolean DEFAULT false NOT NULL,
    security_verified boolean,
    selected_candidate_pair jsonb,
    phase_history jsonb,
    end_reason text,
    runtime_metadata jsonb,
    diagnostics_version integer,
    media_quality_summary jsonb,
    recorded_at bigint NOT NULL
);


--
-- Name: call_ice_diagnostics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_ice_diagnostics (
    call_session_id text NOT NULL,
    identity_id text NOT NULL,
    family_id uuid NOT NULL,
    total_candidates integer DEFAULT 0 NOT NULL,
    relay_candidates integer DEFAULT 0 NOT NULL,
    srflx_candidates integer DEFAULT 0 NOT NULL,
    host_candidates integer DEFAULT 0 NOT NULL,
    prflx_candidates integer DEFAULT 0 NOT NULL,
    udp_candidates integer DEFAULT 0 NOT NULL,
    tcp_candidates integer DEFAULT 0 NOT NULL,
    recorded_at bigint NOT NULL
);


--
-- Name: circle_inspector_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_inspector_requests (
    request_id text NOT NULL,
    family_id uuid,
    request_token_hash text NOT NULL,
    viewer_label text,
    status text DEFAULT 'pending'::text NOT NULL,
    approved_by_identity_id text,
    approved_by_device_id text,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    approved_at bigint,
    CONSTRAINT circle_inspector_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text])))
);


--
-- Name: circle_inspector_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_inspector_sessions (
    session_id text NOT NULL,
    family_id uuid NOT NULL,
    request_id text,
    session_token_hash text NOT NULL,
    session_token_handoff text,
    approved_by_identity_id text,
    approved_by_device_id text,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    last_used_at bigint,
    revoked_at bigint,
    revoked_by_identity_id text
);


--
-- Name: call_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_sessions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    call_session_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    participants text[] NOT NULL,
    initiator character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    accepted_at timestamp without time zone,
    ended_at timestamp without time zone,
    state character varying(20) DEFAULT 'new'::character varying NOT NULL,
    sdp_offer text,
    sdp_answer text,
    ice_candidates jsonb DEFAULT '[]'::jsonb,
    expires_at timestamp without time zone,
    CONSTRAINT call_sessions_state_check CHECK (((state)::text = ANY ((ARRAY['new'::character varying, 'ringing'::character varying, 'accepted'::character varying, 'connecting'::character varying, 'active'::character varying, 'ended'::character varying, 'failed'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: TABLE call_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.call_sessions IS 'WebRTC call sessions';


--
-- Name: COLUMN call_sessions.family_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.call_sessions.family_id IS 'Family/tenant identifier for multi-tenancy isolation';


--
-- Name: call_whitelist_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_whitelist_entries (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    family_id uuid NOT NULL,
    owner_identity_id character varying(255) NOT NULL,
    external_identity_id character varying(255) NOT NULL,
    external_public_key_algorithm character varying(50) NOT NULL,
    external_public_key_value text NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT call_whitelist_entries_external_public_key_algorithm_check CHECK (((external_public_key_algorithm)::text = ANY ((ARRAY['ed25519'::character varying, 'x25519'::character varying])::text[]))),
    CONSTRAINT call_whitelist_entries_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying])::text[])))
);


--
-- Name: TABLE call_whitelist_entries; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.call_whitelist_entries IS 'External callers allowed by each local user';


--
-- Name: circle_file_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_file_access (
    access_id text DEFAULT (gen_random_uuid())::text NOT NULL,
    family_id uuid NOT NULL,
    blob_id text NOT NULL,
    granted_at timestamp without time zone DEFAULT now() NOT NULL,
    purpose text DEFAULT 'avatar'::text NOT NULL
);


--
-- Name: TABLE circle_file_access; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.circle_file_access IS 'Tracks which circle (family) owns each file blob. Decoupled from chat/message system.';


--
-- Name: circle_site_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_site_publications (
    publication_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    family_id uuid NOT NULL,
    channel_id text NOT NULL,
    source_link_id text,
    source_channel_post_id text NOT NULL,
    author_identity_id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    summary text,
    body text NOT NULL,
    body_format text DEFAULT 'markdown'::text NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    published_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_circle_site_publications_body_format CHECK ((body_format = ANY (ARRAY['plain_text'::text, 'markdown'::text]))),
    CONSTRAINT check_circle_site_publications_body_len CHECK ((char_length(body) <= 50000)),
    CONSTRAINT check_circle_site_publications_body_not_empty CHECK ((TRIM(BOTH FROM body) <> ''::text)),
    CONSTRAINT check_circle_site_publications_slug_format CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT check_circle_site_publications_slug_not_empty CHECK ((TRIM(BOTH FROM slug) <> ''::text)),
    CONSTRAINT check_circle_site_publications_status CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'unpublished'::text, 'deleted'::text]))),
    CONSTRAINT check_circle_site_publications_summary_len CHECK (((summary IS NULL) OR (char_length(summary) <= 500))),
    CONSTRAINT check_circle_site_publications_title_len CHECK ((char_length(title) <= 200)),
    CONSTRAINT check_circle_site_publications_title_not_empty CHECK ((TRIM(BOTH FROM title) <> ''::text))
);

CREATE TABLE public.circle_site_publication_assets (
    asset_id text NOT NULL,
    family_id uuid NOT NULL,
    publication_id uuid,
    source_channel_post_id text,
    site_image_slot text,
    site_image_channel_id text,
    uploader_identity_id text NOT NULL,
    kind text NOT NULL,
    original_file_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    width integer,
    height integer,
    alt_text text,
    storage_key text NOT NULL,
    upload_token_hash text,
    reserved_until timestamp without time zone,
    status text DEFAULT 'reserved'::text NOT NULL,
    uploaded_at timestamp without time zone,
    published_at timestamp without time zone,
    deleted_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_circle_site_publication_assets_alt CHECK (((alt_text IS NULL) OR (char_length(alt_text) <= 500))),
    CONSTRAINT check_circle_site_publication_assets_dimensions CHECK ((((width IS NULL) OR (width > 0)) AND ((height IS NULL) OR (height > 0)))),
    CONSTRAINT check_circle_site_publication_assets_kind CHECK ((kind = ANY (ARRAY['image'::text, 'download'::text]))),
    CONSTRAINT check_circle_site_publication_assets_source CHECK ((((source_channel_post_id IS NOT NULL) AND (site_image_slot IS NULL) AND (site_image_channel_id IS NULL)) OR ((source_channel_post_id IS NULL) AND (publication_id IS NULL) AND (kind = 'image'::text) AND (((site_image_slot = 'cover'::text) AND (site_image_channel_id IS NULL)) OR ((site_image_slot = 'channel_intro'::text) AND (site_image_channel_id IS NOT NULL)))))),
    CONSTRAINT check_circle_site_publication_assets_size CHECK ((size_bytes > 0)),
    CONSTRAINT check_circle_site_publication_assets_status CHECK ((status = ANY (ARRAY['reserved'::text, 'ready'::text, 'published'::text, 'deleted'::text])))
);


--
-- Name: circle_site_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_site_settings (
    family_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    indexing_enabled boolean DEFAULT false NOT NULL,
    site_title text,
    site_description text,
    cover_image_url text,
    theme text DEFAULT 'default'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_circle_site_settings_site_description_len CHECK (((site_description IS NULL) OR (char_length(site_description) <= 2000))),
    CONSTRAINT check_circle_site_settings_site_title_len CHECK (((site_title IS NULL) OR (char_length(site_title) <= 200))),
    CONSTRAINT check_circle_site_settings_theme CHECK ((theme = 'default'::text))
);


--
-- Name: circle_media_routing_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_media_routing_settings (
    family_id uuid NOT NULL,
    strategy text DEFAULT 'server_default'::text NOT NULL,
    turn_cluster_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_circle_media_routing_settings_cluster_id CHECK ((((strategy = 'server_default'::text) AND (turn_cluster_id IS NULL)) OR ((strategy = 'fixed'::text) AND (turn_cluster_id IS NOT NULL) AND (turn_cluster_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'::text)))),
    CONSTRAINT check_circle_media_routing_settings_strategy CHECK ((strategy = ANY (ARRAY['server_default'::text, 'fixed'::text])))
);


--
-- Name: device_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    enrollment_id text NOT NULL,
    requested_contact text,
    new_device_id text,
    new_device_public_key_algorithm text,
    new_device_public_key_value text,
    origin text,
    origin_verified boolean DEFAULT false NOT NULL,
    request_ip text,
    request_user_agent text,
    state text NOT NULL,
    encrypted_temporary_membership text,
    cipher text,
    approved_by_device_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    access_mode text DEFAULT 'temporary'::text NOT NULL,
    enrollment_expires_at timestamp with time zone,
    payload_expires_at timestamp with time zone,
    temporary_access_expires_at timestamp with time zone,
    approved_at timestamp with time zone,
    consumed_at timestamp with time zone,
    delivered_at timestamp with time zone,
    activated_at timestamp with time zone,
    requested_trusted_device_id text,
    requested_identity_id text,
    new_device_ciphertext text,
    new_device_cipher text,
    trusted_read_at timestamp with time zone,
    new_device_encryption_public_key_algorithm text,
    new_device_encryption_public_key_value text,
    bootstrap_commitment text,
    bootstrap_payload jsonb,
    enrollment_kind text DEFAULT 'qr'::text NOT NULL,
    platform_recovery_binding_id text,
    platform_recovery_request jsonb,
    platform_recovery_proof jsonb,
    approval_sender_public_key_algorithm text,
    approval_sender_public_key_value text,
    CONSTRAINT check_device_enrollment_bootstrap_pair CHECK (((bootstrap_commitment IS NULL) AND (bootstrap_payload IS NULL)) OR ((bootstrap_commitment IS NOT NULL) AND (bootstrap_payload IS NOT NULL))),
    CONSTRAINT device_enrollments_access_mode_check CHECK ((access_mode = ANY (ARRAY['temporary'::text, 'full_circle'::text]))),
    CONSTRAINT device_enrollments_approval_sender_algorithm_check CHECK (((approval_sender_public_key_algorithm IS NULL) OR (approval_sender_public_key_algorithm = 'ed25519'::text))),
    CONSTRAINT device_enrollments_kind_check CHECK ((enrollment_kind = ANY (ARRAY['qr'::text, 'platform_recovery'::text]))),
    CONSTRAINT device_enrollments_new_device_encryption_public_key_algor_check CHECK (((new_device_encryption_public_key_algorithm IS NULL) OR (new_device_encryption_public_key_algorithm = 'x25519'::text))),
    CONSTRAINT device_enrollments_new_device_key_algorithm_check CHECK ((new_device_public_key_algorithm = ANY (ARRAY['ed25519'::text, 'x25519'::text]))),
    CONSTRAINT device_enrollments_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'pending_origin_check'::text, 'pending_trusted_read'::text, 'pending_trusted_approval'::text, 'approved'::text, 'consumed'::text, 'activated'::text, 'rejected'::text, 'expired'::text])))
);


--
-- Name: platform_recovery_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_recovery_bindings (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    family_id uuid NOT NULL,
    identity_id text NOT NULL,
    binding_id text NOT NULL,
    recovery_slot text NOT NULL,
    binding jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT platform_recovery_bindings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT platform_recovery_bindings_slot_check CHECK ((recovery_slot = ANY (ARRAY['android_google_restore_v1'::text, 'ios_icloud_synced_key_v1'::text]))),
    CONSTRAINT platform_recovery_bindings_family_binding_key UNIQUE (family_id, binding_id)
);


--
-- Name: device_notification_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_notification_bindings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    family_id uuid NOT NULL,
    web_device_id character varying(255) NOT NULL,
    mobile_endpoint_id character varying(255),
    route character varying(20) DEFAULT 'mobile_push'::character varying NOT NULL,
    bound_web_origin text,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    bound_at timestamp without time zone DEFAULT now() NOT NULL,
    unbound_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    mobile_endpoint_ref character varying(255),
    delivery_token text,
    delivery_token_expires_at timestamp without time zone,
    push_encryption_public_key text,
    native_message_preview_mode text DEFAULT 'off'::text NOT NULL,
    CONSTRAINT device_notification_bindings_native_message_preview_mode_check CHECK ((native_message_preview_mode = ANY (ARRAY['off'::text, 'after_unlock'::text, 'always'::text]))),
    CONSTRAINT device_notification_bindings_route_check CHECK (((route)::text = ANY ((ARRAY['web_push'::character varying, 'mobile_push'::character varying])::text[]))),
    CONSTRAINT device_notification_bindings_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'revoked'::character varying])::text[])))
);


--
-- Name: deleted_circle_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deleted_circle_domains (
    host text NOT NULL,
    family_id uuid NOT NULL,
    public_base_url text NOT NULL,
    extra_trusted_client_origins text[] DEFAULT '{}'::text[] NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_deleted_circle_domains_host_not_empty CHECK ((TRIM(BOTH FROM host) <> ''::text)),
    CONSTRAINT check_deleted_circle_domains_public_base_url_not_empty CHECK ((TRIM(BOTH FROM public_base_url) <> ''::text))
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    device_id character varying(255) NOT NULL,
    identity_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    public_key_algorithm character varying(50) NOT NULL,
    public_key_value text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp without time zone,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    label character varying(80),
    label_update_id character varying(128) DEFAULT ''::character varying NOT NULL,
    web_origin text,
    encrypted_physical_device_id jsonb,
    encryption_public_key_algorithm character varying(50),
    encryption_public_key_value text,
    registration_attestation jsonb,
    inactivity_warning_sent_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_reason text,
    CONSTRAINT devices_active_modern_key_material_check CHECK ((((status)::text <> 'active'::text) OR (((public_key_algorithm)::text = 'ed25519'::text) AND ((encryption_public_key_algorithm)::text = 'x25519'::text) AND (encryption_public_key_value IS NOT NULL) AND (btrim(encryption_public_key_value) <> ''::text) AND (registration_attestation IS NOT NULL) AND COALESCE((jsonb_typeof(registration_attestation) = 'object'::text), false) AND COALESCE(((registration_attestation ->> 'version'::text) = '1'::text), false) AND COALESCE((jsonb_typeof((registration_attestation -> 'identitySignedRequest'::text)) = 'object'::text), false) AND COALESCE((jsonb_typeof((registration_attestation -> 'deviceKeyBinding'::text)) = 'object'::text), false)))),
    CONSTRAINT devices_encryption_public_key_algorithm_check CHECK (((encryption_public_key_algorithm IS NULL) OR ((encryption_public_key_algorithm)::text = 'x25519'::text))),
    CONSTRAINT devices_public_key_algorithm_check CHECK (((public_key_algorithm)::text = ANY ((ARRAY['ed25519'::character varying, 'x25519'::character varying])::text[]))),
    CONSTRAINT devices_revoked_reason_check CHECK (((revoked_reason IS NULL) OR (revoked_reason = ANY (ARRAY['manual'::text, 'inactivity'::text])))),
    CONSTRAINT devices_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying])::text[])))
);


--
-- Name: server_device_lifecycle_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_device_lifecycle_policy (
    singleton_key boolean DEFAULT true NOT NULL,
    review_after_days integer DEFAULT 60 NOT NULL,
    auto_revoke_enabled boolean DEFAULT false NOT NULL,
    auto_revoke_after_days integer DEFAULT 180 NOT NULL,
    warning_days integer DEFAULT 7 NOT NULL,
    updated_by_server_admin_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT server_device_lifecycle_policy_auto_revoke_after_days_check CHECK (((auto_revoke_after_days >= 30) AND (auto_revoke_after_days <= 3650))),
    CONSTRAINT server_device_lifecycle_policy_check CHECK ((review_after_days < auto_revoke_after_days)),
    CONSTRAINT server_device_lifecycle_policy_check1 CHECK ((warning_days < auto_revoke_after_days)),
    CONSTRAINT server_device_lifecycle_policy_review_after_days_check CHECK (((review_after_days >= 7) AND (review_after_days <= 3650))),
    CONSTRAINT server_device_lifecycle_policy_singleton_key_check CHECK (singleton_key),
    CONSTRAINT server_device_lifecycle_policy_warning_days_check CHECK (((warning_days >= 1) AND (warning_days <= 30)))
);


--
-- Name: TABLE devices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.devices IS 'User devices with device keys';


--
-- Name: COLUMN devices.family_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.devices.family_id IS 'Family/tenant identifier for multi-tenancy isolation';


--
-- Name: direct_chat_epoch_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_chat_epoch_keys (
    family_id uuid NOT NULL,
    direct_chat_id text NOT NULL,
    epoch integer NOT NULL,
    key_commitment text NOT NULL,
    proposer_identity_id text NOT NULL,
    proposer_device_id text,
    signed_epoch_transition jsonb,
    created_at bigint NOT NULL
);


--
-- Name: direct_chat_epoch_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_chat_epoch_state (
    family_id uuid NOT NULL,
    direct_chat_id text NOT NULL,
    current_epoch integer DEFAULT 1 NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: direct_chat_seq; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_chat_seq (
    family_id text NOT NULL,
    direct_chat_id text NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL
);


--
-- Name: direct_chat_key_envelopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_chat_key_envelopes (
    family_id uuid NOT NULL,
    direct_chat_id text NOT NULL,
    epoch integer NOT NULL,
    identity_id text NOT NULL,
    envelope_ciphertext text NOT NULL,
    publisher_identity_id text NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: direct_file_quick_receive_controls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_file_quick_receive_controls (
    sequence bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    control_id text NOT NULL,
    family_id uuid NOT NULL,
    issuer_identity_id text NOT NULL,
    recipient_identity_id text NOT NULL,
    issuer_device_id text NOT NULL,
    ciphertext text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT uq_direct_file_quick_receive_control UNIQUE (family_id, control_id)
);

CREATE INDEX idx_direct_file_quick_receive_controls_recipient
    ON public.direct_file_quick_receive_controls USING btree (family_id, recipient_identity_id, sequence);


--
-- Name: direct_guest_link_defaults; Type: TABLE; Schema: public; Owner: -
--


CREATE TABLE public.direct_guest_link_defaults (
    family_id uuid NOT NULL,
    host_identity_id text NOT NULL,
    presentation_title text,
    presentation_description text,
    presentation_image_url text,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: direct_guest_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_guest_links (
    link_id text NOT NULL,
    family_id uuid NOT NULL,
    host_identity_id text NOT NULL,
    created_by_identity_id text NOT NULL,
    secret_hash text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    title text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    revoked_at timestamp without time zone,
    can_message boolean DEFAULT false NOT NULL,
    can_call boolean DEFAULT false NOT NULL,
    can_direct_file_transfer boolean DEFAULT false NOT NULL,
    can_server_attachments boolean DEFAULT false NOT NULL,
    max_uses integer,
    encrypted_secret jsonb,
    capability_id text,
    capability_public_key text,
    capability_mode text,
    capability_descriptor jsonb,
    capability_revocation jsonb,
    expires_at timestamp with time zone,
    presentation_title text,
    presentation_description text,
    presentation_image_url text,
    host_can_message_guest boolean DEFAULT false NOT NULL,
    guest_can_message_host boolean DEFAULT false NOT NULL,
    host_can_call_guest boolean DEFAULT false NOT NULL,
    guest_can_call_host boolean DEFAULT false NOT NULL,
    host_can_direct_file_transfer_guest boolean DEFAULT false NOT NULL,
    guest_can_direct_file_transfer_host boolean DEFAULT false NOT NULL,
    host_can_server_attachments_guest boolean DEFAULT false NOT NULL,
    guest_can_server_attachments_host boolean DEFAULT false NOT NULL,
    auto_subscribe_to_channel boolean DEFAULT false NOT NULL,
    public_site_visible boolean DEFAULT false NOT NULL,
    public_site_channel_slug text,
    public_site_cta_label text,
    public_site_intro_title text,
    public_site_intro_text text,
    public_site_intro_image_url text,
    public_site_guest_link_url text,
    CONSTRAINT direct_guest_links_at_least_one_permission CHECK ((can_message OR can_call OR can_direct_file_transfer OR can_server_attachments OR auto_subscribe_to_channel)),
    CONSTRAINT direct_guest_links_capability_mode_check CHECK (((capability_mode IS NULL) OR (capability_mode = ANY (ARRAY['single-use'::text, 'unlimited'::text])))),
    CONSTRAINT direct_guest_links_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT check_direct_guest_links_public_site_channel_slug_format CHECK (((public_site_channel_slug IS NULL) OR (public_site_channel_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))),
    CONSTRAINT check_direct_guest_links_public_site_channel_slug_len CHECK (((public_site_channel_slug IS NULL) OR (char_length(public_site_channel_slug) <= 80))),
    CONSTRAINT check_direct_guest_links_public_site_cta_label_len CHECK (((public_site_cta_label IS NULL) OR (char_length(public_site_cta_label) <= 80))),
    CONSTRAINT check_direct_guest_links_public_site_guest_link_url_len CHECK (((public_site_guest_link_url IS NULL) OR (char_length(public_site_guest_link_url) <= 2000))),
    CONSTRAINT check_direct_guest_links_public_site_intro_image_url_len CHECK (((public_site_intro_image_url IS NULL) OR (char_length(public_site_intro_image_url) <= 1000))),
    CONSTRAINT check_direct_guest_links_public_site_intro_text_len CHECK (((public_site_intro_text IS NULL) OR (char_length(public_site_intro_text) <= 1200))),
    CONSTRAINT check_direct_guest_links_public_site_intro_title_len CHECK (((public_site_intro_title IS NULL) OR (char_length(public_site_intro_title) <= 160))),
    CONSTRAINT check_direct_guest_links_public_site_visible_has_slug CHECK (((NOT public_site_visible) OR (public_site_channel_slug IS NOT NULL)))
);

--
-- Name: COLUMN direct_guest_links.title; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.direct_guest_links.title IS 'Optional private management label. Never exposed through public guest-link APIs or used as a guest-visible invitation or channel title.';


--
-- Name: COLUMN direct_guest_links.presentation_title; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.direct_guest_links.presentation_title IS 'Optional guest-visible invitation title overriding the host default presentation.';


--
-- Name: direct_guest_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_guest_registrations (
    registration_id text NOT NULL,
    family_id uuid NOT NULL,
    link_id text NOT NULL,
    host_identity_id text NOT NULL,
    guest_identity_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    revoked_at timestamp without time zone,
    last_seen_at timestamp without time zone,
    can_message boolean DEFAULT false NOT NULL,
    can_call boolean DEFAULT false NOT NULL,
    can_direct_file_transfer boolean DEFAULT false NOT NULL,
    can_server_attachments boolean DEFAULT false NOT NULL,
    host_can_message_guest boolean DEFAULT false NOT NULL,
    guest_can_message_host boolean DEFAULT false NOT NULL,
    host_can_call_guest boolean DEFAULT false NOT NULL,
    guest_can_call_host boolean DEFAULT false NOT NULL,
    host_can_direct_file_transfer_guest boolean DEFAULT false NOT NULL,
    guest_can_direct_file_transfer_host boolean DEFAULT false NOT NULL,
    host_can_server_attachments_guest boolean DEFAULT false NOT NULL,
    guest_can_server_attachments_host boolean DEFAULT false NOT NULL,
    capability_id text,
    admission_claim jsonb,
    departure_proof jsonb,
    revocation_proof jsonb,
    CONSTRAINT direct_guest_registrations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'deleted_by_guest'::text, 'deleted_by_host'::text, 'promoted'::text])))
);

CREATE TABLE public.announcement_channels (
    channel_id text NOT NULL,
    family_id uuid NOT NULL,
    owner_identity_id text NOT NULL,
    title text NOT NULL,
    description text,
    members_can_subscribe boolean DEFAULT true NOT NULL,
    owner_guests_can_subscribe boolean DEFAULT false NOT NULL,
    other_guests_can_subscribe boolean DEFAULT false NOT NULL,
    visibility text DEFAULT 'circle'::text NOT NULL,
    content_mode text DEFAULT 'private_e2ee'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    disclose_server_admin_status boolean DEFAULT false NOT NULL,
    public_site_state text DEFAULT 'hidden'::text NOT NULL,
    public_site_visible boolean DEFAULT false NOT NULL,
    public_site_slug text,
    public_site_cta_label text,
    public_site_intro_title text,
    public_site_intro_text text,
    public_site_intro_image_url text,
    public_site_guest_link_id text,
    public_site_guest_link_url text,
    public_site_requested_by_identity_id text,
    public_site_requested_at timestamp without time zone,
    public_site_approved_by_identity_id text,
    public_site_approved_at timestamp without time zone,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    archived_at timestamp without time zone,
    deleted_at timestamp without time zone,
    key_epoch integer DEFAULT 1 NOT NULL,
    next_post_sequence bigint DEFAULT 1 NOT NULL,
    key_epoch_updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_announcement_channels_content_mode CHECK ((content_mode = ANY (ARRAY['private_e2ee'::text, 'public_plaintext'::text]))),
    CONSTRAINT check_announcement_channels_description CHECK (((description IS NULL) OR (char_length(description) <= 2000))),
    CONSTRAINT check_announcement_channels_public_guest_link_url CHECK (((public_site_guest_link_url IS NULL) OR (char_length(public_site_guest_link_url) <= 2000))),
    CONSTRAINT check_announcement_channels_public_plaintext CHECK (((content_mode <> 'public_plaintext'::text) OR (visibility = ANY (ARRAY['public'::text, 'circle'::text])))),
    CONSTRAINT check_announcement_channels_public_site_state CHECK ((public_site_state = ANY (ARRAY['hidden'::text, 'requested'::text, 'published'::text]))),
    CONSTRAINT check_announcement_channels_public_slug CHECK (((public_site_slug IS NULL) OR ((char_length(public_site_slug) <= 80) AND (public_site_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)))),
    CONSTRAINT check_announcement_channels_public_state CHECK ((((public_site_state = 'published'::text) = public_site_visible) AND ((public_site_state <> 'requested'::text) OR (public_site_requested_at IS NOT NULL)) AND ((public_site_state <> 'published'::text) OR (public_site_approved_at IS NOT NULL)))),
    CONSTRAINT check_announcement_channels_public_visible_slug CHECK (((NOT public_site_visible) OR (public_site_slug IS NOT NULL))),
    CONSTRAINT check_announcement_channels_status CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'deleted'::text]))),
    CONSTRAINT check_announcement_channels_title CHECK (((TRIM(BOTH FROM title) <> ''::text) AND (char_length(title) <= 160))),
    CONSTRAINT check_announcement_channels_visibility CHECK ((visibility = ANY (ARRAY['public'::text, 'circle'::text, 'guest_links'::text, 'explicit'::text])))
);


--
-- Name: COLUMN announcement_channels.title; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.announcement_channels.title IS 'Guest-visible channel title. Must never be derived from the private direct_guest_links.title management label.';


CREATE TABLE public.announcement_channel_links (
    family_id uuid NOT NULL,
    channel_id text NOT NULL,
    link_id text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


CREATE TABLE public.announcement_channel_subscriptions (
    subscription_id text NOT NULL,
    family_id uuid NOT NULL,
    channel_id text NOT NULL,
    subscriber_identity_id text NOT NULL,
    source_link_id text,
    notifications_enabled boolean DEFAULT true NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    subscribed_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    unsubscribed_at timestamp without time zone,
    removed_by_identity_id text,
    removed_at timestamp without time zone,
    last_received_sequence bigint,
    last_read_sequence bigint,
    key_status text DEFAULT 'pending'::text NOT NULL,
    subscription_claim jsonb,
    CONSTRAINT check_announcement_channel_subscription_cursors CHECK ((((last_received_sequence IS NULL) OR (last_received_sequence >= 0)) AND ((last_read_sequence IS NULL) OR (last_read_sequence >= 0)) AND ((last_received_sequence IS NULL) OR (last_read_sequence IS NULL) OR (last_read_sequence <= last_received_sequence)))),
    CONSTRAINT check_announcement_channel_subscription_key_status CHECK ((key_status = ANY (ARRAY['pending'::text, 'ready'::text]))),
    CONSTRAINT check_announcement_channel_subscriptions_status CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'unsubscribed'::text, 'removed_by_author'::text])))
);


CREATE TABLE public.announcement_channel_epoch_keys (
    family_id uuid NOT NULL,
    channel_id text NOT NULL,
    epoch integer NOT NULL,
    key_commitment text NOT NULL,
    proposer_identity_id text NOT NULL,
    proposer_device_id text NOT NULL,
    signed_epoch_transition jsonb NOT NULL,
    membership_state_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcement_channel_epoch_keys_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT announcement_channel_epoch_keys_key_commitment_check CHECK ((key_commitment ~ '^[a-f0-9]{64}$'::text))
);


CREATE TABLE public.announcement_channel_key_envelopes (
    family_id uuid NOT NULL,
    channel_id text NOT NULL,
    epoch integer NOT NULL,
    identity_id text NOT NULL,
    envelope_ciphertext text NOT NULL,
    publisher_identity_id text NOT NULL,
    membership_state_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcement_channel_key_envelopes_epoch_check CHECK ((epoch > 0))
);


CREATE TABLE public.announcement_channel_posts (
    post_id text NOT NULL,
    family_id uuid NOT NULL,
    channel_id text NOT NULL,
    post_sequence bigint NOT NULL,
    author_identity_id text NOT NULL,
    author_device_id text NOT NULL,
    client_post_id text NOT NULL,
    client_created_at bigint,
    epoch integer NOT NULL,
    ciphertext text NOT NULL,
    notification_preview_ciphertext text,
    author_signature text NOT NULL,
    author_signed_claim jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    edited_at timestamp without time zone,
    deleted_at timestamp without time zone,
    CONSTRAINT announcement_channel_posts_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT announcement_channel_posts_post_sequence_check CHECK ((post_sequence > 0)),
    CONSTRAINT announcement_channel_posts_revision_check CHECK ((revision > 0))
);


CREATE TABLE public.announcement_channel_push_outbox (
    post_id text NOT NULL,
    family_id uuid NOT NULL,
    channel_id text NOT NULL,
    author_identity_id text NOT NULL,
    cursor_identity_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp without time zone DEFAULT now() NOT NULL,
    locked_at timestamp without time zone,
    last_error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    CONSTRAINT announcement_channel_push_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT announcement_channel_push_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text])))
);


CREATE TABLE public.trusted_device_rekey_jobs (
    job_id text NOT NULL,
    family_id uuid NOT NULL,
    identity_id text NOT NULL,
    device_id text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    target_count integer DEFAULT 0 NOT NULL,
    completed_count integer DEFAULT 0 NOT NULL,
    available_at timestamp without time zone DEFAULT now() NOT NULL,
    locked_at timestamp without time zone,
    last_error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    CONSTRAINT trusted_device_rekey_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT trusted_device_rekey_jobs_completed_count_check CHECK (((completed_count >= 0) AND (completed_count <= target_count))),
    CONSTRAINT trusted_device_rekey_jobs_reason_check CHECK ((reason = ANY (ARRAY['device_revoked'::text, 'device_added'::text]))),
    CONSTRAINT trusted_device_rekey_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text]))),
    CONSTRAINT trusted_device_rekey_jobs_target_count_check CHECK ((target_count >= 0))
);


CREATE TABLE public.trusted_device_rekey_targets (
    job_id text NOT NULL,
    family_id uuid NOT NULL,
    target_type text NOT NULL,
    chat_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    rotated_epoch integer,
    completed_at timestamp without time zone,
    CONSTRAINT trusted_device_rekey_targets_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text]))),
    CONSTRAINT trusted_device_rekey_targets_target_type_check CHECK ((target_type = ANY (ARRAY['group'::text, 'direct'::text])))
);


-- Name: family_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_config (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    family_id uuid NOT NULL,
    circle_id text DEFAULT ('c_'::text || SUBSTRING(replace((public.uuid_generate_v4())::text, '-'::text, ''::text) FROM 1 FOR 24)) NOT NULL,
    server_name character varying(255) NOT NULL,
    first_owner_invite_token character varying(255),
    no_names_on_server boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    public_base_url text NOT NULL,
    message_ttl_hours integer DEFAULT 24 NOT NULL,
    extra_trusted_client_origins text[] DEFAULT '{}'::text[] NOT NULL,
    attachments_enabled boolean DEFAULT false NOT NULL,
    max_attachment_file_size_bytes bigint,
    attachment_storage_quota_bytes bigint,
    attachment_retention_seconds integer,
    used_attachment_storage_bytes bigint DEFAULT 0 NOT NULL,
    reserved_attachment_storage_bytes bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    owner_identity_id text,
    created_by_server_admin_id text,
    claimed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    join_invite_id text,
    chat_epoch_rotation_interval_hours integer DEFAULT 168 NOT NULL,
    chat_epoch_key_retention_hours integer DEFAULT 720 NOT NULL,
    message_archive_server_policy character varying DEFAULT 'text'::character varying NOT NULL,
    message_archive_server_max_bytes bigint,
    message_archive_circle_policy character varying DEFAULT 'text'::character varying NOT NULL,
    message_archive_circle_max_bytes bigint,
    members_can_use_guest_server_attachments boolean DEFAULT true NOT NULL,
    max_member_identities integer,
    max_total_identities integer,
    CONSTRAINT check_server_name_not_empty CHECK ((TRIM(BOTH FROM server_name) <> ''::text)),
    CONSTRAINT family_config_circle_id_format_check CHECK ((length(TRIM(BOTH FROM circle_id)) >= 12)),
    CONSTRAINT family_config_attachment_counters_check CHECK (((used_attachment_storage_bytes >= 0) AND (reserved_attachment_storage_bytes >= 0))),
    CONSTRAINT family_config_attachment_file_size_check CHECK (((max_attachment_file_size_bytes IS NULL) OR (max_attachment_file_size_bytes >= 1))),
    CONSTRAINT family_config_attachment_retention_check CHECK (((attachment_retention_seconds IS NULL) OR (attachment_retention_seconds >= 60))),
    CONSTRAINT family_config_attachment_storage_quota_check CHECK (((attachment_storage_quota_bytes IS NULL) OR (attachment_storage_quota_bytes >= 1))),
    CONSTRAINT family_config_chat_epoch_key_retention_hours_check CHECK (((chat_epoch_key_retention_hours >= 1) AND (chat_epoch_key_retention_hours <= (24 * 365)))),
    CONSTRAINT family_config_chat_epoch_rotation_interval_hours_check CHECK (((chat_epoch_rotation_interval_hours >= 1) AND (chat_epoch_rotation_interval_hours <= (24 * 365)))),
    CONSTRAINT family_config_message_archive_circle_max_bytes_check CHECK (((message_archive_circle_max_bytes IS NULL) OR (message_archive_circle_max_bytes >= 1))),
    CONSTRAINT family_config_message_archive_circle_max_within_server_check CHECK (((message_archive_server_max_bytes IS NULL) OR (message_archive_circle_max_bytes IS NULL) OR (message_archive_circle_max_bytes <= message_archive_server_max_bytes))),
    CONSTRAINT family_config_message_archive_circle_policy_check CHECK (((message_archive_circle_policy)::text = ANY ((ARRAY['disabled'::character varying, 'text'::character varying, 'text_with_attachments'::character varying])::text[]))),
    CONSTRAINT family_config_message_archive_circle_within_server_check CHECK ((
CASE message_archive_circle_policy
    WHEN 'disabled'::text THEN 0
    WHEN 'text'::text THEN 1
    WHEN 'text_with_attachments'::text THEN 2
    ELSE 0
END <=
CASE message_archive_server_policy
    WHEN 'disabled'::text THEN 0
    WHEN 'text'::text THEN 1
    WHEN 'text_with_attachments'::text THEN 2
    ELSE 0
END)),
    CONSTRAINT family_config_message_archive_server_max_bytes_check CHECK (((message_archive_server_max_bytes IS NULL) OR (message_archive_server_max_bytes >= 1))),
    CONSTRAINT family_config_message_archive_server_policy_check CHECK (((message_archive_server_policy)::text = ANY ((ARRAY['disabled'::character varying, 'text'::character varying, 'text_with_attachments'::character varying])::text[]))),
    CONSTRAINT family_config_message_ttl_hours_check CHECK (((message_ttl_hours >= 1) AND (message_ttl_hours <= (24 * 365)))),
    CONSTRAINT family_config_max_member_identities_positive CHECK (((max_member_identities IS NULL) OR (max_member_identities >= 1))),
    CONSTRAINT family_config_max_total_identities_positive CHECK (((max_total_identities IS NULL) OR (max_total_identities >= 1))),
    CONSTRAINT family_config_identity_quota_order CHECK (((max_member_identities IS NULL) OR (max_total_identities IS NULL) OR (max_total_identities >= max_member_identities))),
    CONSTRAINT family_config_status_check CHECK ((status = ANY (ARRAY['pending_owner'::text, 'pending_import'::text, 'active'::text, 'revoked'::text])))
);


--
-- Name: TABLE family_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.family_config IS 'Per-family configuration (server name, invite tokens, etc)';


--
-- Name: circle_membership_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_membership_states (
    family_id uuid NOT NULL,
    sequence bigint NOT NULL,
    state_id text NOT NULL,
    previous_state_id text,
    action text NOT NULL,
    subject_identity_id text,
    claim jsonb NOT NULL,
    admission jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT circle_membership_states_action_check CHECK ((action = ANY (ARRAY['genesis'::text, 'repair'::text, 'add'::text, 'remove'::text, 'restore'::text, 'transfer_owner'::text, 'set_invite_permission'::text]))),
    CONSTRAINT circle_membership_states_pkey PRIMARY KEY (family_id, sequence),
    CONSTRAINT circle_membership_states_family_state_id_key UNIQUE (family_id, state_id)
);

CREATE INDEX idx_circle_membership_states_family_created ON public.circle_membership_states USING btree (family_id, created_at);


--
-- E2EE Circle profile epochs and encrypted current profiles
--

CREATE TABLE public.circle_profile_epochs (
    family_id uuid NOT NULL,
    epoch integer NOT NULL,
    membership_state_id text NOT NULL,
    membership_sequence bigint NOT NULL,
    key_commitment text NOT NULL,
    claim jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT circle_profile_epochs_pkey PRIMARY KEY (family_id, epoch),
    CONSTRAINT circle_profile_epochs_commitment_key UNIQUE (family_id, key_commitment),
    CONSTRAINT circle_profile_epochs_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT circle_profile_epochs_sequence_check CHECK ((membership_sequence > 0))
);

CREATE TABLE public.circle_profile_epoch_envelopes (
    family_id uuid NOT NULL,
    epoch integer NOT NULL,
    recipient_identity_id text NOT NULL,
    publisher_identity_id text NOT NULL,
    membership_state_id text NOT NULL,
    key_commitment text NOT NULL,
    envelope_ciphertext text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT circle_profile_epoch_envelopes_pkey PRIMARY KEY (family_id, epoch, recipient_identity_id),
    CONSTRAINT circle_profile_epoch_envelopes_ciphertext_check CHECK ((length(envelope_ciphertext) <= 65536))
);

CREATE INDEX idx_circle_profile_epoch_envelopes_recipient ON public.circle_profile_epoch_envelopes USING btree (family_id, recipient_identity_id, epoch DESC);

CREATE TABLE public.circle_encrypted_identity_profiles (
    family_id uuid NOT NULL,
    owner_identity_id text NOT NULL,
    epoch integer NOT NULL,
    revision bigint NOT NULL,
    source_revision bigint,
    publication_id text NOT NULL,
    publication_kind text NOT NULL,
    ciphertext text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT circle_encrypted_identity_profiles_pkey PRIMARY KEY (family_id, owner_identity_id),
    CONSTRAINT circle_encrypted_identity_profiles_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT circle_encrypted_identity_profiles_revision_check CHECK ((revision > 0)),
    CONSTRAINT circle_encrypted_identity_profiles_source_revision_check CHECK (((source_revision IS NULL) OR (source_revision > 0))),
    CONSTRAINT circle_encrypted_identity_profiles_publication_id_check CHECK (((length(publication_id) >= 16) AND (length(publication_id) <= 160))),
    CONSTRAINT circle_encrypted_identity_profiles_publication_kind_check CHECK ((publication_kind = ANY (ARRAY['manual'::text, 'republish'::text]))),
    CONSTRAINT circle_encrypted_identity_profiles_ciphertext_check CHECK ((length(ciphertext) <= 131072))
);

CREATE INDEX idx_circle_encrypted_identity_profiles_epoch ON public.circle_encrypted_identity_profiles USING btree (family_id, epoch, updated_at DESC);


--
-- Name: family_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_domains (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    family_id uuid NOT NULL,
    host text NOT NULL,
    public_base_url text NOT NULL,
    role text DEFAULT 'primary'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    source text DEFAULT 'migration'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    verified_at timestamp without time zone,
    disabled_at timestamp without time zone,
    replaced_at timestamp without time zone,
    CONSTRAINT check_family_domains_host_not_empty CHECK ((TRIM(BOTH FROM host) <> ''::text)),
    CONSTRAINT check_family_domains_public_base_url_not_empty CHECK ((TRIM(BOTH FROM public_base_url) <> ''::text)),
    CONSTRAINT family_domains_role_check CHECK ((role = ANY (ARRAY['primary'::text, 'alias'::text, 'legacy'::text, 'pending'::text]))),
    CONSTRAINT family_domains_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending_verification'::text, 'disabled'::text, 'revoked'::text])))
);

--
-- Name: migration_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migration_slots (
    migration_slot_id text PRIMARY KEY,
    migration_code_hash text NOT NULL UNIQUE,
    migration_code_encrypted jsonb NOT NULL,
    migration_code_consumed_at timestamp with time zone,
    destination_circle_id text NOT NULL,
    source_circle_id text,
    target_public_base_url text NOT NULL,
    target_host text NOT NULL,
    service_endpoint text NOT NULL,
    server_name text NOT NULL,
    created_by_server_admin_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    limits jsonb DEFAULT '{}'::jsonb NOT NULL,
    migration_format_version integer NOT NULL,
    data_scope_fingerprint text NOT NULL,
    expected_family_id uuid,
    expected_owner_identity_id text,
    source_migration_id text,
    source_server_id text,
    source_server_url text,
    source_session_public_key jsonb,
    owner_identity_public_key jsonb,
    owner_signed_migration_intent jsonb,
    owner_signed_cutover_confirmation jsonb,
    source_schema_fingerprint text,
    destination_schema_fingerprint text NOT NULL,
    session_token_hash text,
    session_key_hash text,
    session_key_encrypted jsonb,
    session_key_envelope text,
    session_expires_at timestamp with time zone,
    imported_family_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    reserved_at timestamp with time zone,
    import_started_at timestamp with time zone,
    activated_at timestamp with time zone,
    revoked_at timestamp with time zone,
    failure_code text,
    failure_message text,
    import_manifest jsonb,
    import_report jsonb,
    activation_report jsonb,
    staging_path text,
    CONSTRAINT migration_slots_destination_circle_id_format_check CHECK ((length(TRIM(BOTH FROM destination_circle_id)) >= 12)),
    CONSTRAINT migration_slots_format_version_positive CHECK ((migration_format_version >= 1)),
    CONSTRAINT migration_slots_admin_idempotency_unique UNIQUE (created_by_server_admin_id, idempotency_key),
    CONSTRAINT migration_slots_server_name_not_empty CHECK ((TRIM(BOTH FROM server_name) <> ''::text)),
    CONSTRAINT migration_slots_service_endpoint_not_empty CHECK ((TRIM(BOTH FROM service_endpoint) <> ''::text)),
    CONSTRAINT migration_slots_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'reserved'::text, 'importing'::text, 'imported'::text, 'waiting_cutover'::text, 'activating'::text, 'active'::text, 'failed'::text, 'revoked'::text, 'expired'::text, 'aborted'::text]))),
    CONSTRAINT migration_slots_target_host_not_empty CHECK ((TRIM(BOTH FROM target_host) <> ''::text)),
    CONSTRAINT migration_slots_target_url_not_empty CHECK ((TRIM(BOTH FROM target_public_base_url) <> ''::text))
);


--
-- Name: circle_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_migrations (
    migration_id text PRIMARY KEY,
    family_id uuid NOT NULL,
    destination_service_endpoint text NOT NULL,
    destination_public_base_url text NOT NULL,
    migration_slot_id text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    started_by_identity_id text NOT NULL,
    destination_server_id text,
    data_scope_fingerprint text NOT NULL,
    session_credentials_encrypted jsonb,
    session_expires_at timestamp with time zone,
    preflight_summary jsonb,
    scheduled_at timestamp with time zone,
    members_notified_at timestamp with time zone,
    confirmed_data_loss jsonb,
    owner_signed_migration_intent jsonb,
    owner_signed_cutover_confirmation jsonb,
    manifest jsonb,
    export_snapshot_id text,
    last_progress_at timestamp with time zone,
    freeze_started_at timestamp with time zone,
    export_started_at timestamp with time zone,
    transfer_started_at timestamp with time zone,
    cutover_started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    failure_code text,
    failure_message text,
    CONSTRAINT circle_migrations_destination_endpoint_not_empty CHECK ((TRIM(BOTH FROM destination_service_endpoint) <> ''::text)),
    CONSTRAINT circle_migrations_destination_url_not_empty CHECK ((TRIM(BOTH FROM destination_public_base_url) <> ''::text)),
    CONSTRAINT circle_migrations_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'preflight'::text, 'ready'::text, 'scheduled'::text, 'freezing'::text, 'frozen'::text, 'exporting'::text, 'transferring'::text, 'waiting_import'::text, 'waiting_cutover'::text, 'cutover'::text, 'migrated'::text, 'failed'::text, 'rollback_required'::text, 'aborted'::text])))
);

--
-- Name: circle_migration_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_migration_events (
    event_id text PRIMARY KEY,
    migration_slot_id text,
    migration_id text,
    family_id uuid,
    event_type text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT circle_migration_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['server_admin'::text, 'circle_owner'::text, 'source_server'::text, 'destination_server'::text, 'system'::text]))),
    CONSTRAINT circle_migration_events_subject_check CHECK (((migration_slot_id IS NOT NULL) OR (migration_id IS NOT NULL)))
);


--
-- Name: family_migration_redirects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_migration_redirects (
    family_id uuid PRIMARY KEY,
    host text NOT NULL UNIQUE,
    moved_to text NOT NULL,
    source_server_id text NOT NULL,
    destination_server_id text NOT NULL,
    owner_identity_id text NOT NULL,
    owner_public_key jsonb NOT NULL,
    owner_signed_migration_proof jsonb NOT NULL,
    migrated_at timestamp with time zone NOT NULL,
    bridge_expires_at timestamp with time zone NOT NULL,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_migration_redirects_bridge_window CHECK ((bridge_expires_at > migrated_at)),
    CONSTRAINT family_migration_redirects_host_not_empty CHECK ((TRIM(BOTH FROM host) <> ''::text)),
    CONSTRAINT family_migration_redirects_target_not_empty CHECK ((TRIM(BOTH FROM moved_to) <> ''::text))
);

CREATE UNIQUE INDEX migration_slots_open_destination_circle_id_idx ON public.migration_slots USING btree (destination_circle_id) WHERE (status = ANY (ARRAY['pending'::text, 'verified'::text, 'reserved'::text, 'importing'::text, 'imported'::text, 'waiting_cutover'::text, 'activating'::text, 'active'::text, 'failed'::text]));
CREATE INDEX migration_slots_status_expires_idx ON public.migration_slots USING btree (status, expires_at);
CREATE INDEX migration_slots_expected_family_idx ON public.migration_slots USING btree (expected_family_id) WHERE (expected_family_id IS NOT NULL);
CREATE UNIQUE INDEX circle_migrations_open_family_idx ON public.circle_migrations USING btree (family_id) WHERE (status <> ALL (ARRAY['migrated'::text, 'aborted'::text]));
CREATE INDEX circle_migrations_status_progress_idx ON public.circle_migrations USING btree (status, last_progress_at);
CREATE INDEX circle_migration_events_slot_created_idx ON public.circle_migration_events USING btree (migration_slot_id, created_at);
CREATE INDEX circle_migration_events_source_created_idx ON public.circle_migration_events USING btree (migration_id, created_at);
CREATE INDEX family_migration_redirects_active_host_idx ON public.family_migration_redirects USING btree (host, bridge_expires_at) WHERE (disabled_at IS NULL);


--
-- Name: group_chat_epoch_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chat_epoch_keys (
    chat_id text NOT NULL,
    family_id uuid NOT NULL,
    epoch integer NOT NULL,
    key_commitment text NOT NULL,
    proposer_identity_id text NOT NULL,
    created_at bigint NOT NULL,
    proposer_device_id text,
    signed_epoch_transition jsonb,
    state_transition_id text,
    signed_state_transition jsonb
);


--
-- Name: group_chat_key_envelopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chat_key_envelopes (
    chat_id text NOT NULL,
    family_id uuid NOT NULL,
    epoch integer NOT NULL,
    identity_id text NOT NULL,
    envelope_ciphertext text NOT NULL,
    created_at bigint NOT NULL,
    publisher_identity_id text DEFAULT ''::text NOT NULL
);


--
-- Name: group_chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chat_messages (
    message_id text NOT NULL,
    family_id uuid NOT NULL,
    chat_id text NOT NULL,
    chat_seq bigint NOT NULL,
    sender_identity_id text,
    sender_device_id text,
    kind text NOT NULL,
    ciphertext text,
    notification_preview_ciphertext text,
    sender_signature text,
    client_message_id text,
    client_created_at bigint,
    created_at bigint NOT NULL,
    system_type text,
    system_payload_json text,
    epoch integer DEFAULT 1 NOT NULL,
    edited_at bigint,
    deleted_at bigint,
    content_updated_at bigint NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    temporary_identity_delegation jsonb,
    author_claim jsonb,
    CONSTRAINT group_chat_messages_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'system'::text])))
);


--
-- Name: group_chat_seq; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chat_seq (
    family_id text NOT NULL,
    chat_id text NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL
);


--
-- Name: group_chat_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chat_participants (
    chat_id text NOT NULL,
    family_id uuid NOT NULL,
    identity_id text NOT NULL,
    added_by_identity_id text NOT NULL,
    joined_at bigint NOT NULL,
    left_at bigint,
    is_active boolean DEFAULT true NOT NULL,
    join_order integer NOT NULL,
    muted boolean DEFAULT false NOT NULL
);


--
-- Name: group_chat_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chat_reads (
    chat_id text NOT NULL,
    family_id uuid NOT NULL,
    identity_id text NOT NULL,
    last_read_at bigint DEFAULT 0 NOT NULL
);


--
-- Name: group_chat_state_transitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chat_state_transitions (
    family_id uuid NOT NULL,
    chat_id text NOT NULL,
    sequence integer NOT NULL,
    transition_id text NOT NULL,
    previous_transition_id text,
    signed_transition jsonb NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: group_chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chats (
    chat_id text NOT NULL,
    family_id uuid NOT NULL,
    title_ciphertext text NOT NULL,
    owner_identity_id text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    last_message_at bigint,
    last_message_preview text,
    key_epoch integer DEFAULT 1 NOT NULL,
    key_epoch_updated_at bigint DEFAULT 0,
    protocol_version integer DEFAULT 1 NOT NULL,
    state_sequence integer,
    state_transition_id text,
    rekey_required_at bigint,
    rekey_required_reason text,
    rekey_required_identity_id text,
    CONSTRAINT group_chats_rekey_required_reason_check CHECK (((rekey_required_reason IS NULL) OR (rekey_required_reason = ANY (ARRAY['device_revoked'::text, 'device_added'::text]))))
);

COMMENT ON COLUMN public.group_chats.title_ciphertext IS 'Opaque gct1 encrypted title; plaintext group titles must never be stored';
COMMENT ON COLUMN public.group_chats.last_message_preview IS 'Non-content marker only; plaintext message previews must never be stored';


--
-- Name: identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identities (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    identity_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    public_key_algorithm character varying(50) NOT NULL,
    public_key_value text NOT NULL,
    encrypted_private_key jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    role character varying(20) DEFAULT 'member'::character varying,
    publish_identity boolean DEFAULT false NOT NULL,
    identity_name character varying(255),
    invite_quota integer DEFAULT 0 NOT NULL,
    invite_used integer DEFAULT 0 NOT NULL,
    can_create_invites boolean DEFAULT false NOT NULL,
    can_create_guest_invites boolean DEFAULT false NOT NULL,
    status_text character varying(280) DEFAULT NULL::character varying,
    status_updated_at timestamp without time zone,
    avatar_blob_id character varying(255) DEFAULT NULL::character varying,
    avatar_updated_at timestamp without time zone,
    presence_visible boolean DEFAULT true NOT NULL,
    presence_last_seen_at timestamp without time zone,
    admission_capability_id text,
    removed_at timestamp with time zone,
    removed_by_identity_id character varying(255),
    CONSTRAINT check_invite_quota_nonnegative CHECK ((invite_quota >= 0)),
    CONSTRAINT check_invite_used_lte_quota CHECK ((invite_used <= invite_quota)),
    CONSTRAINT check_invite_used_nonnegative CHECK ((invite_used >= 0)),
    CONSTRAINT identities_public_key_algorithm_check CHECK (((public_key_algorithm)::text = ANY ((ARRAY['ed25519'::character varying, 'x25519'::character varying])::text[]))),
    CONSTRAINT identities_role_check CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'member'::character varying, 'guest'::character varying])::text[]))),
    CONSTRAINT identities_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying, 'removed'::character varying])::text[])))
);


--
-- Name: TABLE identities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.identities IS 'User identities with public keys';


--
-- Name: COLUMN identities.family_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.identities.family_id IS 'Family/tenant identifier for multi-tenancy isolation';


--
-- Name: COLUMN identities.status_text; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.identities.status_text IS 'User-defined text status (max 280 chars, like Twitter)';


--
-- Name: COLUMN identities.status_updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.identities.status_updated_at IS 'Timestamp when status was last updated';


--
-- Name: COLUMN identities.avatar_blob_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.identities.avatar_blob_id IS 'Blob ID of the opaque E2EE avatar ciphertext';


--
-- Name: COLUMN identities.avatar_updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.identities.avatar_updated_at IS 'Timestamp when avatar was last changed';


--
-- Name: COLUMN identities.presence_visible; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.identities.presence_visible IS 'Whether this identity shares online/last-seen presence in this circle';


--
-- Name: COLUMN identities.presence_last_seen_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.identities.presence_last_seen_at IS 'Last explicit foreground presence heartbeat; separate from technical device activity';


--
-- Name: identity_backups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_backups (
    backup_id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    last_uploader_identity_id character varying NOT NULL,
    last_uploader_device_id character varying NOT NULL,
    backup_slot_id character varying NOT NULL,
    encrypted_backup jsonb NOT NULL,
    lookup_secret_hash character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: identity_read_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_read_cursors (
    family_id text NOT NULL,
    reader_identity_id text NOT NULL,
    peer_identity_id text NOT NULL,
    read_through bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    invite_id character varying(255) NOT NULL,
    token character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    created_by character varying(255) DEFAULT 'system'::character varying NOT NULL,
    title character varying(120),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_by_identity_id character varying(255),
    accepted_by_public_key text,
    accepted_identity_name character varying(255),
    accepted_at timestamp without time zone,
    max_uses integer DEFAULT 1 NOT NULL,
    used_count integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    capability_id text,
    capability_public_key text,
    capability_mode text,
    capability_descriptor jsonb,
    capability_revocation jsonb,
    encrypted_secret jsonb,
    encrypted_membership_checkpoint_bundle jsonb,
    CONSTRAINT check_used_count CHECK ((used_count <= max_uses)),
    CONSTRAINT invites_capability_mode_check CHECK (((capability_mode IS NULL) OR (capability_mode = ANY (ARRAY['single-use'::text, 'unlimited'::text])))),
    CONSTRAINT invites_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'expired'::character varying, 'exhausted'::character varying, 'revoked'::character varying])::text[])))
);


--
-- Name: TABLE invites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invites IS 'Registration invite tokens';


--
-- Name: COLUMN invites.family_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invites.family_id IS 'Family/tenant identifier for multi-tenancy isolation';


--
-- Name: invite_acceptances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invite_acceptances (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    invite_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    accepted_by_identity_id character varying(255) NOT NULL,
    accepted_by_public_key text,
    accepted_identity_name character varying(255),
    accepted_at timestamp without time zone DEFAULT now() NOT NULL,
    capability_id text,
    admission_claim jsonb
);


--
-- Name: message_archive_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_archive_jobs (
    archive_id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    owner_identity_id character varying NOT NULL,
    writer_device_id character varying NOT NULL,
    destination_type character varying NOT NULL,
    destination_config jsonb DEFAULT '{"circle": "current"}'::jsonb NOT NULL,
    mode character varying NOT NULL,
    wrapped_archive_key jsonb,
    archive_key_version integer DEFAULT 1 NOT NULL,
    encrypted_manifest jsonb,
    manifest_revision integer DEFAULT 0 NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    last_archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_archive_jobs_destination_type_check CHECK (((destination_type)::text = 'circle'::text)),
    CONSTRAINT message_archive_jobs_mode_check CHECK (((mode)::text = 'text'::text)),
    CONSTRAINT message_archive_jobs_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'disabled'::character varying])::text[])))
);


--
-- Name: message_archive_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_archive_segments (
    segment_id uuid DEFAULT gen_random_uuid() NOT NULL,
    archive_id uuid NOT NULL,
    family_id uuid NOT NULL,
    owner_identity_id character varying NOT NULL,
    writer_device_id character varying NOT NULL,
    period_key character varying NOT NULL,
    state character varying DEFAULT 'current'::character varying NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    period_started_at timestamp with time zone,
    period_ended_at timestamp with time zone,
    message_count integer DEFAULT 0 NOT NULL,
    byte_size integer DEFAULT 0 NOT NULL,
    encrypted_segment jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_archive_segments_state_check CHECK (((state)::text = ANY ((ARRAY['current'::character varying, 'final'::character varying])::text[])))
);


--
-- Name: message_device_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_device_sync (
    family_id uuid NOT NULL,
    device_id text NOT NULL,
    last_sync_at bigint DEFAULT 0 NOT NULL,
    last_status_sync_at bigint DEFAULT 0 NOT NULL,
    last_mutation_sync_at bigint DEFAULT 0 NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    server_message_id text NOT NULL,
    family_id uuid NOT NULL,
    direct_chat_id text NOT NULL,
    chat_seq bigint NOT NULL,
    sender_identity_id text NOT NULL,
    recipient_identity_id text NOT NULL,
    sender_device_id text NOT NULL,
    ciphertext text NOT NULL,
    sender_ciphertext text,
    notification_preview_ciphertext text,
    sender_signature text NOT NULL,
    author_claim jsonb,
    client_message_id text NOT NULL,
    client_created_at bigint,
    created_at bigint NOT NULL,
    status text NOT NULL,
    status_updated_at bigint NOT NULL,
    delivery_proof jsonb,
    edited_at bigint,
    deleted_at bigint,
    content_updated_at bigint NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    temporary_identity_delegation jsonb,
    epoch integer
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    push_id character varying(255) NOT NULL,
    device_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    endpoint text NOT NULL,
    keys_p256dh text NOT NULL,
    keys_auth text NOT NULL,
    delivery_method character varying(20) DEFAULT 'direct'::character varying NOT NULL,
    relay_token text,
    push_encryption_public_key text NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_subscriptions_delivery_method_check CHECK (((delivery_method)::text = ANY ((ARRAY['direct'::character varying, 'relay'::character varying])::text[]))),
    CONSTRAINT push_subscriptions_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying, 'invalid'::character varying])::text[])))
);


--
-- Name: TABLE push_subscriptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.push_subscriptions IS 'Web Push notification subscriptions';


--
-- Name: COLUMN push_subscriptions.family_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.push_subscriptions.family_id IS 'Family/tenant identifier for multi-tenancy isolation';


--
-- Name: COLUMN push_subscriptions.delivery_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.push_subscriptions.delivery_method IS 'Push delivery method: direct WebPush or relay (server-mediated)';


--
-- Name: COLUMN push_subscriptions.relay_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.push_subscriptions.relay_token IS 'Token used for relay delivery method';


--
-- Name: server_admin_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_admin_claims (
    redemption_result jsonb,
    claim_id text NOT NULL,
    token_hash text NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone,
    used_by_identity_id text,
    created_via text NOT NULL,
    note text,
    CONSTRAINT server_admin_claims_created_via_check CHECK ((created_via = 'cli'::text)),
    CONSTRAINT server_admin_claims_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'used'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: server_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_admins (
    server_admin_id text NOT NULL,
    principal_identity_id text NOT NULL,
    display_name character varying(160),
    status text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    granted_via text NOT NULL,
    granted_by_server_admin_id text,
    CONSTRAINT server_admins_granted_via_check CHECK ((granted_via = ANY (ARRAY['bootstrap'::text, 'recovery'::text, 'admin_grant'::text]))),
    CONSTRAINT server_admins_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'superseded'::text])))
);


--
-- Name: system_device_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_device_sync (
    family_id uuid NOT NULL,
    device_id text NOT NULL,
    last_system_sync_at bigint DEFAULT 0 NOT NULL
);


--
-- Name: system_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_events (
    event_id text NOT NULL,
    family_id uuid NOT NULL,
    recipient_identity_id text NOT NULL,
    circle_id text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: temporary_access_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_access_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id text NOT NULL,
    request_type text NOT NULL,
    family_id uuid NOT NULL,
    identity_id text NOT NULL,
    enrollment_id text NOT NULL,
    temporary_device_id text NOT NULL,
    temporary_device_public_key_algorithm text NOT NULL,
    temporary_device_public_key_value text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    encrypted_payload text,
    cipher text,
    approved_by_device_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    approved_at timestamp with time zone,
    consumed_at timestamp with time zone,
    CONSTRAINT temporary_access_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text, 'consumed'::text]))),
    CONSTRAINT temporary_access_requests_type_check CHECK ((request_type = ANY (ARRAY['contacts'::text, 'trusted_access'::text, 'temporary_renewal'::text])))
);


--
-- Name: temporary_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_devices (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    device_id character varying(255) NOT NULL,
    identity_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    public_key_algorithm character varying(50) NOT NULL,
    public_key_value text NOT NULL,
    approved_by_device_id character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp without time zone,
    expires_at timestamp without time zone NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    encryption_public_key_algorithm character varying(50),
    encryption_public_key_value text,
    approval_attestation_payload text,
    approval_attestation_signature text,
    approving_device_public_key text,
    can_call boolean DEFAULT false NOT NULL,
    CONSTRAINT temporary_devices_encryption_public_key_algorithm_check CHECK (((encryption_public_key_algorithm IS NULL) OR ((encryption_public_key_algorithm)::text = 'x25519'::text))),
    CONSTRAINT temporary_devices_public_key_algorithm_check CHECK (((public_key_algorithm)::text = ANY ((ARRAY['ed25519'::character varying, 'x25519'::character varying])::text[]))),
    CONSTRAINT temporary_devices_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: temporary_device_chat_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_device_chat_access (
    temporary_device_id text NOT NULL,
    family_id uuid NOT NULL,
    chat_id text NOT NULL,
    chat_type text NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT temporary_device_chat_access_chat_type_check CHECK ((chat_type = ANY (ARRAY['group'::text, 'direct'::text])))
);


--
-- Name: temporary_device_group_chat_key_envelopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_device_group_chat_key_envelopes (
    temporary_device_id text NOT NULL,
    family_id uuid NOT NULL,
    chat_id text NOT NULL,
    epoch integer NOT NULL,
    envelope_ciphertext text NOT NULL,
    publisher_identity_id text NOT NULL,
    publisher_enc_public_key_algo text NOT NULL,
    publisher_enc_public_key_value text NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: temporary_device_direct_chat_key_envelopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_device_direct_chat_key_envelopes (
    temporary_device_id text NOT NULL,
    family_id uuid NOT NULL,
    direct_chat_id text NOT NULL,
    epoch integer NOT NULL,
    envelope_ciphertext text NOT NULL,
    publisher_identity_id text NOT NULL,
    publisher_enc_public_key_algo text NOT NULL,
    publisher_enc_public_key_value text NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: tenant_owner_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_owner_claims (
    redemption_result jsonb,
    claim_id text NOT NULL,
    family_id uuid NOT NULL,
    token_hash text NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone,
    used_by_identity_id text,
    CONSTRAINT tenant_owner_claims_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'used'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: circle_owner_recovery_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_owner_recovery_claims (
    claim_id text PRIMARY KEY,
    family_id uuid NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expected_owner_identity_id text NOT NULL,
    created_by_server_admin_id text NOT NULL,
    created_authorization jsonb NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone,
    used_by_identity_id text,
    CONSTRAINT circle_owner_recovery_claims_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'used'::text, 'expired'::text, 'revoked'::text])))
);

CREATE INDEX circle_owner_recovery_claims_family_status_idx
    ON public.circle_owner_recovery_claims USING btree (family_id, status, expires_at);


--
-- Name: circle_owner_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_owner_changes (
    change_id text PRIMARY KEY,
    family_id uuid NOT NULL,
    previous_owner_identity_id text NOT NULL,
    new_owner_identity_id text NOT NULL,
    method text NOT NULL,
    initiated_by_identity_id text NOT NULL,
    initiated_by_device_id text NOT NULL,
    initiated_by_server_admin_id text,
    recovery_claim_id text,
    signed_authorization jsonb NOT NULL,
    owner_role_document_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT circle_owner_changes_method_check CHECK ((method = ANY (ARRAY['voluntary_transfer'::text, 'server_admin_recovery'::text])))
);

CREATE INDEX circle_owner_changes_family_created_idx
    ON public.circle_owner_changes USING btree (family_id, created_at DESC);


--
-- Name: vaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vaults (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    identity_id character varying(255) NOT NULL,
    family_id uuid NOT NULL,
    encrypted_vault jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    revision integer DEFAULT 1,
    status character varying(20) DEFAULT 'present'::character varying NOT NULL,
    CONSTRAINT vaults_status_check CHECK (((status)::text = ANY ((ARRAY['present'::character varying, 'absent'::character varying])::text[])))
);


--
-- Name: TABLE vaults; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vaults IS 'Encrypted user data vaults';


--
-- Name: COLUMN vaults.family_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vaults.family_id IS 'Family/tenant identifier for multi-tenancy isolation';


--
-- Name: attachment_blobs attachment_blobs_blob_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_blobs
    ADD CONSTRAINT attachment_blobs_blob_id_key UNIQUE (blob_id);


--
-- Name: attachment_blobs attachment_blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_blobs
    ADD CONSTRAINT attachment_blobs_pkey PRIMARY KEY (id);


--
-- Name: attachment_blobs attachment_blobs_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_blobs
    ADD CONSTRAINT attachment_blobs_storage_key_key UNIQUE (storage_key);


--
-- Name: attachment_upload_reservations attachment_upload_reservations_blob_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_upload_reservations
    ADD CONSTRAINT attachment_upload_reservations_blob_id_key UNIQUE (blob_id);


--
-- Name: attachment_upload_reservations attachment_upload_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_upload_reservations
    ADD CONSTRAINT attachment_upload_reservations_pkey PRIMARY KEY (id);


--
-- Name: attachment_upload_reservations attachment_upload_reservations_reservation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_upload_reservations
    ADD CONSTRAINT attachment_upload_reservations_reservation_id_key UNIQUE (reservation_id);


--
-- Name: call_device_sync call_device_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_device_sync
    ADD CONSTRAINT call_device_sync_pkey PRIMARY KEY (family_id, device_id);


--
-- Name: call_links call_links_call_link_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_links
    ADD CONSTRAINT call_links_call_link_id_key UNIQUE (call_link_id);


--
-- Name: call_links call_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_links
    ADD CONSTRAINT call_links_pkey PRIMARY KEY (id);


--
-- Name: call_client_diagnostics call_client_diagnostics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_client_diagnostics
    ADD CONSTRAINT call_client_diagnostics_pkey PRIMARY KEY (call_session_id, identity_id, device_id);


--
-- Name: call_quality_daily call_quality_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_quality_daily
    ADD CONSTRAINT call_quality_daily_pkey PRIMARY KEY (family_id, day_start_ms, turn_cluster_id);


--
-- Name: call_handling_events call_handling_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_handling_events
    ADD CONSTRAINT call_handling_events_pkey PRIMARY KEY (event_id);


--
-- Name: call_ice_diagnostics call_ice_diagnostics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_ice_diagnostics
    ADD CONSTRAINT call_ice_diagnostics_pkey PRIMARY KEY (call_session_id, identity_id);


--
-- Name: circle_inspector_requests circle_inspector_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_requests
    ADD CONSTRAINT circle_inspector_requests_pkey PRIMARY KEY (request_id);


--
-- Name: circle_inspector_sessions circle_inspector_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_sessions
    ADD CONSTRAINT circle_inspector_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: circle_inspector_sessions circle_inspector_sessions_session_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_sessions
    ADD CONSTRAINT circle_inspector_sessions_session_token_hash_key UNIQUE (session_token_hash);


--
-- Name: call_logs call_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_pkey PRIMARY KEY (call_session_id);


--
-- Name: call_sessions call_sessions_call_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_call_session_id_key UNIQUE (call_session_id);


--
-- Name: call_sessions call_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_pkey PRIMARY KEY (id);


--
-- Name: call_whitelist_entries call_whitelist_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_whitelist_entries
    ADD CONSTRAINT call_whitelist_entries_pkey PRIMARY KEY (id);


--
-- Name: circle_file_access circle_file_access_family_id_blob_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_file_access
    ADD CONSTRAINT circle_file_access_family_id_blob_id_key UNIQUE (family_id, blob_id);


--
-- Name: circle_file_access circle_file_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_file_access
    ADD CONSTRAINT circle_file_access_pkey PRIMARY KEY (access_id);


--
-- Name: circle_site_publications circle_site_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_site_publications
    ADD CONSTRAINT circle_site_publications_pkey PRIMARY KEY (publication_id);


--
-- Name: circle_site_settings circle_site_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_site_settings
    ADD CONSTRAINT circle_site_settings_pkey PRIMARY KEY (family_id);


--
-- Name: circle_media_routing_settings circle_media_routing_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_media_routing_settings
    ADD CONSTRAINT circle_media_routing_settings_pkey PRIMARY KEY (family_id);


--
-- Name: device_enrollments device_enrollments_enrollment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_enrollments
    ADD CONSTRAINT device_enrollments_enrollment_id_key UNIQUE (enrollment_id);


--
-- Name: device_enrollments device_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_enrollments
    ADD CONSTRAINT device_enrollments_pkey PRIMARY KEY (id);


--
-- Name: device_notification_bindings device_notification_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_notification_bindings
    ADD CONSTRAINT device_notification_bindings_pkey PRIMARY KEY (id);


--
-- Name: deleted_circle_domains deleted_circle_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deleted_circle_domains
    ADD CONSTRAINT deleted_circle_domains_pkey PRIMARY KEY (host);


--
-- Name: devices devices_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_device_id_key UNIQUE (device_id);


--
-- Name: devices devices_encryption_public_key_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_encryption_public_key_value_key UNIQUE (encryption_public_key_value);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: devices devices_public_key_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_public_key_value_key UNIQUE (public_key_value);


--
-- Name: direct_chat_epoch_keys direct_chat_epoch_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_chat_epoch_keys
    ADD CONSTRAINT direct_chat_epoch_keys_pkey PRIMARY KEY (family_id, direct_chat_id, epoch);


--
-- Name: direct_chat_epoch_state direct_chat_epoch_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_chat_epoch_state
    ADD CONSTRAINT direct_chat_epoch_state_pkey PRIMARY KEY (family_id, direct_chat_id);


--
-- Name: direct_chat_seq direct_chat_seq_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_chat_seq
    ADD CONSTRAINT direct_chat_seq_pkey PRIMARY KEY (family_id, direct_chat_id);


--
-- Name: direct_chat_key_envelopes direct_chat_key_envelopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_chat_key_envelopes
    ADD CONSTRAINT direct_chat_key_envelopes_pkey PRIMARY KEY (family_id, direct_chat_id, epoch, identity_id);


--
-- Name: direct_guest_link_defaults direct_guest_link_defaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_guest_link_defaults
    ADD CONSTRAINT direct_guest_link_defaults_pkey PRIMARY KEY (family_id, host_identity_id);


ALTER TABLE ONLY public.announcement_channels
    ADD CONSTRAINT announcement_channels_pkey PRIMARY KEY (channel_id);


ALTER TABLE ONLY public.announcement_channel_links
    ADD CONSTRAINT announcement_channel_links_pkey PRIMARY KEY (channel_id, link_id);


ALTER TABLE ONLY public.announcement_channel_links
    ADD CONSTRAINT uq_announcement_channel_links_link UNIQUE (family_id, link_id);


ALTER TABLE ONLY public.announcement_channel_subscriptions
    ADD CONSTRAINT announcement_channel_subscriptions_pkey PRIMARY KEY (subscription_id);


ALTER TABLE ONLY public.announcement_channel_subscriptions
    ADD CONSTRAINT uq_announcement_channel_subscription_identity UNIQUE (family_id, channel_id, subscriber_identity_id);


ALTER TABLE ONLY public.announcement_channel_epoch_keys
    ADD CONSTRAINT announcement_channel_epoch_keys_pkey PRIMARY KEY (family_id, channel_id, epoch);


ALTER TABLE ONLY public.announcement_channel_key_envelopes
    ADD CONSTRAINT announcement_channel_key_envelopes_pkey PRIMARY KEY (family_id, channel_id, epoch, identity_id);


ALTER TABLE ONLY public.announcement_channel_posts
    ADD CONSTRAINT announcement_channel_posts_pkey PRIMARY KEY (post_id);


ALTER TABLE ONLY public.announcement_channel_posts
    ADD CONSTRAINT announcement_channel_posts_family_channel_sequence_key UNIQUE (family_id, channel_id, post_sequence);


ALTER TABLE ONLY public.announcement_channel_posts
    ADD CONSTRAINT announcement_channel_posts_family_channel_device_client_key UNIQUE (family_id, channel_id, author_device_id, client_post_id);


ALTER TABLE ONLY public.announcement_channel_push_outbox
    ADD CONSTRAINT announcement_channel_push_outbox_pkey PRIMARY KEY (post_id);


ALTER TABLE ONLY public.trusted_device_rekey_jobs
    ADD CONSTRAINT trusted_device_rekey_jobs_pkey PRIMARY KEY (job_id);


ALTER TABLE ONLY public.trusted_device_rekey_targets
    ADD CONSTRAINT trusted_device_rekey_targets_pkey PRIMARY KEY (job_id, target_type, chat_id);


--
-- Name: direct_guest_links direct_guest_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_guest_links
    ADD CONSTRAINT direct_guest_links_pkey PRIMARY KEY (link_id);


--
-- Name: direct_guest_registrations direct_guest_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_guest_registrations
    ADD CONSTRAINT direct_guest_registrations_pkey PRIMARY KEY (registration_id);


--
-- Name: family_config family_config_family_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_config
    ADD CONSTRAINT family_config_family_id_key UNIQUE (family_id);


--
-- Name: family_config family_config_circle_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_config
    ADD CONSTRAINT family_config_circle_id_key UNIQUE (circle_id);


--
-- Name: family_config family_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_config
    ADD CONSTRAINT family_config_pkey PRIMARY KEY (id);


--
-- Name: family_domains family_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_domains
    ADD CONSTRAINT family_domains_pkey PRIMARY KEY (id);


--
-- Name: group_chat_epoch_keys group_chat_epoch_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_epoch_keys
    ADD CONSTRAINT group_chat_epoch_keys_pkey PRIMARY KEY (chat_id, family_id, epoch);


--
-- Name: group_chat_key_envelopes group_chat_key_envelopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_key_envelopes
    ADD CONSTRAINT group_chat_key_envelopes_pkey PRIMARY KEY (chat_id, family_id, epoch, identity_id);


--
-- Name: group_chat_messages group_chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_messages
    ADD CONSTRAINT group_chat_messages_pkey PRIMARY KEY (message_id);


--
-- Name: group_chat_participants group_chat_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_participants
    ADD CONSTRAINT group_chat_participants_pkey PRIMARY KEY (chat_id, identity_id);


--
-- Name: group_chat_reads group_chat_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_reads
    ADD CONSTRAINT group_chat_reads_pkey PRIMARY KEY (chat_id, family_id, identity_id);


--
-- Name: group_chat_state_transitions group_chat_state_transitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_state_transitions
    ADD CONSTRAINT group_chat_state_transitions_pkey PRIMARY KEY (family_id, chat_id, transition_id);


--
-- Name: group_chat_state_transitions group_chat_state_transitions_family_chat_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_state_transitions
    ADD CONSTRAINT group_chat_state_transitions_family_chat_sequence_key UNIQUE (family_id, chat_id, sequence);


--
-- Name: group_chat_seq group_chat_seq_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_seq
    ADD CONSTRAINT group_chat_seq_pkey PRIMARY KEY (family_id, chat_id);


--
-- Name: group_chats group_chats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chats
    ADD CONSTRAINT group_chats_pkey PRIMARY KEY (chat_id);


--
-- Name: identities identities_identity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_identity_id_key UNIQUE (identity_id);


--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);


--
-- Name: identities identities_public_key_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_public_key_value_key UNIQUE (public_key_value);


--
-- Name: identity_backups identity_backups_namespace_slot_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_backups
    ADD CONSTRAINT identity_backups_namespace_slot_uniq UNIQUE (family_id, lookup_secret_hash, backup_slot_id);


--
-- Name: identity_backups identity_backups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_backups
    ADD CONSTRAINT identity_backups_pkey PRIMARY KEY (backup_id);


--
-- Name: identity_read_cursors identity_read_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_read_cursors
    ADD CONSTRAINT identity_read_cursors_pkey PRIMARY KEY (family_id, reader_identity_id, peer_identity_id);


--
-- Name: invite_acceptances invite_acceptances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_acceptances
    ADD CONSTRAINT invite_acceptances_pkey PRIMARY KEY (id);


--
-- Name: invite_acceptances unique_invite_acceptance_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_acceptances
    ADD CONSTRAINT unique_invite_acceptance_identity UNIQUE (invite_id, accepted_by_identity_id);


--
-- Name: invites invites_invite_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_invite_id_key UNIQUE (invite_id);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);


--
-- Name: invites invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_token_key UNIQUE (token);


--
-- Name: message_archive_jobs message_archive_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_archive_jobs
    ADD CONSTRAINT message_archive_jobs_pkey PRIMARY KEY (archive_id);


--
-- Name: message_archive_segments message_archive_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_archive_segments
    ADD CONSTRAINT message_archive_segments_pkey PRIMARY KEY (segment_id);


--
-- Name: message_device_sync message_device_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_device_sync
    ADD CONSTRAINT message_device_sync_pkey PRIMARY KEY (family_id, device_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (server_message_id);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_push_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_push_id_key UNIQUE (push_id);


--
-- Name: server_admin_claims server_admin_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_admin_claims
    ADD CONSTRAINT server_admin_claims_pkey PRIMARY KEY (claim_id);


--
-- Name: server_admin_claims server_admin_claims_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_admin_claims
    ADD CONSTRAINT server_admin_claims_token_hash_key UNIQUE (token_hash);


--
-- Name: server_admins server_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_admins
    ADD CONSTRAINT server_admins_pkey PRIMARY KEY (server_admin_id);


--
-- Name: server_device_lifecycle_policy server_device_lifecycle_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_device_lifecycle_policy
    ADD CONSTRAINT server_device_lifecycle_policy_pkey PRIMARY KEY (singleton_key);


--
-- Name: system_device_sync system_device_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_device_sync
    ADD CONSTRAINT system_device_sync_pkey PRIMARY KEY (family_id, device_id);


--
-- Name: system_events system_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_events
    ADD CONSTRAINT system_events_pkey PRIMARY KEY (event_id);


--
-- Name: temporary_access_requests temporary_access_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_access_requests
    ADD CONSTRAINT temporary_access_requests_pkey PRIMARY KEY (id);


--
-- Name: temporary_access_requests temporary_access_requests_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_access_requests
    ADD CONSTRAINT temporary_access_requests_request_id_key UNIQUE (request_id);


--
-- Name: temporary_devices temporary_devices_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_devices
    ADD CONSTRAINT temporary_devices_device_id_key UNIQUE (device_id);


--
-- Name: temporary_devices temporary_devices_encryption_public_key_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_devices
    ADD CONSTRAINT temporary_devices_encryption_public_key_value_key UNIQUE (encryption_public_key_value);


--
-- Name: temporary_devices temporary_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_devices
    ADD CONSTRAINT temporary_devices_pkey PRIMARY KEY (id);


--
-- Name: temporary_devices temporary_devices_public_key_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_devices
    ADD CONSTRAINT temporary_devices_public_key_value_key UNIQUE (public_key_value);


--
-- Name: temporary_device_chat_access temporary_device_chat_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_device_chat_access
    ADD CONSTRAINT temporary_device_chat_access_pkey PRIMARY KEY (temporary_device_id, chat_id);


--
-- Name: temporary_device_group_chat_key_envelopes temporary_device_group_chat_key_envelopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_device_group_chat_key_envelopes
    ADD CONSTRAINT temporary_device_group_chat_key_envelopes_pkey PRIMARY KEY (temporary_device_id, chat_id, epoch);


--
-- Name: temporary_device_direct_chat_key_envelopes temporary_device_direct_chat_key_envelopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_device_direct_chat_key_envelopes
    ADD CONSTRAINT temporary_device_direct_chat_key_envelopes_pkey PRIMARY KEY (temporary_device_id, direct_chat_id, epoch);


--
-- Name: tenant_owner_claims tenant_owner_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_owner_claims
    ADD CONSTRAINT tenant_owner_claims_pkey PRIMARY KEY (claim_id);


--
-- Name: tenant_owner_claims tenant_owner_claims_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_owner_claims
    ADD CONSTRAINT tenant_owner_claims_token_hash_key UNIQUE (token_hash);


--
-- Name: vaults vaults_identity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vaults
    ADD CONSTRAINT vaults_identity_id_key UNIQUE (identity_id);


--
-- Name: vaults vaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vaults
    ADD CONSTRAINT vaults_pkey PRIMARY KEY (id);


--
-- Name: group_chat_epoch_keys_family_epoch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_epoch_keys_family_epoch_idx ON public.group_chat_epoch_keys USING btree (family_id, epoch DESC, created_at DESC);


--
-- Name: group_chat_key_envelopes_identity_epoch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_key_envelopes_identity_epoch_idx ON public.group_chat_key_envelopes USING btree (family_id, identity_id, epoch DESC, created_at DESC);


--
-- Name: group_chat_messages_chat_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_messages_chat_created_idx ON public.group_chat_messages USING btree (family_id, chat_id, created_at);


--
-- Name: group_chat_messages_chat_epoch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_messages_chat_epoch_idx ON public.group_chat_messages USING btree (family_id, chat_id, epoch, created_at);


--
-- Name: group_chat_messages_chat_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_messages_chat_seq_idx ON public.group_chat_messages USING btree (family_id, chat_id, chat_seq);


--
-- Name: group_chat_messages_content_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_messages_content_updated_idx ON public.group_chat_messages USING btree (family_id, chat_id, content_updated_at);


--
-- Name: group_chat_messages_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX group_chat_messages_idempotency_idx ON public.group_chat_messages USING btree (family_id, chat_id, sender_device_id, client_message_id) WHERE ((kind = 'user'::text) AND (sender_device_id IS NOT NULL) AND (client_message_id IS NOT NULL));


--
-- Name: group_chat_participants_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_participants_active_idx ON public.group_chat_participants USING btree (family_id, identity_id, is_active, joined_at DESC);


--
-- Name: group_chat_state_transition_successor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX group_chat_state_transition_successor_idx ON public.group_chat_state_transitions USING btree (family_id, chat_id, COALESCE(previous_transition_id, '__genesis__'::text));


--
-- Name: group_chat_state_transitions_sequence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_state_transitions_sequence_idx ON public.group_chat_state_transitions USING btree (family_id, chat_id, sequence);


--
-- Name: group_chats_family_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chats_family_updated_idx ON public.group_chats USING btree (family_id, updated_at DESC);


--
-- Name: identity_backups_family_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_backups_family_id_idx ON public.identity_backups USING btree (family_id);


--
-- Name: identity_backups_lookup_secret_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_backups_lookup_secret_hash_idx ON public.identity_backups USING btree (family_id, lookup_secret_hash);


--
-- Name: idx_attachment_blobs_chat_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachment_blobs_chat_lookup ON public.attachment_blobs USING btree (family_id, chat_type, chat_id, created_at);


--
-- Name: idx_attachment_blobs_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachment_blobs_expires_at ON public.attachment_blobs USING btree (expires_at);


--
-- Name: idx_attachment_blobs_family_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachment_blobs_family_status ON public.attachment_blobs USING btree (family_id, status);


--
-- Name: idx_attachment_upload_reservations_family_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachment_upload_reservations_family_status ON public.attachment_upload_reservations USING btree (family_id, status);


--
-- Name: idx_attachment_upload_reservations_reserved_until; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachment_upload_reservations_reserved_until ON public.attachment_upload_reservations USING btree (reserved_until);


--
-- Name: idx_call_links_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_links_expires_at ON public.call_links USING btree (expires_at);


--
-- Name: idx_call_links_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_links_created_by ON public.call_links USING btree (family_id, created_by, created_at DESC);


--
-- Name: idx_call_links_direct_guest_link_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_links_direct_guest_link_id ON public.call_links USING btree (direct_guest_link_id);


--
-- Name: idx_call_links_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_links_family_id ON public.call_links USING btree (family_id);


--
-- Name: idx_call_links_join_invite_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_links_join_invite_id ON public.call_links USING btree (join_invite_id);


--
-- Name: idx_call_links_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_links_status ON public.call_links USING btree (status);


--
-- Name: idx_call_links_target_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_links_target_identity ON public.call_links USING btree (target_identity_id);


--
-- Name: uq_call_links_capability_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_call_links_capability_id ON public.call_links USING btree (family_id, capability_id) WHERE (capability_id IS NOT NULL);


--
-- Name: idx_call_handling_events_family_call_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_handling_events_family_call_recorded ON public.call_handling_events USING btree (family_id, call_session_id, recorded_at);


--
-- Name: idx_call_handling_events_family_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_handling_events_family_recorded ON public.call_handling_events USING btree (family_id, recorded_at);


--
-- Name: idx_call_client_diagnostics_family_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_client_diagnostics_family_recorded ON public.call_client_diagnostics USING btree (family_id, recorded_at);


--
-- Name: idx_call_quality_daily_family_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_quality_daily_family_day ON public.call_quality_daily USING btree (family_id, day_start_ms DESC);


--
-- Name: idx_call_ice_diagnostics_family_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_ice_diagnostics_family_recorded ON public.call_ice_diagnostics USING btree (family_id, recorded_at);


--
-- Name: idx_circle_inspector_requests_family_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_inspector_requests_family_created ON public.circle_inspector_requests USING btree (family_id, created_at);


--
-- Name: idx_circle_inspector_requests_family_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_inspector_requests_family_status ON public.circle_inspector_requests USING btree (family_id, status, expires_at);


--
-- Name: idx_circle_inspector_sessions_family_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_inspector_sessions_family_active ON public.circle_inspector_sessions USING btree (family_id, expires_at) WHERE (revoked_at IS NULL);


--
-- Name: idx_circle_inspector_sessions_family_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_inspector_sessions_family_created ON public.circle_inspector_sessions USING btree (family_id, created_at);


--
-- Name: idx_call_logs_family_initiator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_family_initiator ON public.call_logs USING btree (family_id, initiator_identity_id);


--
-- Name: idx_call_logs_family_last_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_family_last_updated ON public.call_logs USING btree (family_id, last_updated_at);


--
-- Name: idx_call_logs_family_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_family_target ON public.call_logs USING btree (family_id, target_identity_id);


--
-- Name: idx_call_logs_family_target_missed_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_family_target_missed_seen ON public.call_logs USING btree (family_id, target_identity_id, missed_seen_at) WHERE ((final_status = ANY (ARRAY['missed'::text, 'failed'::text, 'ended'::text])) AND (connected_at IS NULL));


--
-- Name: idx_call_logs_stale_connected; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_stale_connected ON public.call_logs USING btree (family_id, last_heartbeat_at) WHERE ((connected_at IS NOT NULL) AND (ended_at IS NULL));


--
-- Name: idx_call_sessions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_created_at ON public.call_sessions USING btree (created_at);


--
-- Name: idx_call_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_expires_at ON public.call_sessions USING btree (expires_at);


--
-- Name: idx_call_sessions_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_family_id ON public.call_sessions USING btree (family_id);


--
-- Name: idx_call_sessions_initiator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_initiator ON public.call_sessions USING btree (initiator);


--
-- Name: idx_call_sessions_participants; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_participants ON public.call_sessions USING gin (participants);


--
-- Name: idx_call_sessions_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_state ON public.call_sessions USING btree (state);


--
-- Name: idx_call_whitelist_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_whitelist_owner ON public.call_whitelist_entries USING btree (family_id, owner_identity_id);


--
-- Name: idx_call_whitelist_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_whitelist_status ON public.call_whitelist_entries USING btree (family_id, status);


--
-- Name: idx_circle_file_access_blob; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_file_access_blob ON public.circle_file_access USING btree (blob_id);


--
-- Name: idx_circle_file_access_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_file_access_family ON public.circle_file_access USING btree (family_id);


--
-- Name: idx_circle_site_publications_family_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_site_publications_family_link ON public.circle_site_publications USING btree (family_id, source_link_id);


--
-- Name: idx_circle_site_publications_family_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_site_publications_family_channel ON public.circle_site_publications USING btree (family_id, channel_id, published_at DESC);


--
-- Name: idx_circle_site_publications_family_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_circle_site_publications_family_slug ON public.circle_site_publications USING btree (family_id, slug);


--
--



CREATE UNIQUE INDEX idx_circle_site_publications_family_source_channel_post ON public.circle_site_publications USING btree (family_id, source_channel_post_id) WHERE (source_channel_post_id IS NOT NULL);


--
-- Name: idx_circle_site_publications_family_status_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_circle_site_publications_family_status_published ON public.circle_site_publications USING btree (family_id, status, published_at DESC);


--
-- Name: idx_device_enrollments_family_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_enrollments_family_created_at ON public.device_enrollments USING btree (family_id, created_at DESC);


--
-- Name: idx_device_enrollments_bootstrap_commitment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_device_enrollments_bootstrap_commitment ON public.device_enrollments USING btree (family_id, bootstrap_commitment) WHERE (bootstrap_commitment IS NOT NULL);


--
-- Name: idx_device_enrollments_lifecycle_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_enrollments_lifecycle_expiry ON public.device_enrollments USING btree (state, enrollment_expires_at, payload_expires_at);


--
-- Name: idx_device_enrollments_state_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_enrollments_state_expires_at ON public.device_enrollments USING btree (state, expires_at);


--
-- Name: idx_platform_recovery_enrollments_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_recovery_enrollments_binding ON public.device_enrollments USING btree (family_id, platform_recovery_binding_id, created_at DESC) WHERE (enrollment_kind = 'platform_recovery'::text);


--
-- Name: idx_platform_recovery_one_active_identity_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_recovery_one_active_identity_slot ON public.platform_recovery_bindings USING btree (family_id, identity_id, recovery_slot) WHERE (status = 'active'::text);


--
-- Name: idx_device_notification_bindings_delivery_token_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_notification_bindings_delivery_token_expires_at ON public.device_notification_bindings USING btree (delivery_token_expires_at);


--
-- Name: idx_device_notification_bindings_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_notification_bindings_family_id ON public.device_notification_bindings USING btree (family_id);


--
-- Name: idx_device_notification_bindings_mobile_endpoint_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_notification_bindings_mobile_endpoint_id ON public.device_notification_bindings USING btree (mobile_endpoint_id);


--
-- Name: idx_device_notification_bindings_web_device_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_notification_bindings_web_device_id ON public.device_notification_bindings USING btree (web_device_id);


--
-- Name: idx_deleted_circle_domains_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deleted_circle_domains_family_id ON public.deleted_circle_domains USING btree (family_id);


--
-- Name: idx_devices_encryption_public_key_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_encryption_public_key_value ON public.devices USING btree (encryption_public_key_value);


--
-- Name: idx_devices_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_family_id ON public.devices USING btree (family_id);


--
-- Name: idx_devices_identity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_identity_id ON public.devices USING btree (identity_id);


--
-- Name: idx_devices_active_last_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_active_last_activity ON public.devices USING btree (COALESCE(last_seen_at, created_at)) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_devices_public_key_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_public_key_value ON public.devices USING btree (public_key_value);


--
-- Name: idx_devices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_status ON public.devices USING btree (status);


--
-- Name: idx_direct_chat_key_envelopes_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_chat_key_envelopes_identity ON public.direct_chat_key_envelopes USING btree (family_id, identity_id, direct_chat_id, epoch);


--
--

CREATE UNIQUE INDEX idx_announcement_channels_default_owner ON public.announcement_channels USING btree (family_id, owner_identity_id) WHERE ((is_default = true) AND (status = 'active'::text));


CREATE UNIQUE INDEX idx_announcement_channels_family_public_slug ON public.announcement_channels USING btree (family_id, public_site_slug) WHERE ((public_site_visible = true) AND (public_site_slug IS NOT NULL));


CREATE INDEX idx_announcement_channels_family_status ON public.announcement_channels USING btree (family_id, status, created_at DESC);


CREATE INDEX idx_announcement_channel_links_family_channel ON public.announcement_channel_links USING btree (family_id, channel_id);


CREATE INDEX idx_announcement_channel_subscriptions_channel_status ON public.announcement_channel_subscriptions USING btree (family_id, channel_id, status);


CREATE INDEX idx_announcement_channel_subscriptions_identity_status ON public.announcement_channel_subscriptions USING btree (family_id, subscriber_identity_id, status);


CREATE INDEX idx_announcement_channel_subscriptions_read_cursor ON public.announcement_channel_subscriptions USING btree (family_id, channel_id, last_read_sequence) WHERE (last_read_sequence IS NOT NULL);


CREATE INDEX idx_announcement_channel_subscriptions_received_cursor ON public.announcement_channel_subscriptions USING btree (family_id, channel_id, last_received_sequence) WHERE (last_received_sequence IS NOT NULL);


CREATE INDEX idx_announcement_channel_key_envelopes_identity ON public.announcement_channel_key_envelopes USING btree (family_id, identity_id, channel_id, epoch DESC);


CREATE INDEX idx_announcement_channel_posts_sync ON public.announcement_channel_posts USING btree (family_id, channel_id, post_sequence);


CREATE INDEX idx_announcement_channel_push_outbox_ready ON public.announcement_channel_push_outbox USING btree (status, available_at, created_at) WHERE (status <> 'completed'::text);


CREATE INDEX idx_trusted_device_rekey_jobs_ready ON public.trusted_device_rekey_jobs USING btree (status, available_at, created_at) WHERE (status <> 'completed'::text);


CREATE INDEX idx_trusted_device_rekey_targets_pending ON public.trusted_device_rekey_targets USING btree (job_id, target_type, chat_id) WHERE (status = 'pending'::text);


CREATE INDEX idx_trusted_device_rekey_jobs_completed ON public.trusted_device_rekey_jobs USING btree (completed_at) WHERE (status = 'completed'::text);




--
--





--
--







--
--



--
-- Name: idx_direct_guest_links_family_host_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_guest_links_family_host_status ON public.direct_guest_links USING btree (family_id, host_identity_id, status, created_at DESC);


--
-- Name: idx_direct_guest_links_family_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_guest_links_family_status ON public.direct_guest_links USING btree (family_id, status);


--
-- Name: idx_direct_guest_links_family_channel_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_direct_guest_links_family_channel_slug ON public.direct_guest_links USING btree (family_id, public_site_channel_slug) WHERE ((public_site_visible = true) AND (public_site_channel_slug IS NOT NULL));


--
-- Name: uq_direct_guest_links_capability_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_direct_guest_links_capability_id ON public.direct_guest_links USING btree (family_id, capability_id) WHERE (capability_id IS NOT NULL);


--
-- Name: idx_direct_guest_registrations_family_guest_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_guest_registrations_family_guest_status ON public.direct_guest_registrations USING btree (family_id, guest_identity_id, status);


--
-- Name: idx_direct_guest_registrations_family_host_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_guest_registrations_family_host_status ON public.direct_guest_registrations USING btree (family_id, host_identity_id, status);


--
-- Name: idx_direct_guest_registrations_family_link_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_guest_registrations_family_link_status ON public.direct_guest_registrations USING btree (family_id, link_id, status, created_at DESC);


--
-- Name: idx_direct_guest_registrations_capability; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_direct_guest_registrations_capability ON public.direct_guest_registrations USING btree (family_id, capability_id) WHERE (capability_id IS NOT NULL);


--
-- Name: uq_direct_guest_registration_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_direct_guest_registration_identity ON public.direct_guest_registrations USING btree (family_id, guest_identity_id) WHERE (capability_id IS NOT NULL);


--
-- Name: idx_family_config_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_family_config_family_id ON public.family_config USING btree (family_id);


--
-- Name: idx_family_config_status_revoked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_family_config_status_revoked_at ON public.family_config USING btree (status, revoked_at);


--
-- Name: idx_family_domains_active_host; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_family_domains_active_host ON public.family_domains USING btree (host) WHERE (status = 'active'::text);


--
-- Name: idx_family_domains_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_family_domains_family_id ON public.family_domains USING btree (family_id);


--
-- Name: idx_family_domains_host_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_family_domains_family_host_unique ON public.family_domains USING btree (family_id, host);


--
-- Name: idx_family_domains_one_current_per_family; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_family_domains_one_current_per_family ON public.family_domains USING btree (family_id) WHERE ((is_current = true) AND (status = 'active'::text));


--
-- Name: idx_identities_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identities_family_id ON public.identities USING btree (family_id);


--
-- Name: idx_identities_removed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identities_removed_at ON public.identities USING btree (family_id, removed_at DESC) WHERE ((status)::text = 'removed'::text);


--
-- Name: idx_identities_public_key_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identities_public_key_value ON public.identities USING btree (public_key_value);


--
-- Name: idx_identities_publish_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identities_publish_identity ON public.identities USING btree (publish_identity);


--
-- Name: idx_identities_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identities_role ON public.identities USING btree (role);


--
-- Name: idx_identities_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identities_status ON public.identities USING btree (status);


--
-- Name: idx_identities_status_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identities_status_updated_at ON public.identities USING btree (status_updated_at);


--
-- Name: idx_invites_accepted_by_identity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invites_accepted_by_identity_id ON public.invites USING btree (accepted_by_identity_id);


--
-- Name: idx_invites_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invites_expires_at ON public.invites USING btree (expires_at);


--
-- Name: idx_invites_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invites_family_id ON public.invites USING btree (family_id);


--
-- Name: idx_invites_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invites_status ON public.invites USING btree (status);


--
-- Name: idx_invites_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invites_token ON public.invites USING btree (token);


--
-- Name: uq_invites_capability_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_invites_capability_id ON public.invites USING btree (family_id, capability_id) WHERE (capability_id IS NOT NULL);


--
-- Name: idx_invite_acceptances_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invite_acceptances_family_id ON public.invite_acceptances USING btree (family_id);


--
-- Name: idx_invite_acceptances_invite_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invite_acceptances_invite_id ON public.invite_acceptances USING btree (invite_id);


--
-- Name: idx_invite_acceptances_capability; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invite_acceptances_capability ON public.invite_acceptances USING btree (family_id, capability_id) WHERE (capability_id IS NOT NULL);


--
-- Name: idx_push_subscriptions_delivery_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subscriptions_delivery_method ON public.push_subscriptions USING btree (delivery_method);


--
-- Name: idx_push_subscriptions_device_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subscriptions_device_id ON public.push_subscriptions USING btree (device_id);


--
-- Name: idx_push_subscriptions_device_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subscriptions_device_status ON public.push_subscriptions USING btree (device_id, status);


--
-- Name: idx_push_subscriptions_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subscriptions_family_id ON public.push_subscriptions USING btree (family_id);


--
-- Name: idx_push_subscriptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subscriptions_status ON public.push_subscriptions USING btree (status);


--
-- Name: idx_temporary_access_requests_family_device_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_access_requests_family_device_type_status ON public.temporary_access_requests USING btree (family_id, temporary_device_id, request_type, status);


--
-- Name: idx_temporary_access_requests_family_identity_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_access_requests_family_identity_type_status ON public.temporary_access_requests USING btree (family_id, identity_id, request_type, status);


--
-- Name: idx_temporary_devices_encryption_public_key_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_devices_encryption_public_key_value ON public.temporary_devices USING btree (encryption_public_key_value);


--
-- Name: idx_temporary_devices_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_devices_expires_at ON public.temporary_devices USING btree (expires_at);


--
-- Name: idx_temporary_devices_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_devices_family_id ON public.temporary_devices USING btree (family_id);


--
-- Name: idx_temporary_devices_identity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_devices_identity_id ON public.temporary_devices USING btree (identity_id);


--
-- Name: idx_temporary_devices_public_key_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_devices_public_key_value ON public.temporary_devices USING btree (public_key_value);


--
-- Name: idx_temporary_devices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_devices_status ON public.temporary_devices USING btree (status);


--
-- Name: idx_vaults_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vaults_family_id ON public.vaults USING btree (family_id);


--
-- Name: idx_vaults_identity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vaults_identity_id ON public.vaults USING btree (identity_id);


--
-- Name: message_archive_jobs_active_identity_destination_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX message_archive_jobs_active_identity_destination_idx ON public.message_archive_jobs USING btree (family_id, owner_identity_id, destination_type) WHERE ((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying])::text[]));


--
-- Name: message_archive_jobs_family_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_archive_jobs_family_owner_idx ON public.message_archive_jobs USING btree (family_id, owner_identity_id);


--
-- Name: message_archive_segments_archive_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX message_archive_segments_archive_period_idx ON public.message_archive_segments USING btree (archive_id, period_key);


--
-- Name: message_archive_segments_archive_period_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_archive_segments_archive_period_state_idx ON public.message_archive_segments USING btree (archive_id, period_key, state);


--
-- Name: message_archive_segments_family_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_archive_segments_family_owner_idx ON public.message_archive_segments USING btree (family_id, owner_identity_id);


--
-- Name: messages_content_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_content_updated_idx ON public.messages USING btree (family_id, content_updated_at);


--
-- Name: messages_direct_chat_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_direct_chat_seq_idx ON public.messages USING btree (family_id, direct_chat_id, chat_seq);


--
-- Name: messages_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_idempotency_idx ON public.messages USING btree (family_id, sender_device_id, client_message_id);


--
-- Name: messages_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_recipient_idx ON public.messages USING btree (family_id, recipient_identity_id, created_at);


--
-- Name: messages_sender_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_sender_status_idx ON public.messages USING btree (family_id, sender_identity_id, status_updated_at);


--
-- Name: server_admin_claims_status_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX server_admin_claims_status_expires_idx ON public.server_admin_claims USING btree (status, expires_at);


--
-- Name: server_admins_active_identity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX server_admins_active_identity_idx ON public.server_admins USING btree (principal_identity_id) WHERE (status = 'active'::text);


--
-- Name: system_events_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_events_recipient_idx ON public.system_events USING btree (family_id, recipient_identity_id, created_at);


--
-- Name: tenant_owner_claims_family_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tenant_owner_claims_family_status_idx ON public.tenant_owner_claims USING btree (family_id, status, expires_at);


--
-- Name: uniq_device_notification_bindings_active_web_device; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_device_notification_bindings_active_web_device ON public.device_notification_bindings USING btree (family_id, web_device_id) WHERE ((status)::text = 'active'::text);


--
-- Name: uq_call_whitelist_owner_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_call_whitelist_owner_external ON public.call_whitelist_entries USING btree (family_id, owner_identity_id, external_identity_id);


--
-- Name: call_sessions set_call_session_expiration_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_call_session_expiration_trigger BEFORE INSERT OR UPDATE OF state ON public.call_sessions FOR EACH ROW EXECUTE FUNCTION public.set_call_session_expiration();


--
-- Name: family_config update_family_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_family_config_updated_at BEFORE UPDATE ON public.family_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: push_subscriptions update_push_subscriptions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_push_subscriptions_updated_at BEFORE UPDATE ON public.push_subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: vaults update_vaults_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_vaults_updated_at BEFORE UPDATE ON public.vaults FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: attachment_blobs attachment_blobs_deleted_by_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_blobs
    ADD CONSTRAINT attachment_blobs_deleted_by_identity_id_fkey FOREIGN KEY (deleted_by_identity_id) REFERENCES public.identities(identity_id) ON DELETE SET NULL;


--
-- Name: attachment_blobs attachment_blobs_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_blobs
    ADD CONSTRAINT attachment_blobs_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: attachment_blobs attachment_blobs_sender_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_blobs
    ADD CONSTRAINT attachment_blobs_sender_identity_id_fkey FOREIGN KEY (sender_identity_id) REFERENCES public.identities(identity_id) ON DELETE SET NULL;


--
-- Name: attachment_blobs attachment_blobs_uploader_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_blobs
    ADD CONSTRAINT attachment_blobs_uploader_identity_id_fkey FOREIGN KEY (uploader_identity_id) REFERENCES public.identities(identity_id) ON DELETE RESTRICT;


--
-- Name: attachment_upload_reservations attachment_upload_reservations_blob_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_upload_reservations
    ADD CONSTRAINT attachment_upload_reservations_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES public.attachment_blobs(blob_id) ON DELETE CASCADE;


--
-- Name: attachment_upload_reservations attachment_upload_reservations_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_upload_reservations
    ADD CONSTRAINT attachment_upload_reservations_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: attachment_upload_reservations attachment_upload_reservations_uploader_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_upload_reservations
    ADD CONSTRAINT attachment_upload_reservations_uploader_identity_id_fkey FOREIGN KEY (uploader_identity_id) REFERENCES public.identities(identity_id) ON DELETE RESTRICT;


--
-- Name: call_device_sync call_device_sync_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_device_sync
    ADD CONSTRAINT call_device_sync_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(device_id) ON DELETE CASCADE;


--
-- Name: call_device_sync call_device_sync_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_device_sync
    ADD CONSTRAINT call_device_sync_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: call_client_diagnostics call_client_diagnostics_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_client_diagnostics
    ADD CONSTRAINT call_client_diagnostics_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_logs(call_session_id) ON DELETE CASCADE;



--
-- Name: call_client_diagnostics call_client_diagnostics_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_client_diagnostics
    ADD CONSTRAINT call_client_diagnostics_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;



--
-- Name: call_quality_daily call_quality_daily_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_quality_daily
    ADD CONSTRAINT call_quality_daily_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: call_ice_diagnostics call_ice_diagnostics_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_ice_diagnostics
    ADD CONSTRAINT call_ice_diagnostics_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_logs(call_session_id) ON DELETE CASCADE;


--
-- Name: call_ice_diagnostics call_ice_diagnostics_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_ice_diagnostics
    ADD CONSTRAINT call_ice_diagnostics_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.circle_owner_recovery_claims
    ADD CONSTRAINT circle_owner_recovery_claims_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.circle_owner_changes
    ADD CONSTRAINT circle_owner_changes_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: circle_migrations circle_migrations_family_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_migrations
    ADD CONSTRAINT circle_migrations_family_fk FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: circle_inspector_requests circle_inspector_requests_approved_by_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_requests
    ADD CONSTRAINT circle_inspector_requests_approved_by_device_id_fkey FOREIGN KEY (approved_by_device_id) REFERENCES public.devices(device_id) ON DELETE SET NULL;


--
-- Name: circle_inspector_requests circle_inspector_requests_approved_by_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_requests
    ADD CONSTRAINT circle_inspector_requests_approved_by_identity_id_fkey FOREIGN KEY (approved_by_identity_id) REFERENCES public.identities(identity_id) ON DELETE SET NULL;


--
-- Name: circle_inspector_requests circle_inspector_requests_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_requests
    ADD CONSTRAINT circle_inspector_requests_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: circle_inspector_sessions circle_inspector_sessions_approved_by_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_sessions
    ADD CONSTRAINT circle_inspector_sessions_approved_by_device_id_fkey FOREIGN KEY (approved_by_device_id) REFERENCES public.devices(device_id) ON DELETE SET NULL;


--
-- Name: circle_inspector_sessions circle_inspector_sessions_approved_by_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_sessions
    ADD CONSTRAINT circle_inspector_sessions_approved_by_identity_id_fkey FOREIGN KEY (approved_by_identity_id) REFERENCES public.identities(identity_id) ON DELETE SET NULL;


--
-- Name: circle_inspector_sessions circle_inspector_sessions_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_sessions
    ADD CONSTRAINT circle_inspector_sessions_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: circle_inspector_sessions circle_inspector_sessions_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_sessions
    ADD CONSTRAINT circle_inspector_sessions_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.circle_inspector_requests(request_id) ON DELETE SET NULL;


--
-- Name: circle_inspector_sessions circle_inspector_sessions_revoked_by_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_inspector_sessions
    ADD CONSTRAINT circle_inspector_sessions_revoked_by_identity_id_fkey FOREIGN KEY (revoked_by_identity_id) REFERENCES public.identities(identity_id) ON DELETE SET NULL;


--
-- Name: call_logs call_logs_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
--
-- Name: call_logs call_logs_target_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_target_identity_id_fkey FOREIGN KEY (target_identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


--
-- Name: call_handling_events call_handling_events_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_handling_events
    ADD CONSTRAINT call_handling_events_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_logs(call_session_id) ON DELETE CASCADE;


--
-- Name: call_handling_events call_handling_events_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_handling_events
    ADD CONSTRAINT call_handling_events_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(device_id) ON DELETE CASCADE;


--
-- Name: call_handling_events call_handling_events_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_handling_events
    ADD CONSTRAINT call_handling_events_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: call_handling_events call_handling_events_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_handling_events
    ADD CONSTRAINT call_handling_events_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


--
-- Name: circle_file_access circle_file_access_blob_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_file_access
    ADD CONSTRAINT circle_file_access_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES public.attachment_blobs(blob_id) ON DELETE CASCADE;


--
-- Name: circle_file_access circle_file_access_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_file_access
    ADD CONSTRAINT circle_file_access_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: circle_site_publications fk_circle_site_publications_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_site_publications
    ADD CONSTRAINT fk_circle_site_publications_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: circle_site_publications fk_circle_site_publications_channel; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_site_publications
    ADD CONSTRAINT fk_circle_site_publications_channel FOREIGN KEY (channel_id) REFERENCES public.announcement_channels(channel_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.circle_site_publications
    ADD CONSTRAINT fk_circle_site_publications_source_channel_post FOREIGN KEY (source_channel_post_id) REFERENCES public.announcement_channel_posts(post_id) ON DELETE CASCADE;


--
-- Name: circle_site_publications fk_circle_site_publications_source_link; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_site_publications
    ADD CONSTRAINT fk_circle_site_publications_source_link FOREIGN KEY (source_link_id) REFERENCES public.direct_guest_links(link_id) ON DELETE SET NULL;


--
-- Name: circle_site_settings fk_circle_site_settings_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_site_settings
    ADD CONSTRAINT fk_circle_site_settings_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: circle_media_routing_settings fk_circle_media_routing_settings_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_media_routing_settings
    ADD CONSTRAINT fk_circle_media_routing_settings_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: device_enrollments device_enrollments_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_enrollments
    ADD CONSTRAINT device_enrollments_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: platform_recovery_bindings platform_recovery_bindings_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_recovery_bindings
    ADD CONSTRAINT platform_recovery_bindings_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: call_links fk_call_links_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_links
    ADD CONSTRAINT fk_call_links_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: call_links fk_call_links_direct_guest_link; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_links
    ADD CONSTRAINT fk_call_links_direct_guest_link FOREIGN KEY (direct_guest_link_id) REFERENCES public.direct_guest_links(link_id) ON DELETE SET NULL;


--
-- Name: call_links fk_call_links_join_invite; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_links
    ADD CONSTRAINT fk_call_links_join_invite FOREIGN KEY (join_invite_id) REFERENCES public.invites(invite_id) ON DELETE SET NULL;


--
-- Name: call_links fk_call_links_target_identity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_links
    ADD CONSTRAINT fk_call_links_target_identity FOREIGN KEY (target_identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


--
-- Name: call_sessions fk_call_sessions_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT fk_call_sessions_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: call_whitelist_entries fk_call_whitelist_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_whitelist_entries
    ADD CONSTRAINT fk_call_whitelist_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: call_whitelist_entries fk_call_whitelist_owner_identity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_whitelist_entries
    ADD CONSTRAINT fk_call_whitelist_owner_identity FOREIGN KEY (owner_identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


--
-- Name: devices fk_device_identity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT fk_device_identity FOREIGN KEY (identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


--
-- Name: device_notification_bindings fk_device_notification_bindings_device; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_notification_bindings
    ADD CONSTRAINT fk_device_notification_bindings_device FOREIGN KEY (web_device_id) REFERENCES public.devices(device_id) ON DELETE CASCADE;


--
-- Name: device_notification_bindings fk_device_notification_bindings_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_notification_bindings
    ADD CONSTRAINT fk_device_notification_bindings_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: devices fk_devices_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT fk_devices_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: direct_file_quick_receive_controls direct_file_quick_receive_controls_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_file_quick_receive_controls
    ADD CONSTRAINT direct_file_quick_receive_controls_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: direct_guest_link_defaults fk_direct_guest_link_defaults_family; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_channels
    ADD CONSTRAINT fk_announcement_channels_family FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channels
    ADD CONSTRAINT fk_announcement_channels_owner FOREIGN KEY (owner_identity_id) REFERENCES public.identities(identity_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channels
    ADD CONSTRAINT fk_announcement_channels_public_guest_link FOREIGN KEY (public_site_guest_link_id) REFERENCES public.direct_guest_links(link_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.announcement_channels
    ADD CONSTRAINT fk_announcement_channels_public_requested_by FOREIGN KEY (public_site_requested_by_identity_id) REFERENCES public.identities(identity_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.announcement_channels
    ADD CONSTRAINT fk_announcement_channels_public_approved_by FOREIGN KEY (public_site_approved_by_identity_id) REFERENCES public.identities(identity_id) ON DELETE SET NULL;


ALTER TABLE ONLY public.announcement_channel_links
    ADD CONSTRAINT fk_announcement_channel_links_family FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channel_links
    ADD CONSTRAINT fk_announcement_channel_links_channel FOREIGN KEY (channel_id) REFERENCES public.announcement_channels(channel_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.announcement_channel_links
    ADD CONSTRAINT fk_announcement_channel_links_link FOREIGN KEY (link_id) REFERENCES public.direct_guest_links(link_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channel_subscriptions
    ADD CONSTRAINT fk_announcement_channel_subscriptions_family FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channel_subscriptions
    ADD CONSTRAINT fk_announcement_channel_subscriptions_channel FOREIGN KEY (channel_id) REFERENCES public.announcement_channels(channel_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.announcement_channel_subscriptions
    ADD CONSTRAINT fk_announcement_channel_subscriptions_identity FOREIGN KEY (subscriber_identity_id) REFERENCES public.identities(identity_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.announcement_channel_subscriptions
    ADD CONSTRAINT fk_announcement_channel_subscriptions_removed_by FOREIGN KEY (removed_by_identity_id) REFERENCES public.identities(identity_id) ON DELETE SET NULL;


ALTER TABLE ONLY public.announcement_channel_subscriptions
    ADD CONSTRAINT fk_announcement_channel_subscriptions_source_link FOREIGN KEY (source_link_id) REFERENCES public.direct_guest_links(link_id) ON DELETE SET NULL;


ALTER TABLE ONLY public.announcement_channel_epoch_keys
    ADD CONSTRAINT announcement_channel_epoch_keys_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.announcement_channels(channel_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.announcement_channel_epoch_keys
    ADD CONSTRAINT announcement_channel_epoch_keys_proposer_identity_id_fkey FOREIGN KEY (proposer_identity_id) REFERENCES public.identities(identity_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channel_epoch_keys
    ADD CONSTRAINT announcement_channel_epoch_keys_proposer_device_id_fkey FOREIGN KEY (proposer_device_id) REFERENCES public.devices(device_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channel_key_envelopes
    ADD CONSTRAINT announcement_channel_key_envelopes_epoch_fkey FOREIGN KEY (family_id, channel_id, epoch) REFERENCES public.announcement_channel_epoch_keys(family_id, channel_id, epoch) ON DELETE CASCADE;


ALTER TABLE ONLY public.announcement_channel_key_envelopes
    ADD CONSTRAINT announcement_channel_key_envelopes_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.announcement_channel_key_envelopes
    ADD CONSTRAINT announcement_channel_key_envelopes_publisher_identity_id_fkey FOREIGN KEY (publisher_identity_id) REFERENCES public.identities(identity_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channel_posts
    ADD CONSTRAINT announcement_channel_posts_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.announcement_channels(channel_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.announcement_channel_posts
    ADD CONSTRAINT announcement_channel_posts_author_identity_id_fkey FOREIGN KEY (author_identity_id) REFERENCES public.identities(identity_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channel_posts
    ADD CONSTRAINT announcement_channel_posts_author_device_id_fkey FOREIGN KEY (author_device_id) REFERENCES public.devices(device_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.announcement_channel_push_outbox
    ADD CONSTRAINT announcement_channel_push_outbox_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.announcement_channel_posts(post_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.announcement_channel_push_outbox
    ADD CONSTRAINT announcement_channel_push_outbox_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.announcement_channel_push_outbox
    ADD CONSTRAINT announcement_channel_push_outbox_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.announcement_channels(channel_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.announcement_channel_push_outbox
    ADD CONSTRAINT announcement_channel_push_outbox_author_identity_id_fkey FOREIGN KEY (author_identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.trusted_device_rekey_jobs
    ADD CONSTRAINT trusted_device_rekey_jobs_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.trusted_device_rekey_jobs
    ADD CONSTRAINT trusted_device_rekey_jobs_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.trusted_device_rekey_targets
    ADD CONSTRAINT trusted_device_rekey_targets_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.trusted_device_rekey_jobs(job_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.trusted_device_rekey_targets
    ADD CONSTRAINT trusted_device_rekey_targets_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


ALTER TABLE ONLY public.direct_guest_link_defaults
    ADD CONSTRAINT fk_direct_guest_link_defaults_family FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: direct_guest_links fk_direct_guest_links_family; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_guest_links
    ADD CONSTRAINT fk_direct_guest_links_family FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: direct_guest_registrations fk_direct_guest_registrations_family; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_guest_registrations
    ADD CONSTRAINT fk_direct_guest_registrations_family FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: direct_guest_registrations fk_direct_guest_registrations_link; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_guest_registrations
    ADD CONSTRAINT fk_direct_guest_registrations_link FOREIGN KEY (link_id) REFERENCES public.direct_guest_links(link_id) ON DELETE RESTRICT;


--
-- Name: family_domains fk_family_domains_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_domains
    ADD CONSTRAINT fk_family_domains_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: family_migration_redirects family_migration_redirects_family_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_migration_redirects
    ADD CONSTRAINT family_migration_redirects_family_fk FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: identities fk_identities_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT fk_identities_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: invite_acceptances fk_invite_acceptances_family; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_acceptances
    ADD CONSTRAINT fk_invite_acceptances_family FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: invite_acceptances fk_invite_acceptances_invite; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_acceptances
    ADD CONSTRAINT fk_invite_acceptances_invite FOREIGN KEY (invite_id) REFERENCES public.invites(invite_id) ON DELETE CASCADE;


--
-- Name: invites fk_invites_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT fk_invites_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: push_subscriptions fk_push_subscription_device; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT fk_push_subscription_device FOREIGN KEY (device_id) REFERENCES public.devices(device_id) ON DELETE CASCADE;


--
-- Name: push_subscriptions fk_push_subscriptions_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT fk_push_subscriptions_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: temporary_devices fk_temporary_device_identity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_devices
    ADD CONSTRAINT fk_temporary_device_identity FOREIGN KEY (identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


--
-- Name: temporary_devices fk_temporary_devices_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_devices
    ADD CONSTRAINT fk_temporary_devices_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: tenant_owner_claims fk_tenant_owner_claims_family; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_owner_claims
    ADD CONSTRAINT fk_tenant_owner_claims_family FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: vaults fk_vault_identity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vaults
    ADD CONSTRAINT fk_vault_identity FOREIGN KEY (identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


--
-- Name: vaults fk_vaults_family_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vaults
    ADD CONSTRAINT fk_vaults_family_config FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;


--
-- Name: message_archive_jobs message_archive_jobs_owner_identity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_archive_jobs
    ADD CONSTRAINT message_archive_jobs_owner_identity_fk FOREIGN KEY (owner_identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


--
-- Name: message_archive_jobs message_archive_jobs_writer_device_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_archive_jobs
    ADD CONSTRAINT message_archive_jobs_writer_device_fk FOREIGN KEY (writer_device_id) REFERENCES public.devices(device_id) ON DELETE CASCADE;


--
-- Name: message_archive_segments message_archive_segments_archive_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_archive_segments
    ADD CONSTRAINT message_archive_segments_archive_fk FOREIGN KEY (archive_id) REFERENCES public.message_archive_jobs(archive_id) ON DELETE CASCADE;


--
-- Name: message_archive_segments message_archive_segments_owner_identity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_archive_segments
    ADD CONSTRAINT message_archive_segments_owner_identity_fk FOREIGN KEY (owner_identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;


--
-- Name: message_archive_segments message_archive_segments_writer_device_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_archive_segments
    ADD CONSTRAINT message_archive_segments_writer_device_fk FOREIGN KEY (writer_device_id) REFERENCES public.devices(device_id) ON DELETE CASCADE;


--
-- Name: temporary_access_requests temporary_access_requests_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_access_requests
    ADD CONSTRAINT temporary_access_requests_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;


--
-- Name: temporary_access_requests temporary_access_requests_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_access_requests
    ADD CONSTRAINT temporary_access_requests_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.identities(identity_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.circle_site_publication_assets
    ADD CONSTRAINT circle_site_publication_assets_pkey PRIMARY KEY (asset_id);

ALTER TABLE ONLY public.circle_site_publication_assets
    ADD CONSTRAINT circle_site_publication_assets_storage_key_key UNIQUE (storage_key);

CREATE INDEX idx_circle_site_publication_assets_publication ON public.circle_site_publication_assets USING btree (family_id, publication_id);
CREATE INDEX idx_circle_site_publication_assets_channel_post ON public.circle_site_publication_assets USING btree (family_id, source_channel_post_id);
CREATE INDEX idx_circle_site_publication_assets_site_image ON public.circle_site_publication_assets USING btree (family_id, site_image_slot, site_image_channel_id, status);
CREATE INDEX idx_circle_site_publication_assets_status ON public.circle_site_publication_assets USING btree (family_id, status);

ALTER TABLE ONLY public.circle_site_publication_assets
    ADD CONSTRAINT fk_circle_site_publication_assets_family FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.circle_site_publication_assets
    ADD CONSTRAINT fk_circle_site_publication_assets_publication FOREIGN KEY (publication_id) REFERENCES public.circle_site_publications(publication_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.circle_site_publication_assets
    ADD CONSTRAINT fk_circle_site_publication_assets_channel_post FOREIGN KEY (source_channel_post_id) REFERENCES public.announcement_channel_posts(post_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.circle_site_publication_assets
    ADD CONSTRAINT fk_circle_site_publication_assets_site_image_channel FOREIGN KEY (site_image_channel_id) REFERENCES public.announcement_channels(channel_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.circle_site_publication_assets
    ADD CONSTRAINT fk_circle_site_publication_assets_uploader FOREIGN KEY (uploader_identity_id) REFERENCES public.identities(identity_id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

-- Deferred until referenced tables and unique constraints exist.
ALTER TABLE ONLY public.circle_membership_states ADD CONSTRAINT circle_membership_states_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.circle_profile_epochs ADD CONSTRAINT circle_profile_epochs_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.circle_profile_epoch_envelopes ADD CONSTRAINT circle_profile_epoch_envelopes_epoch_fkey FOREIGN KEY (family_id, epoch) REFERENCES public.circle_profile_epochs(family_id, epoch) ON DELETE CASCADE;
ALTER TABLE ONLY public.circle_profile_epoch_envelopes ADD CONSTRAINT circle_profile_epoch_envelopes_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.circle_encrypted_identity_profiles ADD CONSTRAINT circle_encrypted_identity_profiles_epoch_fkey FOREIGN KEY (family_id, epoch) REFERENCES public.circle_profile_epochs(family_id, epoch) ON DELETE RESTRICT;
ALTER TABLE ONLY public.circle_encrypted_identity_profiles ADD CONSTRAINT circle_encrypted_identity_profiles_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.family_config(family_id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.circle_migration_events ADD CONSTRAINT circle_migration_events_slot_fk FOREIGN KEY (migration_slot_id) REFERENCES public.migration_slots(migration_slot_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.circle_migration_events ADD CONSTRAINT circle_migration_events_source_fk FOREIGN KEY (migration_id) REFERENCES public.circle_migrations(migration_id) ON DELETE CASCADE;

-- Durable request reliability (pre-public migration 151).
CREATE TABLE public.signed_request_nonces (
  signer_hash text NOT NULL,
  nonce_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (signer_hash, nonce_hash)
);
CREATE INDEX signed_request_nonces_expiry ON public.signed_request_nonces (expires_at);
CREATE TABLE public.signed_operation_results (
  family_id text NOT NULL,
  signer_id text NOT NULL,
  operation_type text NOT NULL,
  operation_hash text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, signer_id, operation_type, operation_hash)
);
CREATE TABLE public.signed_resource_versions (
  family_id text NOT NULL,
  resource_key text NOT NULL,
  version_id text COLLATE "C" NOT NULL,
  PRIMARY KEY (family_id, resource_key)
);
CREATE INDEX signed_operation_results_response_expiry
  ON public.signed_operation_results (created_at) WHERE response IS NOT NULL;
-- Deleted message IDs remain tombstones, so old sends cannot recreate history.
CREATE TABLE public.message_send_receipts (
  family_id text NOT NULL,
  scope text NOT NULL,
  device_id text NOT NULL,
  client_message_id text NOT NULL,
  message_id text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (family_id, scope, device_id, client_message_id)
);

-- Access revision tracking (pre-public migration 152).
-- Every writer (including membership projection, cleanup, CLI and recovery claims)
-- invalidates old access intents. No user data is rewritten or deleted.
CREATE FUNCTION public.bump_access_resource_version(scope_id text, parts text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE resource_id text := 'access:' || array_to_json(parts)::text;
BEGIN
  -- Must match reliableOperation's JSON.stringify([scope, resource]) lock key.
  PERFORM pg_advisory_xact_lock(hashtext(array_to_json(ARRAY[scope_id,resource_id])::text));
  INSERT INTO public.signed_resource_versions(family_id,resource_key,version_id)
    VALUES(scope_id,resource_id,public.uuid_generate_v4()::text)
    ON CONFLICT(family_id,resource_key) DO UPDATE SET version_id=EXCLUDED.version_id;
END;
$$;

CREATE FUNCTION public.track_access_resource_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_data jsonb; new_data jsonb; item jsonb; field_name text; changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_data := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_data := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    FOREACH field_name IN ARRAY TG_ARGV LOOP
      IF old_data->field_name IS DISTINCT FROM new_data->field_name THEN changed := true; EXIT; END IF;
    END LOOP;
    IF NOT changed THEN RETURN NULL; END IF;
  END IF;
  -- Invalidate both old and new scopes if a migration changes an object's keys.
  FOR item IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(old_data,new_data)) WHERE value <> 'null'::jsonb LOOP
    CASE TG_TABLE_NAME
    WHEN 'identities' THEN
      PERFORM public.bump_access_resource_version(item->>'family_id',ARRAY['user-access',item->>'identity_id']);
    WHEN 'platform_recovery_bindings' THEN
      PERFORM public.bump_access_resource_version(item->>'family_id',ARRAY['recovery',item->>'identity_id',item->>'recovery_slot']);
    WHEN 'call_whitelist_entries' THEN
      PERFORM public.bump_access_resource_version(item->>'family_id',ARRAY['whitelist',item->>'owner_identity_id',item->>'external_identity_id']);
    WHEN 'direct_guest_registrations' THEN
      PERFORM public.bump_access_resource_version(item->>'family_id',ARRAY['guest-access',item->>'host_identity_id',item->>'registration_id']);
    WHEN 'server_admins' THEN
      PERFORM public.bump_access_resource_version('@server-access',ARRAY['server-admins']);
    WHEN 'family_config' THEN
      PERFORM public.bump_access_resource_version('@server-access',ARRAY['tenant-status',item->>'family_id']);
    WHEN 'announcement_channels', 'announcement_channel_subscriptions' THEN
      PERFORM public.bump_access_resource_version(item->>'family_id',ARRAY['channel-access',item->>'channel_id']);
    END CASE;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER track_access_version AFTER INSERT OR UPDATE OR DELETE ON public.identities
  FOR EACH ROW EXECUTE FUNCTION public.track_access_resource_version('family_id','identity_id','status','role','can_create_invites','invite_quota');
CREATE TRIGGER track_access_version AFTER INSERT OR UPDATE OR DELETE ON public.platform_recovery_bindings
  FOR EACH ROW EXECUTE FUNCTION public.track_access_resource_version('family_id','identity_id','recovery_slot','status','binding');
CREATE TRIGGER track_access_version AFTER INSERT OR UPDATE OR DELETE ON public.call_whitelist_entries
  FOR EACH ROW EXECUTE FUNCTION public.track_access_resource_version('family_id','owner_identity_id','external_identity_id','status','external_public_key_algorithm','external_public_key_value');
CREATE TRIGGER track_access_version AFTER INSERT OR UPDATE OR DELETE ON public.direct_guest_registrations
  FOR EACH ROW EXECUTE FUNCTION public.track_access_resource_version('family_id','host_identity_id','registration_id','status','can_message','can_call','can_direct_file_transfer','can_server_attachments','host_can_message_guest','guest_can_message_host','host_can_call_guest','guest_can_call_host','host_can_direct_file_transfer_guest','guest_can_direct_file_transfer_host','host_can_server_attachments_guest','guest_can_server_attachments_host');
CREATE TRIGGER track_access_version AFTER INSERT OR UPDATE OR DELETE ON public.server_admins
  FOR EACH ROW EXECUTE FUNCTION public.track_access_resource_version('principal_identity_id','status');
CREATE TRIGGER track_access_version AFTER INSERT OR UPDATE OR DELETE ON public.family_config
  FOR EACH ROW EXECUTE FUNCTION public.track_access_resource_version('family_id','status');
CREATE TRIGGER track_access_version AFTER INSERT OR UPDATE OR DELETE ON public.announcement_channels
  FOR EACH ROW EXECUTE FUNCTION public.track_access_resource_version('family_id','channel_id','status','owner_identity_id','visibility','members_can_subscribe','owner_guests_can_subscribe','other_guests_can_subscribe','content_mode','disclose_server_admin_status','public_site_state','public_site_visible','public_site_guest_link_id');
CREATE TRIGGER track_access_version AFTER INSERT OR UPDATE OR DELETE ON public.announcement_channel_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.track_access_resource_version('family_id','channel_id','subscriber_identity_id','status','source_link_id');
CREATE TABLE public.message_reaction_states (
  family_id UUID NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('direct', 'group')),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  claim JSONB NOT NULL,
  direct_message_id TEXT REFERENCES public.messages(server_message_id) ON DELETE CASCADE,
  group_message_id TEXT REFERENCES public.group_chat_messages(message_id) ON DELETE CASCADE,
  PRIMARY KEY (family_id, scope, chat_id, message_id, actor_identity_id),
  CHECK ((scope = 'direct' AND direct_message_id = message_id AND direct_message_id IS NOT NULL AND group_message_id IS NULL)
      OR (scope = 'group' AND group_message_id = message_id AND group_message_id IS NOT NULL AND direct_message_id IS NULL))
);

CREATE INDEX message_reaction_direct_target ON public.message_reaction_states (direct_message_id) WHERE direct_message_id IS NOT NULL;
CREATE INDEX message_reaction_group_target ON public.message_reaction_states (group_message_id) WHERE group_message_id IS NOT NULL;

-- Channel reactions
ALTER TABLE public.announcement_channels ADD COLUMN reactions_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE public.announcement_channel_reactions (
  family_id UUID NOT NULL,
  channel_id TEXT NOT NULL REFERENCES public.announcement_channels(channel_id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES public.announcement_channel_posts(post_id) ON DELETE CASCADE,
  actor_identity_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  emojis TEXT[] NOT NULL CHECK (cardinality(emojis) <= 12),
  PRIMARY KEY (family_id, channel_id, post_id, actor_identity_id)
);
