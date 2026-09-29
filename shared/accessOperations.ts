/** Reversible access mutations requiring a server-issued version and stable intent. */
export const ACCESS_OPERATION_PATHS: Readonly<Record<string, string>> = {
  'announcement-channels:subscribe': '/announcement-channels/:channelId/subscribe',
  'announcement-channels:unsubscribe': '/announcement-channels/:channelId/unsubscribe',
  'announcement-channels:recipient:remove': '/announcement-channels/:channelId/recipients/:subscriberIdentityId/remove',
  'announcement-channels:recipient:restore': '/announcement-channels/:channelId/recipients/:subscriberIdentityId/restore',
  'announcement-channels:public-site': '/announcement-channels/:channelId/public-site',
  'announcement-channels:server-admin-disclosure': '/announcement-channels/:channelId/server-admin-disclosure',
  'platform-recovery:bind-device': '/device-enrollments/platform-recovery/bind',
  'platform-recovery:revoke-device': '/device-enrollments/platform-recovery/revoke',
  'call-admission:whitelist:add': '/call-admission/whitelist/add',
  'call-admission:whitelist:remove': '/call-admission/whitelist/remove',
  'admin:user:invite-permission': '/admin/users/:identityId/invite-permission',
  'admin:user:guest-invite-permission': '/admin/users/:identityId/guest-invite-permission',
  'admin:user:disable': '/admin/users/:identityId/disable',
  'admin:user:enable': '/admin/users/:identityId/enable',
  'direct-guest-registrations:permissions:update': '/direct-guest-links/registrations/:registrationId/permissions/update',
  'direct-guest-registrations:chat-offer': '/direct-guest-links/registrations/:registrationId/chat-offer',
  'direct-guest-registrations:chat-end': '/direct-guest-links/registrations/:registrationId/chat-end',
  'direct-guest-chat-offers:accept': '/direct-guest-links/chat-offers/:eventId/accept',
  'direct-guest-chat-offers:decline': '/direct-guest-links/chat-offers/:eventId/decline',
  'direct-guest-registrations:revoke': '/direct-guest-links/registrations/:registrationId/revoke',
  'direct-guest-registrations:delete': '/direct-guest-links/registrations/:registrationId/delete',
  'server-admin:admins:grant': '/server-admin/admins/grant',
  'server-admin:admins:revoke': '/server-admin/admins/:serverAdminId/revoke',
  'server-admin:tenant:suspend': '/server-admin/tenants/:familyId/suspend',
  'server-admin:tenant:resume': '/server-admin/tenants/:familyId/resume'
};

/** Resolve identically for version reads and mutations; never accept an arbitrary resource key. */
export function accessResource(type: string, path: string, payload: any, identityId: string): string {
  const template = ACCESS_OPERATION_PATHS[type];
  if (!template || typeof path !== 'string') throw new Error('Unknown access operation');
  const actual = path.split('/');
  const expected = template.split('/');
  if (actual.length !== expected.length) throw new Error('Access operation path mismatch');
  const params: Record<string, string> = {};
  expected.forEach((part, index) => {
    if (part.startsWith(':')) {
      const value = decodeURIComponent(actual[index]);
      if (!value || value.length > 512 || /[/?#]/.test(value)) throw new Error('Invalid access target');
      params[part.slice(1)] = value;
    } else if (part !== actual[index]) throw new Error('Access operation path mismatch');
  });
  const field = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('Missing access target');
    return value.trim();
  };
  let key: string[];
  if (type.startsWith('announcement-channels:')) {
    key = ['channel-access', params.channelId];
  } else if (type.startsWith('platform-recovery:')) {
    const slot = type === 'platform-recovery:bind-device'
      ? payload?.binding?.payload?.recoverySlot
      : payload?.revocation?.payload?.recoverySlot;
    key = ['recovery', identityId, field(slot)];
  } else if (type.startsWith('call-admission:')) {
    key = ['whitelist', identityId, field(payload?.externalIdentityId)];
  } else if (type.startsWith('admin:user:')) {
    key = ['user-access', params.identityId];
  } else if (type.startsWith('direct-guest-registrations:')) {
    key = ['guest-access', identityId, params.registrationId];
  } else if (type.startsWith('direct-guest-chat-offers:')) {
    key = ['guest-chat-offer', identityId, params.eventId];
  } else if (type.startsWith('server-admin:admins:')) {
    // Grant targets identity, revoke targets grant ID. One registry version covers both,
    // including requests sent by administrators from different carrier Circles.
    key = ['server-admins'];
  } else {
    key = ['tenant-status', params.familyId];
  }
  return 'access:' + JSON.stringify(key);
}
export const accessScope = (type: string, familyId: string): string =>
  type.startsWith('server-admin:') ? '@server-access' : familyId;
