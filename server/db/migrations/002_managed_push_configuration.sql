-- Add a managed Notification Central connection. The encrypted secret can
-- only be decrypted with the deployment key stored outside PostgreSQL.
CREATE TABLE managed_push_configuration (
  singleton_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  state TEXT NOT NULL CHECK (state IN ('configured', 'disabled')),
  service_url TEXT,
  client_id TEXT,
  key_id TEXT,
  encrypted_shared_secret JSONB,
  config_fingerprint TEXT,
  provision_request_id TEXT,
  installed_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (state = 'configured' AND service_url IS NOT NULL AND client_id IS NOT NULL
      AND key_id IS NOT NULL AND encrypted_shared_secret IS NOT NULL
      AND config_fingerprint IS NOT NULL AND installed_at IS NOT NULL)
    OR
    (state = 'disabled' AND service_url IS NULL AND client_id IS NULL
      AND key_id IS NULL AND encrypted_shared_secret IS NULL)
  )
);

CREATE TABLE managed_push_install_claims (
  claim_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired', 'revoked')),
  server_url TEXT NOT NULL,
  created_by_server_admin_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  provision_request_id TEXT,
  install_fingerprint TEXT
);

CREATE INDEX managed_push_install_claims_pending_expires_idx
  ON managed_push_install_claims (expires_at)
  WHERE status = 'pending';
