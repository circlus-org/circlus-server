-- Owner-signed membership snapshot: summarises the chain history before it.
ALTER TABLE circle_membership_states
  DROP CONSTRAINT IF EXISTS circle_membership_states_action_check;

ALTER TABLE circle_membership_states
  ADD CONSTRAINT circle_membership_states_action_check
  CHECK (action IN (
    'genesis',
    'repair',
    'add',
    'remove',
    'restore',
    'transfer_owner',
    'set_invite_permission',
    'snapshot'
  ));
