/** Operations whose requests must keep an operationId across transport retries. */
export const RELIABLE_OPERATION_TYPES: readonly string[] = [
  'temporary-access:trusted:approve', 'temporary-access:renewal:approve',
  'temporary-access:trusted:request', 'temporary-access:renewal:request', 'temporary-access:trusted:grant',
  'announcement-channels:reactions:settings', 'announcement-channels:create', 'attachments:reserve',
  'circle-site:site-images:reservations:create', 'circle-site:assets:reservations:create',
  'direct-guest-links:presentation-image', 'call:handling-event',
  'server-admin:tenant:reissue-owner-claim',
  'invites:create', 'call-links:create', 'direct-guest-links:create',
  'platform-recovery:bind-device', 'platform-recovery:revoke-device',
  'mobile:device:delivery-token:register', 'mobile:device:delivery-token:unregister',
  'archive:job:manifest', 'archive:segments:put', 'archive:segments:finalize',
  'vault:set', 'push:subscribe', 'push:unsubscribe', 'backup:set'
];
