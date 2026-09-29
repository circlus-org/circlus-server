-- A recipient-authored read proof survives offline status synchronization.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_proof jsonb;
