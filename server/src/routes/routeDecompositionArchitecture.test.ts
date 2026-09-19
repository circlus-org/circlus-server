import fs from 'fs';
import path from 'path';

const routesDir = __dirname;

function source(fileName: string): string {
  return fs.readFileSync(path.join(routesDir, fileName), 'utf8');
}

describe('large route modules stay decomposed by responsibility', () => {
  const modules = [
    {
      parent: 'auth.ts',
      child: 'authIdentityRegistrationRoutes.ts',
      mount: 'authIdentityRegistrationRoutes',
      paths: ['/check-invite', '/register-owner', '/register']
    },
    {
      parent: 'auth.ts',
      child: 'authDeviceRegistrationRoutes.ts',
      mount: 'authDeviceRegistrationRoutes',
      paths: ['/register-device']
    },
    {
      parent: 'auth.ts',
      child: 'authIdentityLookupRoutes.ts',
      mount: 'authIdentityLookupRoutes',
      paths: ['/identity/encrypted-key', '/identity/lookup']
    },
    {
      parent: 'admin.ts',
      child: 'adminConfigRoutes.ts',
      mount: 'adminConfigRoutes',
      paths: ['/health', '/family-config', '/family-config/upsert']
    },
    {
      parent: 'admin.ts',
      child: 'adminUserRoutes.ts',
      mount: 'adminUserRoutes',
      paths: [
        '/users',
        '/owner/transfer',
        '/users/:identityId/role',
        '/users/:identityId/invite-permission',
        '/users/:identityId/disable',
        '/users/:identityId/enable',
        '/users/:identityId/devices',
        '/devices/:deviceId/revoke'
      ]
    },
    {
      parent: 'admin.ts',
      child: 'adminInviteRoutes.ts',
      mount: 'adminInviteRoutes',
      paths: ['/invites', '/invites/:inviteId/revoke']
    },
    {
      parent: 'announcementChannels.ts',
      child: 'announcementChannelKeyRoutes.ts',
      mount: 'announcementChannelKeyRoutes',
      paths: [
        '/:channelId/keys/claim',
        '/:channelId/keys/publish',
        '/:channelId/keys/missing',
        '/:channelId/keys/rotate',
        '/:channelId/keys/fetch'
      ]
    },
    {
      parent: 'announcementChannels.ts',
      child: 'announcementChannelPostRoutes.ts',
      mount: 'announcementChannelPostRoutes',
      paths: [
        '/:channelId/posts/create',
        '/:channelId/posts/:postId/edit',
        '/:channelId/posts/list',
        '/:channelId/read',
        '/:channelId/received',
        '/:channelId/posts/:postId/engagement'
      ]
    },
    {
      parent: 'announcementChannels.ts',
      child: 'announcementChannelSubscriptionRoutes.ts',
      mount: 'announcementChannelSubscriptionRoutes',
      paths: [
        '/:channelId/subscribe',
        '/:channelId/unsubscribe',
        '/:channelId/notifications',
        '/:channelId/recipients',
        '/:channelId/removed-recipients',
        '/:channelId/recipients/:subscriberIdentityId/remove',
        '/:channelId/recipients/:subscriberIdentityId/restore'
      ]
    },
    {
      parent: 'serverAdmin.ts',
      child: 'serverAdminAccessRoutes.ts',
      mount: 'serverAdminAccessRoutes',
      paths: [
        '/status',
        '/claims/redeem',
        '/admins/list',
        '/admins/candidates',
        '/admins/grant',
        '/admins/:serverAdminId/rename',
        '/admins/:serverAdminId/revoke'
      ]
    },
    {
      parent: 'deviceEnrollments.ts',
      child: 'deviceEnrollmentBootstrapRoutes.ts',
      mount: 'deviceEnrollmentBootstrapRoutes',
      paths: ['/', '/reserve', '/:enrollmentId/validate-recovery']
    },
    {
      parent: 'deviceEnrollments.ts',
      child: 'deviceEnrollmentApprovalRoutes.ts',
      mount: 'deviceEnrollmentApprovalRoutes',
      paths: ['/:enrollmentId/read-request', '/:enrollmentId/complete']
    },
    {
      parent: 'deviceEnrollments.ts',
      child: 'deviceEnrollmentActivationRoutes.ts',
      mount: 'deviceEnrollmentActivationRoutes',
      paths: ['/:enrollmentId/payload', '/:enrollmentId/activate', '/:enrollmentId/recover']
    },
    {
      parent: 'deviceEnrollments.ts',
      child: 'deviceEnrollmentStatusRoutes.ts',
      mount: 'deviceEnrollmentStatusRoutes',
      paths: ['/:enrollmentId/status', '/:enrollmentId/reject']
    },
    {
      parent: 'temporaryAccess.ts',
      child: 'temporaryAccessChatKeyRoutes.ts',
      mount: 'temporaryAccessChatKeyRoutes',
      paths: ['/chat-keys', '/chat-keys/approved-devices', '/chat-keys/update']
    },
    {
      parent: 'directGuestLinks.ts',
      child: 'directGuestRegistrationRoutes.ts',
      mount: 'directGuestRegistrationRoutes',
      paths: [
        '/registrations/mine',
        '/:linkId/registrations',
        '/registrations/:registrationId/revoke',
        '/registrations/:registrationId/revoke-impact',
        '/registrations/:registrationId/delete',
        '/registrations/:registrationId/permissions/update',
        '/registrations/self-delete'
      ]
    }
  ] as const;

  test.each(modules)('$parent mounts $child and does not reclaim its endpoints', ({ parent, child, mount, paths }) => {
    const parentSource = source(parent);
    const childSource = source(child);

    expect(parentSource).toContain(`router.use(${mount})`);
    for (const routePath of paths) {
      expect(childSource).toContain(`'${routePath}'`);
      expect(parentSource).not.toContain(`'${routePath}'`);
    }
  });

  test('shared access policy helpers stay outside parent routers', () => {
    expect(source('temporaryAccess.ts')).not.toContain('function getTrustedDeviceContext');
    expect(source('directGuestLinks.ts')).not.toContain('function requireGuestLinkManagementAccess');
  });

  test('device enrollment approval persistence stays in the domain service', () => {
    const approvalRoutes = source('deviceEnrollmentApprovalRoutes.ts');
    expect(approvalRoutes).toContain('approveDeviceEnrollment');
    expect(approvalRoutes).not.toContain("from '../db'");
    expect(source('deviceEnrollments.ts')).not.toContain('router.post');
  });

  test('auth and admin parents stay composition-only', () => {
    expect(source('auth.ts')).not.toContain('router.post');
    expect(source('admin.ts')).not.toMatch(/router\.(post|put|delete|get)/);
  });

  test('device mutations keep atomic rekey workflows outside HTTP handlers', () => {
    const deviceRegistrationRoutes = source('authDeviceRegistrationRoutes.ts');
    const adminUserRoutes = source('adminUserRoutes.ts');
    const deviceRoutes = source('devices.ts');

    expect(deviceRegistrationRoutes).toContain('registerIdentityDevice');
    expect(deviceRegistrationRoutes).not.toContain('transaction(');
    expect(adminUserRoutes).toContain('revokeDeviceAsAdmin');
    expect(adminUserRoutes).not.toContain('transaction(');
    expect(deviceRoutes).toContain('revokeIdentityDevice');
    expect(deviceRoutes).not.toContain('transaction(');
  });

  test('direct guest registration revocation transaction stays outside HTTP handlers', () => {
    const registrationRoutes = source('directGuestRegistrationRoutes.ts');
    expect(registrationRoutes).toContain('revokeDirectGuestRegistration');
    expect(registrationRoutes).not.toContain('transaction(');
  });

  test('direct guest link mutation transactions stay outside HTTP handlers', () => {
    const linkRoutes = source('directGuestLinks.ts');
    expect(linkRoutes).toContain('createDirectGuestLink');
    expect(linkRoutes).toContain('revokeDirectGuestLink');
    expect(linkRoutes).not.toContain('transaction(');
  });

  test('key persistence transactions stay outside HTTP handlers', () => {
    const keyRoutes = [
      ['messages.ts', 'claimAndPublishDirectEpochKey'],
      ['groupChatKeyRoutes.ts', 'claimAndPublishGroupChatEpochKey'],
      ['temporaryAccessChatKeyRoutes.ts', 'storeTemporaryDeviceChatKeyEnvelopes'],
      ['announcementChannelKeyRoutes.ts', 'claimAndPublishAnnouncementChannelEpochKey']
    ] as const;
    for (const [fileName, serviceCall] of keyRoutes) {
      const routeSource = source(fileName);
      expect(routeSource).toContain(serviceCall);
      expect(routeSource).not.toContain('transaction(');
    }
  });

  test('group chat membership state transitions stay outside HTTP handlers', () => {
    const membershipRoutes = source('groupChatMembershipRoutes.ts');
    for (const serviceCall of [
      'addGroupChatParticipants',
      'removeGroupChatParticipant',
      'transferGroupChatOwnership',
      'leaveGroupChat'
    ]) {
      expect(membershipRoutes).toContain(serviceCall);
    }
    expect(membershipRoutes).not.toContain('transaction(');
    expect(membershipRoutes).not.toContain('buildSystemMessageRecord');
    expect(membershipRoutes).not.toContain('fanoutGroupChatEvent');
  });

  test('member identity creation and invite consumption share one service transaction', () => {
    const registrationRoutes = source('authIdentityRegistrationRoutes.ts');
    expect(registrationRoutes).toContain('registerMemberIdentity');
    expect(registrationRoutes).toContain('registerOwnerIdentity');
    expect(registrationRoutes).not.toContain('transaction(');
    expect(registrationRoutes).not.toContain('identityRepository.create');
    expect(registrationRoutes).not.toContain('useInvite(');
  });

  test('small auth/admin modules use the shared API error serializer', () => {
    for (const fileName of ['authIdentityLookupRoutes.ts', 'adminInviteRoutes.ts']) {
      const moduleSource = source(fileName);
      expect(moduleSource).toContain('sendApiError');
      expect(moduleSource).not.toContain("status: 'error'");
    }
  });

  test('every admin endpoint retains signature, identity, and admin middleware', () => {
    const adminSources = [
      source('adminConfigRoutes.ts'),
      source('adminUserRoutes.ts'),
      source('adminInviteRoutes.ts'),
      source('adminMediaRoutingRoutes.ts')
    ];
    const routeStarts = adminSources.flatMap((adminSource) => (
      [...adminSource.matchAll(/router\.(?:post|put)\(/g)].map((match) => ({
        source: adminSource,
        index: match.index
      }))
    ));

    expect(routeStarts).toHaveLength(20);
    for (const routeStart of routeStarts) {
      const handlerStart = routeStart.source.indexOf('async (req:', routeStart.index);
      const middlewareChain = routeStart.source.slice(routeStart.index, handlerStart);
      expect(middlewareChain).toContain('verifySignature');
      expect(middlewareChain).toContain('requireActiveIdentity');
      expect(middlewareChain).toContain('requireAdmin');
    }
  });
});

describe('HTTP boundary typing', () => {
  test('production route and auth contracts do not use explicit any', () => {
    const productionRouteSources = fs.readdirSync(routesDir)
      .filter((fileName) => fileName.endsWith('.ts') && !fileName.endsWith('.test.ts'))
      .map((fileName) => source(fileName));
    const authSource = fs.readFileSync(path.join(routesDir, '..', 'middleware', 'auth.ts'), 'utf8');
    const combined = [...productionRouteSources, authSource].join('\n');

    expect(combined).not.toMatch(/AuthRequest<any>/);
    expect(combined).not.toMatch(/\bres:\s*any\b/);
  });
});
