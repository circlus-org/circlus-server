-- Durable route-specific admission/cancellation. No FK to ephemeral call_sessions:
-- a cancellation may commit before that row exists or outlive its cleanup.
CREATE TABLE call_admission_journal (
  family_id uuid NOT NULL REFERENCES family_config(family_id) ON DELETE CASCADE,
  call_session_id text NOT NULL,
  initiator_identity_id text NOT NULL,
  initiator_device_id text NOT NULL,
  target_identity_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('offered', 'cancelled')),
  terminal_action_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  PRIMARY KEY (family_id, call_session_id, initiator_identity_id, initiator_device_id, target_identity_id),
  CHECK ((phase = 'cancelled') = (cancelled_at IS NOT NULL))
);
