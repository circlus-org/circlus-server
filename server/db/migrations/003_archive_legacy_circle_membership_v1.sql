-- Retain the original signed V1 genesis after the owner replaces the active
-- membership chain with a clean, owner-only V2 genesis.

CREATE TABLE IF NOT EXISTS circle_membership_v1_recovery_archive (
  family_id UUID PRIMARY KEY REFERENCES family_config(family_id) ON DELETE RESTRICT,
  legacy_state_id TEXT NOT NULL,
  legacy_claim JSONB NOT NULL,
  legacy_admission JSONB,
  replacement_state_id TEXT NOT NULL,
  replacement_claim JSONB NOT NULL,
  recovered_by_identity_id TEXT NOT NULL,
  recovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
